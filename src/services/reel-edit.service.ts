import { createHash, randomUUID } from "node:crypto";
import {
  Reel,
  FacebookPage,
  InstagramChannel,
  ThreadsChannel,
  YouTubeChannel,
  type IReel,
  type IScene,
  type ICaptionStyle,
  type IAudioPost,
  type IEditEffects,
  type ISceneMotion,
  type ReelMotionMode,
  type IRedditStoryPayload,
  type IUpdateDiscoveryPayload,
  type IReelDestination,
  type IOutroSettings,
  type StorySource,
} from "../models";
import { mergeCaptionStyle } from "../utils/caption-style.utils";
import { enqueueReelPlan, enqueueReelProduce, removeReelJob } from "../queue/queues";
import {
  syncRedditBodyFromScenes,
  redditPayloadFromStoryDraft,
  redditPayloadFromStoryPart,
  listReelsBySeries,
  deleteReel,
  deleteSeriesPart,
  collectReelS3AssetUrls,
  cleanupReelLocalStaging,
} from "./reel.service";
import { assertFfmpegReady } from "./ffmpeg-capability.service";
import { snapshotCreatorShortsCover, refreshAutomaticOpeningCoverIfStale } from "./reel-shorts-cover.service";
import { deleteS3Urls } from "./s3.service";
import {
  generateStorySeries,
  loadAndReserveBankStory,
  markStoryReel,
  materializeFromSeed,
  fetchPostByUrl,
  parseRedditPostId,
  combinePostWithContinuations,
  selectVerbatimCuts,
  splitSentencesForReelParts,
  resolvePartCount,
  cleanRedditBody,
  wordCount,
  titleWithPart,
  assessVerbatimSeriesStructureWithAi,
  type SeriesStructureAdvice,
  type StoryPartDraft,
  type RedditPost,
} from "./story.service";
import {
  discoverStoryUpdates,
  resolveManualUpdates,
  updatesToContinuations,
  includedUpdateKeys,
  type UpdateDiscovery,
  type UpdateCandidate,
  type UpdateSignal,
} from "./reddit-update-discovery.service";
import { applyMeasuredCostsToReel, type MeasuredCostInput } from "./reel-cost.service";
import { recordOperationLog } from "./operation-log.service";
import {
  invalidateFinalDestinationRenders,
  resolveReelDestinations,
} from "./reel-outro.service";
import type { Tier } from "../config/models";

// ============================================
// Studio editing — human-in-the-loop scene/settings/caption edits + surgical
// regeneration. Clearing a scene's assetUrl/audioUrl (via $unset so it's truly
// removed from Mongo, not left stale) makes the produce stage regenerate ONLY
// that piece; leaving assets intact makes a re-render reuse everything (free
// for parallax/ken_burns). See reel.service.produceImageReel.
// ============================================

const ACTIVE_STATUSES: IReel["status"][] = [
  "planning",
  "generating_assets",
  "generating_audio",
  "aligning",
  "rendering",
  "uploading",
];

const INSTAGRAM_CAPTION_MAX_HASHTAGS = 5;

function instagramCaptionHashtagCount(caption: string): number {
  return (caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
}

function assertEditable(reel: IReel): void {
  if (ACTIVE_STATUSES.includes(reel.status)) {
    throw new Error(`Cannot edit while generation is active (status: ${reel.status})`);
  }
  if (reel.voiceVariants?.some((v) => v.status === "pending")) {
    throw new Error("Cannot edit while a revoice job is still rendering");
  }
  const yt = reel.youtube?.status;
  if (yt === "pending" || yt === "uploading") {
    throw new Error("Cannot edit while a YouTube publish job is in progress");
  }
}

async function loadReel(reelId: string): Promise<IReel> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  return reel;
}

function sceneImageUrls(reel: IReel): (string | undefined)[] {
  return reel.scenes.map((scene) => scene.assetUrl);
}

function sceneAudioUrls(reel: IReel): (string | undefined)[] {
  return reel.scenes.map((scene) => scene.audioUrl);
}

/** Clear cached render artifacts that are invalidated by body/composite changes. */
async function clearBodyVideoCache(reel: IReel): Promise<void> {
  const stale = [
    reel.bodyVideoUrl,
    ...invalidateFinalDestinationRenders(reel, {
      reason: "The shared body video was invalidated",
    }),
  ];
  await reel.save();
  await Reel.updateOne({ _id: reel._id }, { $unset: { bodyVideoUrl: "" } });
  await deleteS3Urls(stale);
}

/** Clear pre-caption assembly (scene/stills/audio/motion changes). */
async function clearAssemblyCache(reel: IReel): Promise<void> {
  const stale = [
    reel.assemblyVideoUrl,
    reel.bodyVideoUrl,
    ...invalidateFinalDestinationRenders(reel, {
      reason: "The shared assembly and body video were invalidated",
    }),
  ];
  await reel.save();
  await Reel.updateOne({ _id: reel._id }, { $unset: { assemblyVideoUrl: "", bodyVideoUrl: "" } });
  await deleteS3Urls(stale);
}

/** Clear all gameplay narration + outro caches (voice change / full assets regen). */
async function clearNarrationCaches(reel: IReel): Promise<void> {
  const stale = [
    reel.titleAudioUrl,
    reel.partOutroAudioUrl,
    reel.outroAudioUrl,
    reel.bodyVideoUrl,
    reel.assemblyVideoUrl,
    ...sceneAudioUrls(reel),
    ...invalidateFinalDestinationRenders(reel, {
      reason: "Narration changed",
      clearOutroAudio: true,
    }),
  ];
  await reel.save();
  await Reel.updateOne(
    { _id: reel._id },
    {
      $unset: {
        titleAudioUrl: "",
        partOutroAudioUrl: "",
        outroAudioUrl: "",
        bodyVideoUrl: "",
        assemblyVideoUrl: "",
        "scenes.$[].audioUrl": "",
      },
    }
  );
  await deleteS3Urls(stale);
}

/** Per-scene motion type for a reel's motion mode (mirrors reel.service). */
function motionTypeFor(mode: ReelMotionMode, i: number, total: number): ISceneMotion["type"] {
  switch (mode) {
    case "ai_full":
      return "ai_motion";
    case "ai_hybrid":
      return i === 0 || i === total - 1 ? "ai_motion" : "parallax";
    case "parallax":
      return "parallax";
    case "ken_burns":
    default:
      return "ken_burns";
  }
}

function reindex(reel: IReel): void {
  reel.scenes.forEach((scene, i) => {
    scene.index = i;
  });
  reel.markModified("scenes");
}

/**
 * Atomically claim the reel for a produce run. Rejects if another produce/plan
 * job already flipped status to an ACTIVE state (prevents double-render races
 * from two tabs / double-clicks).
 */
async function markQueued(reelId: string): Promise<void> {
  const claimed = await Reel.findOneAndUpdate(
    { _id: reelId, status: { $nin: ACTIVE_STATUSES } },
    { $set: { status: "generating_assets", progress: 15 }, $unset: { error: "" } },
    { new: true }
  );
  if (!claimed) {
    const current = await Reel.findById(reelId).select("status").lean();
    throw new Error(
      `Cannot queue produce while generation is active (status: ${current?.status ?? "unknown"})`
    );
  }
}

// ---- Scene edits ----

export async function updateScene(
  reelId: string,
  index: number,
  patch: { narration?: string; visualPrompt?: string; motion?: Partial<ISceneMotion> }
): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertEditable(reel);
  const scene = reel.scenes[index];
  if (!scene) throw new Error(`Scene ${index} not found`);
  const narrationChanged =
    patch.narration !== undefined && patch.narration !== scene.narration;
  const staleAudioUrl = narrationChanged ? scene.audioUrl : undefined;
  if (patch.narration !== undefined) scene.narration = patch.narration;
  if (patch.visualPrompt !== undefined) scene.visualPrompt = patch.visualPrompt;
  if (patch.motion) scene.motion = { ...scene.motion, ...patch.motion };
  if (narrationChanged) {
    scene.audioUrl = undefined;
  }
  reel.markModified("scenes");
  if (reel.strategy === "gameplay_overlay") {
    syncRedditBodyFromScenes(reel);
    reel.markModified("redditStory");
  }
  await reel.save();
  if (narrationChanged || patch.visualPrompt !== undefined || patch.motion) {
    await clearAssemblyCache(reel);
    await deleteS3Urls([staleAudioUrl]);
  }
  return loadReel(reelId);
}

// ============================================
// Series part boundaries — move a spoken line across the seam between two
// adjacent gameplay parts, or merge a part into its previous one. Both keep the
// moved sentences' per-line TTS (audio travels with the scene, so re-rendering
// only rebuilds the composite), and re-sync each part's redditStory.body.
// ============================================

/** A movable copy of a sentence scene: keeps narration + reusable audio, resets
 *  render-derived timing/captions (recomputed when the new part renders). */
function detachScene(scene: IScene): Partial<IScene> {
  return {
    index: 0,
    narration: scene.narration,
    visualPrompt: scene.visualPrompt,
    audioUrl: scene.audioUrl,
    motion: { type: scene.motion.type, direction: scene.motion.direction },
    startTime: 0,
    duration: 0,
    isHero: scene.isHero,
  };
}

/** Renumber scene.index to match array position (parts store scenes positionally). */
function reindexScenes(reel: IReel): void {
  reel.scenes.forEach((scene, i) => {
    scene.index = i;
  });
}

function sortedSeriesParts(reels: IReel[]): IReel[] {
  return [...reels].sort(
    (a, b) =>
      (a.partNumber ?? 1) - (b.partNumber ?? 1) ||
      a.createdAt.getTime() - b.createdAt.getTime()
  );
}

async function loadEditableSeriesParts(
  part: IReel
): Promise<{ parts: IReel[]; index: number }> {
  assertEditable(part);
  if (part.strategy !== "gameplay_overlay") {
    throw new Error("Part boundary edits are only supported for gameplay series");
  }
  if (!part.seriesId || (part.partCount ?? 1) <= 1) {
    throw new Error("This reel is not part of a multi-part series");
  }
  const parts = sortedSeriesParts(await listReelsBySeries(part.seriesId));
  const index = parts.findIndex((p) => p._id.equals(part._id));
  if (index === -1) throw new Error("Part not found in its series");
  return { parts, index };
}

/** Persist a part whose scene list changed and drop its stale composite caches. */
async function saveMovedPart(reel: IReel): Promise<void> {
  reindexScenes(reel);
  syncRedditBodyFromScenes(reel);
  reel.markModified("scenes");
  reel.markModified("redditStory");
  await reel.save();
  await clearAssemblyCache(reel);
}

/**
 * Move one spoken line across the seam between this part and the next: either
 * push this part's last line down to the next part, or pull the next part's
 * first line up into this one. Rebalances a badly-placed part ending without
 * re-planning. Returns the reloaded current part.
 */
export async function moveSeriesBoundary(
  partId: string,
  direction: "pushLastToNext" | "pullFirstFromNext"
): Promise<IReel> {
  const part = await loadReel(partId);
  const { parts, index } = await loadEditableSeriesParts(part);
  const next = parts[index + 1];
  if (!next) throw new Error("This is the last part — no next part to share a line with");
  assertEditable(next);

  if (direction === "pushLastToNext") {
    if (part.scenes.length <= 1) {
      throw new Error("A part must keep at least one line");
    }
    const moved = detachScene(part.scenes[part.scenes.length - 1]);
    part.scenes.splice(part.scenes.length - 1, 1);
    next.scenes.unshift(moved as IScene);
  } else {
    if (next.scenes.length <= 1) {
      throw new Error("The next part must keep at least one line");
    }
    const moved = detachScene(next.scenes[0]);
    next.scenes.splice(0, 1);
    part.scenes.push(moved as IScene);
  }

  await saveMovedPart(part);
  await saveMovedPart(next);
  // Boundary edits change episode structure — require a fresh Keep/Use-AI choice.
  await clearSeriesStructureDecision(sortSeriesReels(await listReelsBySeries(part.seriesId!)));
  return loadReel(partId);
}

/**
 * Merge a part into its previous sibling: append this part's lines onto the
 * previous part (keeping their audio), then delete this part and renumber the
 * survivors. Losslessly consolidates an over-split series (e.g. 3 parts → 2).
 * Returns the reloaded previous part that absorbed the content.
 */
export async function mergePartIntoPrevious(partId: string): Promise<IReel> {
  const part = await loadReel(partId);
  const { parts, index } = await loadEditableSeriesParts(part);
  const prev = parts[index - 1];
  if (!prev) throw new Error("This is the first part — nothing before it to merge into");
  assertEditable(prev);

  for (const scene of part.scenes) {
    prev.scenes.push(detachScene(scene) as IScene);
  }
  await saveMovedPart(prev);

  const prevId = prev._id.toString();
  const seriesId = part.seriesId;
  // Removes the now-absorbed part and renumbers the remaining parts (collapses
  // to a standalone reel when only the merged part is left).
  await deleteSeriesPart(partId);
  if (seriesId) {
    const remaining = await listReelsBySeries(seriesId);
    if (remaining.length) await clearSeriesStructureDecision(sortSeriesReels(remaining));
  }
  return loadReel(prevId);
}

/** Edit Reddit title-card fields (and sync title/hook when title changes). */
export async function updateRedditCard(
  reelId: string,
  patch: Partial<
    Pick<
      IRedditStoryPayload,
      "title" | "subreddit" | "cardUsername" | "author" | "ageHours" | "upvotes" | "comments"
    >
  >
): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertEditable(reel);
  if (reel.strategy !== "gameplay_overlay") {
    throw new Error("Title card edits are only supported for Reddit gameplay reels");
  }
  if (!reel.redditStory) {
    throw new Error("No Reddit story on this reel — plan it first");
  }
  const story = reel.redditStory;
  const titleChanged =
    patch.title !== undefined && patch.title.trim() !== story.title;
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new Error("Title cannot be empty");
    story.title = title;
    reel.title = title;
    reel.hook = title;
  }
  if (patch.subreddit !== undefined) story.subreddit = patch.subreddit.trim() || undefined;
  if (patch.cardUsername !== undefined) {
    const raw = patch.cardUsername.trim();
    story.cardUsername = raw
      ? raw.startsWith("u/")
        ? raw
        : `u/${raw}`
      : undefined;
  }
  if (patch.author !== undefined) story.author = patch.author.trim() || undefined;
  if (patch.ageHours !== undefined) {
    story.ageHours = Number.isFinite(patch.ageHours) ? Math.max(0, Math.round(patch.ageHours)) : undefined;
  }
  if (patch.upvotes !== undefined) {
    story.upvotes = Number.isFinite(patch.upvotes) ? Math.max(0, Math.round(patch.upvotes)) : undefined;
  }
  if (patch.comments !== undefined) {
    story.comments = Number.isFinite(patch.comments) ? Math.max(0, Math.round(patch.comments)) : undefined;
  }
  reel.markModified("redditStory");
  if (titleChanged) {
    // Auto covers follow the spoken title; creator-owned covers stay untouched.
    await refreshAutomaticOpeningCoverIfStale(reel);
  }
  await reel.save();
  // Card is burned into the body video; title audio only invalidates when spoken.
  // Gameplay has no assemblyVideoUrl — clearing body is enough for composite rebuild.
  const stale = [
    reel.bodyVideoUrl,
    titleChanged ? reel.titleAudioUrl : undefined,
    ...invalidateFinalDestinationRenders(reel, {
      reason: "The Reddit title card changed",
    }),
  ];
  await reel.save();
  const unset: Record<string, ""> = { bodyVideoUrl: "" };
  if (titleChanged) unset.titleAudioUrl = "";
  await Reel.updateOne({ _id: reelId }, { $unset: unset });
  await deleteS3Urls(stale);
  return loadReel(reelId);
}

/** Clear the chosen asset(s) for one scene and queue a produce run — only that
 *  scene's image/audio regenerates; everything else is reused. */
export async function regenerateScene(
  reelId: string,
  index: number,
  targets: ("image" | "audio")[]
): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertEditable(reel);
  const scene = reel.scenes[index];
  if (!scene) throw new Error(`Scene ${index} not found`);

  const stale: (string | undefined)[] = [];
  const unset: Record<string, ""> = {};
  if (targets.includes("image")) {
    stale.push(scene.assetUrl);
    unset[`scenes.${index}.assetUrl`] = "";
  }
  if (targets.includes("audio")) {
    stale.push(scene.audioUrl);
    unset[`scenes.${index}.audioUrl`] = "";
  }
  stale.push(
    ...invalidateFinalDestinationRenders(reel, {
      reason: "A scene asset or narration was regenerated",
      clearOutroAudio: targets.includes("audio"),
    }),
  );
  await reel.save();
  await Reel.updateOne({ _id: reelId }, { $unset: unset });
  await deleteS3Urls(stale);

  await markQueued(reelId);
  await enqueueReelProduce(reelId);
  return loadReel(reelId);
}

export async function addScene(
  reelId: string,
  narration: string,
  visualPrompt?: string,
  atIndex?: number
): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertEditable(reel);
  const at = Math.min(Math.max(atIndex ?? reel.scenes.length, 0), reel.scenes.length);
  const isGameplay = reel.strategy === "gameplay_overlay";
  const mode = (reel.motionMode ?? "ken_burns") as ReelMotionMode;
  reel.scenes.splice(at, 0, {
    index: at,
    narration,
    visualPrompt: isGameplay
      ? "gameplay background"
      : visualPrompt?.trim() || narration,
    motion: {
      type: isGameplay ? "static" : motionTypeFor(mode, at, reel.scenes.length + 1),
      direction: "in",
    },
    startTime: 0,
    duration: 0,
    isHero: false,
  });
  reindex(reel);
  if (isGameplay) {
    syncRedditBodyFromScenes(reel);
    reel.markModified("redditStory");
  }
  await reel.save();
  await clearAssemblyCache(reel);
  return loadReel(reelId);
}

export async function removeScene(reelId: string, index: number): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertEditable(reel);
  const scene = reel.scenes[index];
  if (!scene) throw new Error(`Scene ${index} not found`);
  if (reel.scenes.length <= 1) throw new Error("A reel must keep at least one scene");

  const orphaned = [scene.assetUrl, scene.audioUrl];
  reel.scenes.splice(index, 1);
  reindex(reel);
  if (reel.strategy === "gameplay_overlay") {
    syncRedditBodyFromScenes(reel);
    reel.markModified("redditStory");
  }
  await reel.save();
  await clearAssemblyCache(reel);
  await deleteS3Urls(orphaned);
  return loadReel(reelId);
}

export async function reorderScenes(reelId: string, order: number[]): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertEditable(reel);
  const n = reel.scenes.length;
  const valid =
    order.length === n && new Set(order).size === n && order.every((i) => i >= 0 && i < n);
  if (!valid) throw new Error("order must be a permutation of the current scene indices");
  reel.scenes = order.map((i) => reel.scenes[i]);
  reindex(reel);
  if (reel.strategy === "gameplay_overlay") {
    syncRedditBodyFromScenes(reel);
    reel.markModified("redditStory");
  }
  await reel.save();
  await clearAssemblyCache(reel);
  return loadReel(reelId);
}

// ---- Reel-level settings ----

export async function updateReelSettings(
  reelId: string,
  patch: {
    thumbnailSceneIndex?: number;
    artStyleId?: string;
    motionMode?: ReelMotionMode;
    imageModel?: string;
    horrorAudioKey?: string;
    horrorReferenceId?: string;
    gameplayKey?: string;
    outroChannelId?: string;
    outroInstagramChannelId?: string;
    outro?: IReel["outro"];
    skipPartOutro?: boolean;
    skipBrandedOutro?: boolean;
    voice?: { model?: string; voice?: string; format?: "mp3" | "pcm" };
    voiceScope?: "reel" | "series";
    audioPost?: IAudioPost;
    editEffects?: IEditEffects;
    instagram?: {
      caption?: string;
      shareToFeed?: boolean;
      poll?: { question?: string; optionA?: string; optionB?: string };
    };
    facebook?: { description?: string };
    threads?: { text?: string };
  }
): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertEditable(reel);

  // The Voice panel is the one deliberate series-level voice control. Apply
  // that exact voice to every part before returning; background/default
  // selection and preset bundles remain scoped to the current reel.
  if (patch.voice?.voice && patch.voiceScope === "series" && reel.seriesId) {
    const parts = sortedSeriesParts(await listReelsBySeries(reel.seriesId));
    if (parts.length > 1) {
      for (const part of parts) {
        try {
          assertEditable(part);
        } catch {
          throw new Error(
            `Cannot lock the series voice yet — Part ${part.partNumber ?? 1} has an active operation. Wait for every part to finish planning, rendering, or publishing, then try again.`
          );
        }
      }

      await Promise.all(
        parts.map((part) =>
          updateReelSettings(part._id.toString(), { voice: patch.voice })
        )
      );

      recordOperationLog({
        scope: "system",
        event: "voice.series_override_saved",
        message: "Saved one explicit narration voice for every part in the series",
        reelId: reel._id.toString(),
        metadata: {
          seriesId: reel.seriesId,
          partCount: parts.length,
          model: patch.voice.model,
          voice: patch.voice.voice,
        },
      });

      return loadReel(reelId);
    }
  }

  const prevArt = reel.artStyleId;
  const prevModel = reel.imageModelOverride;
  const prevVoiceProfile = reel.audioPost?.voiceProfile;
  const prevSkipPartOutro = Boolean(reel.skipPartOutro);
  const prevSkipBrandedOutro = Boolean(reel.skipBrandedOutro);
  const prevPartOutroAudioUrl = reel.partOutroAudioUrl;
  const prevOutroAudioUrl = reel.outroAudioUrl;
  const prevBodyVideoUrl = reel.bodyVideoUrl;
  const prevAssemblyVideoUrl = reel.assemblyVideoUrl;
  const prevTitleAudioUrl = reel.titleAudioUrl;
  const prevSceneImages = sceneImageUrls(reel);
  const prevSceneAudios = sceneAudioUrls(reel);

  if (patch.thumbnailSceneIndex !== undefined) {
    if (!reel.niche.startsWith("horror")) throw new Error("Scene cover selection is only available for horror reels");
    if (!reel.scenes.some((scene) => scene.index === patch.thumbnailSceneIndex)) {
      throw new Error("Thumbnail scene does not exist");
    }
    reel.thumbnailSceneIndex = patch.thumbnailSceneIndex;
  }

  if (patch.artStyleId !== undefined) reel.artStyleId = patch.artStyleId;
  if (patch.imageModel !== undefined) reel.imageModelOverride = patch.imageModel;
  if (patch.horrorAudioKey !== undefined) reel.horrorAudioKey = patch.horrorAudioKey;
  if (patch.horrorReferenceId !== undefined) reel.horrorReferenceId = patch.horrorReferenceId;
  if (patch.gameplayKey !== undefined) {
    reel.gameplayKey = patch.gameplayKey || undefined;
    // A deleted background cannot silently fall back to a random clip. Only a
    // deliberate selection clears the replacement-required state.
    if (patch.gameplayKey) reel.gameplayAssetMissing = false;
  }
  const prevOutroChannel = reel.outroChannelId;
  const prevOutroInstagramChannel = reel.outroInstagramChannelId;
  const prevCommentPrompt = reel.outro?.commentPrompt;
  const prevSpokenLine = reel.outro?.spokenLine;
  const prevOutroChannelName = reel.outro?.channelName;
  if (patch.outroChannelId !== undefined) reel.outroChannelId = patch.outroChannelId || undefined;
  if (patch.outroInstagramChannelId !== undefined) reel.outroInstagramChannelId = patch.outroInstagramChannelId || undefined;
  if (patch.outro !== undefined) {
    reel.outro = patch.outro;
    reel.markModified("outro");
  }
  if (patch.skipPartOutro !== undefined) reel.skipPartOutro = patch.skipPartOutro;
  if (patch.skipBrandedOutro !== undefined) reel.skipBrandedOutro = patch.skipBrandedOutro;
  if (patch.voice !== undefined) reel.voiceOverride = patch.voice;
  if (patch.audioPost !== undefined) reel.audioPost = patch.audioPost;
  // Edit FX are render-only — no assets to clear, just re-render to apply.
  if (patch.editEffects !== undefined) {
    reel.editEffects = patch.editEffects;
    reel.markModified("editEffects");
  }
  if (patch.instagram !== undefined) {
    if (
      patch.instagram.caption !== undefined &&
      instagramCaptionHashtagCount(patch.instagram.caption) >
        INSTAGRAM_CAPTION_MAX_HASHTAGS
    ) {
      throw new Error(
        `Instagram captions may contain at most ${INSTAGRAM_CAPTION_MAX_HASHTAGS} hashtags`,
      );
    }
    const captionChanged = patch.instagram.caption !== undefined;
    const pollPatch = patch.instagram.poll;
    const pollChanged = Boolean(
      pollPatch &&
      (pollPatch.question !== undefined || pollPatch.optionA !== undefined || pollPatch.optionB !== undefined),
    );
    const priorPoll = reel.instagramSettings?.poll;
    reel.instagramSettings = {
      caption: captionChanged ? patch.instagram.caption : reel.instagramSettings?.caption,
      shareToFeed: patch.instagram.shareToFeed ?? reel.instagramSettings?.shareToFeed ?? true,
      source: captionChanged ? "manual" : reel.instagramSettings?.source,
      generatedAt: captionChanged ? undefined : reel.instagramSettings?.generatedAt,
      model: captionChanged ? undefined : reel.instagramSettings?.model,
      poll: pollPatch
        ? {
            question: pollPatch.question ?? priorPoll?.question,
            optionA: pollPatch.optionA ?? priorPoll?.optionA,
            optionB: pollPatch.optionB ?? priorPoll?.optionB,
            source: pollChanged ? "manual" : priorPoll?.source,
            generatedAt: pollChanged ? undefined : priorPoll?.generatedAt,
            model: pollChanged ? undefined : priorPoll?.model,
          }
        : priorPoll,
    };
    reel.markModified("instagramSettings");
  }
  if (patch.facebook !== undefined) {
    reel.facebookSettings = {
      description: patch.facebook.description ?? reel.facebookSettings?.description,
    };
    reel.markModified("facebookSettings");
  }
  if (patch.threads !== undefined) {
    reel.threadsSettings = {
      text: patch.threads.text ?? reel.threadsSettings?.text,
    };
    reel.markModified("threadsSettings");
  }
  if (patch.motionMode !== undefined) {
    reel.motionMode = patch.motionMode;
    reel.scenes.forEach((scene, i) => {
      scene.motion = { ...scene.motion, type: motionTypeFor(patch.motionMode!, i, reel.scenes.length) };
    });
    reel.markModified("scenes");
  }
  await reel.save();
  if (patch.instagram !== undefined) {
    recordOperationLog({
      scope: "system",
      event: "instagram.publish_metadata_saved",
      message: "Saved Instagram publishing metadata",
      reelId: reel._id.toString(),
      metadata: {
        captionLength: reel.instagramSettings?.caption?.length ?? 0,
        hashtagCount: instagramCaptionHashtagCount(reel.instagramSettings?.caption ?? ""),
        shareToFeed: reel.instagramSettings?.shareToFeed ?? true,
        pollDraft: Boolean(reel.instagramSettings?.poll),
      },
    });
  }
  if (patch.facebook !== undefined || patch.threads !== undefined) {
    recordOperationLog({
      scope: "system",
      event: "crosspost.publish_copy_saved",
      message: "Saved platform-specific cross-post copy",
      reelId: reel._id.toString(),
      metadata: {
        facebookDescriptionLength: reel.facebookSettings?.description?.length ?? 0,
        threadsTextLength: reel.threadsSettings?.text?.length ?? 0,
      },
    });
  }

  // Changing the art style or image model invalidates the stills; a new voice
  // invalidates the narration. Clear so the next produce regenerates them.
  const clearsImages =
    (patch.artStyleId !== undefined && patch.artStyleId !== prevArt) ||
    (patch.imageModel !== undefined && patch.imageModel !== prevModel);
  const clearsAudio =
    patch.voice !== undefined ||
    (patch.audioPost?.voiceProfile !== undefined && patch.audioPost.voiceProfile !== prevVoiceProfile);
  const clearsOutroAudio =
    (patch.outroChannelId !== undefined && patch.outroChannelId !== prevOutroChannel) ||
    (patch.outroInstagramChannelId !== undefined && patch.outroInstagramChannelId !== prevOutroInstagramChannel) ||
    (patch.outro !== undefined &&
      (patch.outro.commentPrompt !== prevCommentPrompt ||
        patch.outro.spokenLine !== prevSpokenLine ||
        patch.outro.channelName !== prevOutroChannelName));
  const clearsAssembly =
    patch.motionMode !== undefined || clearsImages || clearsAudio;
  const clearsBody =
    patch.gameplayKey !== undefined || patch.editEffects !== undefined || clearsAssembly;

  const nextSkipPartOutro =
    patch.skipPartOutro !== undefined ? patch.skipPartOutro : prevSkipPartOutro;
  const nextSkipBrandedOutro =
    patch.skipBrandedOutro !== undefined ? patch.skipBrandedOutro : prevSkipBrandedOutro;
  const partOutroToggledOff = nextSkipPartOutro && !prevSkipPartOutro;
  const partOutroToggledOn = !nextSkipPartOutro && prevSkipPartOutro;
  const brandedOutroToggledOff = nextSkipBrandedOutro && !prevSkipBrandedOutro;
  const brandedOutroToggledOn = !nextSkipBrandedOutro && prevSkipBrandedOutro;
  // Any card/copy/channel/skip change alters the primary final, even when its
  // spoken line is unchanged (for example CTA, subtitle, or footer only).
  const primaryOutroRenderChanged =
    patch.outroChannelId !== undefined ||
    patch.outroInstagramChannelId !== undefined ||
    patch.outro !== undefined ||
    brandedOutroToggledOff ||
    brandedOutroToggledOn;
  // Empty extra-destination prompts inherit the primary story prompt. A primary
  // edit must therefore invalidate only those inherited extras, not a channel
  // with an intentionally bespoke question.
  const primaryCommentPromptChanged =
    patch.outro !== undefined && patch.outro.commentPrompt !== prevCommentPrompt;
  const inheritedPromptDestinationIds = primaryCommentPromptChanged
    ? (reel.destinations ?? [])
        .filter((destination) => !destination.outro?.commentPrompt?.trim())
        .map((destination) => destination.id)
    : [];

  const unset: Record<string, ""> = {};
  const s3Delete: (string | undefined)[] = [];

  if (clearsImages) {
    unset["scenes.$[].assetUrl"] = "";
    s3Delete.push(...prevSceneImages);
  }
  if (clearsAudio) {
    unset["scenes.$[].audioUrl"] = "";
    unset.titleAudioUrl = "";
    unset.partOutroAudioUrl = "";
    unset.outroAudioUrl = "";
    unset.outroAudioSignature = "";
    s3Delete.push(
      ...prevSceneAudios,
      prevTitleAudioUrl,
      prevPartOutroAudioUrl,
      prevOutroAudioUrl
    );
  } else if (clearsOutroAudio) {
    unset.outroAudioUrl = "";
    unset.outroAudioSignature = "";
    s3Delete.push(prevOutroAudioUrl);
  }
  if (clearsAssembly) {
    unset.assemblyVideoUrl = "";
    s3Delete.push(prevAssemblyVideoUrl);
  }
  if (clearsBody) {
    unset.bodyVideoUrl = "";
    s3Delete.push(prevBodyVideoUrl);
  }

  // Part outro is baked into the gameplay body — toggling it requires a body rebuild.
  if (partOutroToggledOff || partOutroToggledOn) {
    unset.bodyVideoUrl = "";
    s3Delete.push(prevBodyVideoUrl);
  }
  if (partOutroToggledOff) {
    unset.partOutroAudioUrl = "";
    s3Delete.push(prevPartOutroAudioUrl);
  }
  // Branded outro sits after bodyVideoUrl — body stays valid; only outro audio goes.
  if (brandedOutroToggledOff) {
    unset.outroAudioUrl = "";
    unset.outroAudioSignature = "";
    s3Delete.push(prevOutroAudioUrl);
  }

  // A final video is only publishable while it reflects the current body and
  // the current destination's outro. Never leave an older primary or sibling
  // render marked ready after an upstream edit.
  const sharedFinalChanged = clearsBody || partOutroToggledOff || partOutroToggledOn;
  const primaryFinalChanged = primaryOutroRenderChanged;
  if (sharedFinalChanged || primaryFinalChanged) {
    s3Delete.push(
      ...invalidateFinalDestinationRenders(reel, {
        reason: sharedFinalChanged
          ? "Shared body, narration, or part teaser settings changed"
          : "Primary branded outro settings changed",
        includePrimary: true,
        includeExtras: sharedFinalChanged || inheritedPromptDestinationIds.length > 0,
        extraDestinationIds: sharedFinalChanged ? undefined : inheritedPromptDestinationIds,
        clearOutroAudio: clearsAudio || inheritedPromptDestinationIds.length > 0,
      }),
    );
    await reel.save();
  }

  if (Object.keys(unset).length) {
    await Reel.updateOne({ _id: reelId }, { $unset: unset });
  }
  await deleteS3Urls(s3Delete);

  return loadReel(reelId);
}

/** Manual (non-AI) caption look edit — merges over the current style. Applied on
 *  the next render (re-burn from assembly when present — no Ken Burns). */
export async function updateCaptions(reelId: string, patch: ICaptionStyle): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertEditable(reel);
  reel.captionStyle = mergeCaptionStyle(reel.captionStyle, patch);
  reel.markModified("captionStyle");
  await reel.save();
  // Captions are burned into bodyVideoUrl; assembly (pre-caption) stays valid.
  await clearBodyVideoCache(reel);
  return loadReel(reelId);
}

// ---- Regeneration control ----

/** Queue a produce run. `render_only` reuses cached assets. `composite_only`
 *  rebuilds from assembly/narration caches with no TTS. `outro_only` appends a
 *  new branded outro onto bodyVideoUrl. `assets` clears stills+narration. */
export async function regenerateReel(
  reelId: string,
  mode: "render_only" | "assets" | "outro_only" | "composite_only"
): Promise<IReel> {
  assertFfmpegReady("Regenerate");
  const reel = await loadReel(reelId);
  assertEditable(reel);
  if (reel.scenes.length === 0) throw new Error("Nothing to regenerate — plan the reel first");
  // Claim the lock first so a concurrent tab can't also enqueue.
  await markQueued(reelId);
  if (mode === "assets") {
    const staleImages = sceneImageUrls(reel);
    await clearNarrationCaches(reel);
    await Reel.updateOne({ _id: reelId }, { $unset: { "scenes.$[].assetUrl": "" } });
    await deleteS3Urls(staleImages);
  }
  const produceMode =
    mode === "outro_only" ? "outro_only" : mode === "composite_only" ? "composite_only" : "full";
  await enqueueReelProduce(reelId, { produceMode });
  return loadReel(reelId);
}

/** Rebuild outro visuals from the latest resolved account data while retaining
 * the cached outro narration whenever the spoken line and voice are unchanged. */
export async function retryReelOutro(
  reelId: string,
  retry: { scope: "all" | "primary" | "destination"; destinationId?: string },
): Promise<IReel> {
  assertFfmpegReady("Retry outro");
  const reel = await loadReel(reelId);
  assertEditable(reel);
  if (reel.skipBrandedOutro) throw new Error("Enable the branded outro before retrying it");
  if (!reel.bodyVideoUrl) throw new Error("A completed body render is required before an outro can be retried");
  if (retry.scope === "destination") {
    if (!retry.destinationId || !reel.destinations?.some((destination) => destination.id === retry.destinationId)) {
      throw new Error("The selected outro account is no longer assigned to this reel");
    }
  }
  await markQueued(reelId);
  await enqueueReelProduce(reelId, { produceMode: "outro_only", outroRetry: retry });
  return loadReel(reelId);
}

// ---- Multi-channel destinations ----
// `reel.destinations` holds the EXTRA channels beyond the primary. The primary is
// the legacy `reel.outro*` fields (edited via updateReelSettings). These endpoints
// manage the extras; resolveReelDestinations() = [primary, ...extras].

/** True once the reel has a rendered body, so an outro-only re-render is possible. */
function canRerenderOutro(reel: IReel): boolean {
  return Boolean(reel.bodyVideoUrl) && !ACTIVE_STATUSES.includes(reel.status) && reel.scenes.length > 0;
}

async function resolveChannelLabel(
  platform: "youtube" | "instagram" | "facebook" | "threads",
  channelId: string
): Promise<string> {
  if (platform === "youtube") {
    const channel = await YouTubeChannel.findOne({ channelKey: channelId, status: "active" });
    if (!channel) throw new Error("YouTube channel not found or inactive");
    return channel.googleChannelTitle || channel.label;
  }
  if (platform === "instagram") {
    const channel = await InstagramChannel.findOne({ channelKey: channelId, status: "active" });
    if (!channel) throw new Error("Instagram account not found or inactive");
    return channel.name || channel.username || channel.label;
  }
  if (platform === "facebook") {
    const page = await FacebookPage.findOne({ channelKey: channelId, status: "active" });
    if (!page) throw new Error("Facebook Page not found or inactive");
    return page.name || page.label;
  }
  const channel = await ThreadsChannel.findOne({ channelKey: channelId, status: "active" });
  if (!channel) throw new Error("Threads profile not found or inactive");
  return channel.name || channel.username || channel.label;
}

/** List all destinations for a reel (primary + extras). */
export async function listReelDestinations(reelId: string): Promise<IReelDestination[]> {
  const reel = await loadReel(reelId);
  return resolveReelDestinations(reel);
}

interface PrimaryDestinationInput {
  platform: "youtube" | "instagram";
  channelId: string;
  /** Keep turns the current primary into an extra destination; remove deletes
   * only this reel/story's rendered media for that account, never the globally
   * connected YouTube/Instagram account. */
  previousPrimary: "keep" | "remove";
  /** Apply the routing change to the current part or every part in the series. */
  scope: "reel" | "series";
}

function channelSpecificOutro(outro: IOutroSettings | undefined): IOutroSettings | undefined {
  if (!outro) return undefined;
  const { commentPrompt: _globalStoryQuestion, ...channelFields } = outro;
  return Object.keys(channelFields).length ? channelFields : undefined;
}

function primaryPlatform(reel: IReel): "youtube" | "instagram" {
  return reel.outroInstagramChannelId ? "instagram" : "youtube";
}

function primaryChannelId(reel: IReel): string | undefined {
  return reel.outroInstagramChannelId || reel.outroChannelId;
}

async function changePrimaryDestinationOnReel(
  reel: IReel,
  input: Omit<PrimaryDestinationInput, "scope">,
  targetLabel: string,
): Promise<string[]> {
  const currentPlatform = primaryPlatform(reel);
  const currentChannelId = primaryChannelId(reel);
  if (currentPlatform === input.platform && currentChannelId === input.channelId) return [];

  const extras = [...(reel.destinations ?? [])];
  const promotedExtraIndex = extras.findIndex(
    (destination) => destination.platform === input.platform && destination.channelId === input.channelId,
  );
  const promotedExtra = promotedExtraIndex >= 0 ? extras[promotedExtraIndex] : undefined;
  if (promotedExtraIndex >= 0) extras.splice(promotedExtraIndex, 1);

  const globalQuestion = reel.outro?.commentPrompt;
  // A ready promoted extra may intentionally have a channel-local question.
  // Its media/audio remains valid only if that effective question becomes the
  // new primary question. If we keep the old primary, freeze its old effective
  // question too whenever the global question changes beneath it.
  const promotedQuestion = promotedExtra?.outro?.commentPrompt?.trim();
  const nextGlobalQuestion = promotedQuestion || globalQuestion;
  const stale: string[] = [];
  if (promotedQuestion && globalQuestion) {
    // Every remaining blank extra had rendered against the former global
    // question. Freeze it before the promoted local question becomes global,
    // otherwise a ready file would no longer match its persisted copy.
    for (const destination of extras) {
      if (!destination.outro?.commentPrompt?.trim()) {
        destination.outro = { ...(destination.outro ?? {}), commentPrompt: globalQuestion };
      }
    }
  }
  if (currentChannelId && input.previousPrimary === "keep") {
    const currentLabel = await resolveChannelLabel(currentPlatform, currentChannelId).catch(
      () => currentChannelId,
    );
    extras.push({
      id: randomUUID(),
      platform: currentPlatform,
      channelId: currentChannelId,
      channelLabel: currentLabel,
      outro: {
        ...(channelSpecificOutro(reel.outro) ?? {}),
        ...(promotedQuestion && globalQuestion ? { commentPrompt: globalQuestion } : {}),
      },
      skipBrandedOutro: reel.skipBrandedOutro,
      outroAudioUrl: reel.outroAudioUrl,
      outroAudioSignature: reel.outroAudioSignature,
      outputUrl: reel.outputUrl,
      status: reel.outputUrl ? "ready" : "pending",
      createdAt: new Date(),
    });
  } else if (input.previousPrimary === "remove") {
    if (reel.outputUrl) stale.push(reel.outputUrl);
    if (reel.outroAudioUrl) stale.push(reel.outroAudioUrl);
  }

  if (input.platform === "instagram") {
    reel.outroInstagramChannelId = input.channelId;
    reel.outroChannelId = undefined;
  } else {
    reel.outroChannelId = input.channelId;
    reel.outroInstagramChannelId = undefined;
  }

  if (promotedExtra) {
    reel.outro = {
      ...(channelSpecificOutro(promotedExtra.outro) ?? {}),
      ...(nextGlobalQuestion ? { commentPrompt: nextGlobalQuestion } : {}),
    };
    reel.skipBrandedOutro = promotedExtra.skipBrandedOutro;
    reel.outroAudioUrl = promotedExtra.outroAudioUrl;
    reel.outroAudioSignature = promotedExtra.outroAudioSignature;
    reel.outputUrl = promotedExtra.outputUrl;
  } else {
    // A newly selected connected account has no channel-specific final yet.
    // Retain the global story question, but let its own connected profile and
    // platform defaults supply the brand/card values.
    reel.outro = globalQuestion ? { commentPrompt: globalQuestion } : undefined;
    reel.skipBrandedOutro = false;
    reel.outroAudioUrl = undefined;
    reel.outroAudioSignature = undefined;
    reel.outputUrl = undefined;
  }

  reel.destinations = extras;
  reel.markModified("outro");
  reel.markModified("destinations");
  recordOperationLog({
    scope: "system",
    event: "outro.primary_destination_changed",
    message: "Changed the primary publish destination while preserving channel-scoped outputs",
    reelId: reel._id.toString(),
    metadata: {
      from: currentChannelId ? `${currentPlatform}:${currentChannelId}` : "auto",
      to: `${input.platform}:${input.channelId}`,
      targetLabel,
      previousPrimary: input.previousPrimary,
      promotedExistingDestination: Boolean(promotedExtra),
    },
  });
  return stale.filter((url): url is string => Boolean(url));
}

/**
 * Promote a destination (or select a new connected account) as this reel's
 * primary. This only changes reel routing/media ownership: it never deletes a
 * connected social account. With `scope: series`, every part gets the same
 * primary routing rule, while each part retains its own correct final output.
 */
export async function setReelPrimaryDestination(
  reelId: string,
  input: PrimaryDestinationInput,
): Promise<IReel> {
  const root = await loadReel(reelId);
  assertEditable(root);
  const targetLabel = await resolveChannelLabel(input.platform, input.channelId);
  const parts = input.scope === "series" && root.seriesId
    ? sortedSeriesParts(await listReelsBySeries(root.seriesId))
    : [root];
  for (const part of parts) assertEditable(part);

  const stale: string[] = [];
  for (const part of parts) {
    stale.push(
      ...(await changePrimaryDestinationOnReel(part, {
        platform: input.platform,
        channelId: input.channelId,
        previousPrimary: input.previousPrimary,
      }, targetLabel)),
    );
    await part.save();
  }
  await deleteS3Urls([...new Set(stale)]);
  return loadReel(reelId);
}

/** Add an EXTRA channel destination to one part or every part in its story.
 * New destinations get their own branded outro. Facebook/Threads can still
 * cross-post the primary render when no dedicated destination is added. */
export async function addReelDestination(
  reelId: string,
  input: {
    platform: "youtube" | "instagram" | "facebook" | "threads";
    channelId: string;
    outro?: IOutroSettings;
    scope?: "reel" | "series";
  }
): Promise<IReel> {
  const root = await loadReel(reelId);
  assertEditable(root);
  const parts = input.scope === "series" && root.seriesId
    ? sortedSeriesParts(await listReelsBySeries(root.seriesId))
    : [root];
  for (const part of parts) assertEditable(part);
  const channelLabel = await resolveChannelLabel(input.platform, input.channelId);

  // Validate every part before mutating one. A channel which is already a
  // primary uses different media ownership, so an "add as extra" operation
  // must not quietly create conflicting routing within a story.
  for (const part of parts) {
    const primaryPlatform = part.outroInstagramChannelId ? "instagram" : "youtube";
    const primaryChannel = part.outroInstagramChannelId || part.outroChannelId;
    if (input.platform === primaryPlatform && input.channelId === primaryChannel) {
      const suffix = parts.length > 1 ? ` on story part ${part.partNumber ?? "?"}` : "";
      throw new Error(`That channel is already the primary destination${suffix}. Use the primary-account control instead.`);
    }
  }

  const missingParts = parts.filter((part) => !part.destinations?.some(
    (destination) => destination.platform === input.platform && destination.channelId === input.channelId,
  ));
  if (!missingParts.length) return loadReel(reelId);

  for (const part of missingParts) {
    if (!part.destinations) part.destinations = [];
    part.destinations.push({
      id: randomUUID(),
      platform: input.platform,
      channelId: input.channelId,
      channelLabel,
      outro: input.outro,
      status: "pending",
      createdAt: new Date(),
    });
    part.markModified("destinations");
  }
  await Promise.all(missingParts.map((part) => part.save()));

  // Adding an account while the branded outro is disabled remains configuration
  // only. Otherwise each produced part gets only its new channel outro over the
  // cached body — no scenes or body narration are regenerated.
  await Promise.all(missingParts
    .filter((part) => !part.skipBrandedOutro && canRerenderOutro(part))
    .map((part) => regenerateReel(part._id.toString(), "outro_only")));
  return loadReel(reelId);
}

export interface DestinationRemovalResult {
  reel: IReel;
  destination: { id: string; platform: "youtube" | "instagram" | "facebook" | "threads"; channelId: string; channelLabel?: string };
  cleanup: { requested: number; deleted: number; skipped: number; failed: number };
}

/** Remove an extra destination and its dedicated media. The persisted
 * Operations record and response both say whether each recorded S3 deletion
 * request succeeded, failed, or had no usable S3 key. */
export async function removeReelDestination(reelId: string, destId: string): Promise<DestinationRemovalResult> {
  const reel = await loadReel(reelId);
  assertEditable(reel);
  const index = reel.destinations?.findIndex((d) => d.id === destId) ?? -1;
  if (index === -1 || !reel.destinations) throw new Error("Destination not found");
  const [removed] = reel.destinations.splice(index, 1);
  reel.markModified("destinations");
  await reel.save();
  const cleanup = await deleteS3Urls([removed.outputUrl, removed.outroAudioUrl]);
  recordOperationLog({
    scope: "system",
    level: cleanup.failed ? "warn" : "info",
    event: "outro.destination_removed",
    message: cleanup.failed
      ? "Removed destination, but one or more recorded S3 deletion requests failed"
      : "Removed destination and completed recorded S3 media cleanup",
    reelId,
    metadata: {
      destinationId: removed.id,
      platform: removed.platform,
      channelId: removed.channelId,
      channelLabel: removed.channelLabel,
      hadOutput: Boolean(removed.outputUrl),
      hadOutroAudio: Boolean(removed.outroAudioUrl),
      ...cleanup,
    },
  });
  console.log(
    `🧹 Removed ${removed.platform} destination ${removed.channelId} from reel ${reelId}; S3 deleted=${cleanup.deleted}, failed=${cleanup.failed}, skipped=${cleanup.skipped}`,
  );
  return {
    reel: await loadReel(reelId),
    destination: {
      id: removed.id,
      platform: removed.platform,
      channelId: removed.channelId,
      channelLabel: removed.channelLabel,
    },
    cleanup,
  };
}

/** Update one extra destination's outro copy; re-renders its outro when produced. */
export async function updateReelDestinationOutro(
  reelId: string,
  destId: string,
  outro: IOutroSettings
): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertEditable(reel);
  const dest = reel.destinations?.find((d) => d.id === destId);
  if (!dest) throw new Error("Destination not found");
  const outroNarrationChanged =
    (dest.outro?.commentPrompt ?? "") !== (outro.commentPrompt ?? "") ||
    (dest.outro?.spokenLine ?? "") !== (outro.spokenLine ?? "");
  dest.outro = outro;
  if (outroNarrationChanged) {
    dest.outroAudioUrl = undefined;
    dest.outroAudioSignature = undefined;
  }
  dest.status = "pending";
  reel.markModified("destinations");
  await reel.save();
  // Saving copy while the branded outro is disabled is configuration only.
  // Do not spend a render to re-emit the same body without an end card.
  if (!reel.skipBrandedOutro && canRerenderOutro(reel)) return regenerateReel(reelId, "outro_only");
  return loadReel(reelId);
}

/**
 * Resume a failed produce job. Reuses any scene stills/narration already on S3
 * (images + TTS are the expensive part) and only re-runs render→upload.
 * Prefer this over regenerating assets when the failure was late-stage
 * (ffmpeg caption burn, mix, outro, upload).
 */
export async function resumeFailedReel(reelId: string): Promise<IReel> {
  const reel = await loadReel(reelId);
  if (reel.status !== "failed") {
    throw new Error(`Reel is not failed (status: ${reel.status}) — nothing to resume`);
  }
  if (reel.scenes.length === 0) {
    throw new Error("Nothing to resume — plan the reel first");
  }
  const imageN = reel.scenes.filter((s) => s.assetUrl).length;
  const audioN = reel.scenes.filter((s) => s.audioUrl).length;
  if (imageN || audioN) {
    console.log(
      `♻️  Resuming failed reel ${reelId} — reusing ${imageN} image(s) / ${audioN} narration(s), re-running render only`
    );
  }
  // Single ffmpeg gate via regenerateReel (also covers the no-assets path).
  return regenerateReel(reelId, "render_only");
}

/** Approve a reviewed plan → run the produce stage. */
export async function approvePlan(reelId: string): Promise<IReel> {
  assertFfmpegReady("Generate");
  const reel = await loadReel(reelId);
  if (reel.status !== "plan_review") {
    throw new Error(`Reel is not awaiting plan review (status: ${reel.status})`);
  }
  await assertStructureChoice(reel);
  await markQueued(reelId);
  await enqueueReelProduce(reelId);
  return loadReel(reelId);
}

/** Wipe scenes/plan state before attaching a new story. Returns stale S3 URLs. */
async function resetReelForReplan(reel: IReel): Promise<string[]> {
  const preservedCover = snapshotCreatorShortsCover(reel);
  const preservedCoverUrl = preservedCover?.imageUrl;
  const staleMedia = collectReelS3AssetUrls(reel).filter((url) => url !== preservedCoverUrl);
  await cleanupReelLocalStaging(reel);

  reel.scenes = [];
  reel.title = undefined;
  reel.hook = undefined;
  invalidateFinalDestinationRenders(reel, {
    reason: "The reel was reset for a new story plan",
    clearOutroAudio: true,
  });
  reel.bodyVideoUrl = undefined;
  reel.assemblyVideoUrl = undefined;
  reel.subtitlesUrl = undefined;
  reel.titleAudioUrl = undefined;
  reel.partOutroAudioUrl = undefined;
  reel.outroAudioUrl = undefined;
  reel.voiceVariants = [];
  reel.markModified("voiceVariants");
  reel.editDraft = undefined;
  reel.markModified("editDraft");
  reel.thumbnailDraft = undefined;
  reel.markModified("thumbnailDraft");
  // Drop the whole review package so produce rebuilds title/thumbnail together.
  // Partial clears left a title without a thumbnail after restructure.
  if (reel.review) {
    reel.review = undefined;
    reel.markModified("review");
  }
  // Keep Thumbnail Studio covers across Keep/Use-AI restructure. Only drop
  // automatic covers (they regenerate after the new plan). Never restore a
  // cover snapshot that lost its imageUrl — that previously deleted S3 media.
  if (preservedCover?.imageUrl) {
    reel.shortsCover = preservedCover;
    reel.markModified("shortsCover");
  } else {
    reel.shortsCover = undefined;
    reel.markModified("shortsCover");
  }
  if (reel.strategy === "gameplay_overlay") {
    reel.redditStory = undefined;
    reel.markModified("redditStory");
  }
  reel.status = "planning";
  reel.progress = 5;
  reel.error = undefined;
  return staleMedia;
}

function seriesPartsForGenerate(
  parts: "off" | "auto" | number | undefined,
  source: StorySource
): number | "auto" | undefined {
  if (parts === "off") {
    // Verbatim "1 (no split)" collapses the whole story into a single reel via
    // the series planner (keeps the full untruncated body). Other sources fall
    // back to a plain standalone re-plan.
    return source === "verbatim" ? 1 : undefined;
  }
  return parts;
}

function defaultSeriesParts(reel: IReel): "off" | "auto" | number {
  if (reel.partCount && reel.partCount > 1) return reel.partCount;
  return "auto";
}

/** Manual follow-ups belong to their seed; never carry them to a different post. */
function preserveManualLinksForSeed(reel: IReel, nextSeedUrl: string | undefined): boolean {
  if (!nextSeedUrl || !reel.redditStory?.seedUrl) return false;
  const currentId = parseRedditPostId(reel.redditStory.seedUrl);
  const nextId = parseRedditPostId(nextSeedUrl);
  return Boolean(currentId && nextId && currentId === nextId);
}

function sortSeriesReels(reels: IReel[]): IReel[] {
  return [...reels].sort(
    (a, b) => (a.partNumber ?? 1) - (b.partNumber ?? 1) || a.createdAt.getTime() - b.createdAt.getTime()
  );
}

function cloneSeriesReelFromAnchor(anchor: IReel, part: { partNumber?: number; partCount?: number }): IReel {
  return new Reel({
    niche: anchor.niche,
    topic: anchor.topic,
    tier: anchor.tier,
    storySource: anchor.storySource,
    genre: anchor.genre,
    strategy: anchor.strategy,
    gameplayKey: anchor.gameplayKey,
    horrorAudioKey: anchor.horrorAudioKey,
    outroChannelId: anchor.outroChannelId,
    outroInstagramChannelId: anchor.outroInstagramChannelId,
    outro: anchor.outro ? { ...anchor.outro } : undefined,
    destinations: anchor.destinations?.map((destination) => ({
      ...destination,
      // New parts share channel routing, not rendered media.
      outputUrl: undefined,
      outroAudioUrl: undefined,
      outroAudioSignature: undefined,
      durationAdded: undefined,
      status: "pending" as const,
      error: undefined,
      createdAt: new Date(),
    })),
    skipPartOutro: anchor.skipPartOutro,
    skipBrandedOutro: anchor.skipBrandedOutro,
    thumbnailMode: anchor.thumbnailMode,
    thumbnailHook: anchor.thumbnailHook,
    imageModelOverride: anchor.imageModelOverride,
    voiceOverride: anchor.voiceOverride,
    narrationVoice: anchor.narrationVoice,
    captionStyle: anchor.captionStyle,
    pipelineMode: anchor.pipelineMode,
    status: "planning",
    progress: 5,
    partNumber: part.partNumber,
    partCount: part.partCount,
  });
}

/** Discard plans for every reel in a series and re-plan from one selected story. */
export async function replanReelSeries(
  reelId: string,
  patch: {
    selectedStoryId?: string;
    selectedSeedUrl?: string;
    parts?: "off" | "auto" | number;
  }
): Promise<IReel> {
  if (!patch.selectedStoryId && !patch.selectedSeedUrl) {
    throw new Error("Select a story to re-plan the series");
  }

  const anchor = await loadReel(reelId);
  assertEditable(anchor);
  if (anchor.strategy !== "gameplay_overlay") {
    throw new Error("Series re-plan is only supported for Reddit gameplay reels");
  }

  const source = (anchor.storySource ?? "hybrid") as StorySource;
  const existingReels = anchor.seriesId
    ? sortSeriesReels(await listReelsBySeries(anchor.seriesId))
    : [anchor];
  for (const reel of existingReels) assertEditable(reel);

  const excludeReelIds = existingReels.map((reel) => reel._id.toString());
  const partsSetting = patch.parts ?? defaultSeriesParts(anchor);
  const generateParts = seriesPartsForGenerate(partsSetting, source);
  const keepManualLinks = preserveManualLinksForSeed(anchor, patch.selectedSeedUrl);

  if (generateParts === undefined) {
    const target = existingReels.find((reel) => reel._id.toString() === reelId) ?? anchor;
    for (const reel of existingReels) {
      if (reel._id.toString() === target._id.toString()) continue;
      await deleteReel(reel._id.toString());
    }
    const replanned = await replanReel(target._id.toString(), patch);
    if (replanned.seriesId || (replanned.partCount ?? 1) > 1) {
      replanned.seriesId = undefined;
      replanned.partNumber = 1;
      replanned.partCount = 1;
      if (replanned.redditStory) {
        replanned.redditStory.partNumber = 1;
        replanned.redditStory.partCount = 1;
        replanned.markModified("redditStory");
      }
      await replanned.save();
    }
    return loadReel(target._id.toString());
  }

  let reservedStoryId: string | undefined;
  if (patch.selectedStoryId) {
    const story = await loadAndReserveBankStory(patch.selectedStoryId);
    reservedStoryId = story.storyId;
  }

  const storyCosts: MeasuredCostInput[] = [];
  const plannedParts = await generateStorySeries(source, {
    genre: anchor.genre,
    tier: anchor.tier as Tier,
    parts: generateParts,
    selectedStoryId: patch.selectedStoryId,
    selectedSeedUrl: patch.selectedSeedUrl,
    excludeReelIds,
    // Keep the source's update policy when choosing a new series story, so the
    // recommendation in the resulting plan sees the same enabled follow-ups.
    fetchUpdates: anchor.fetchUpdates,
    manualUpdateUrls: keepManualLinks ? anchor.manualUpdateUrls : undefined,
    onLlmUsage: (usage) =>
      storyCosts.push({ label: usage.label, model: usage.model, costUsd: usage.costUsd, source: "actual" }),
  });

  const nextSeriesId = plannedParts.length > 1 ? anchor.seriesId ?? randomUUID() : undefined;
  const staleMedia: string[] = [];
  const updatedReels: IReel[] = [];

  for (let i = 0; i < plannedParts.length; i++) {
    const part = plannedParts[i];
    let reel =
      existingReels.find((candidate) => (candidate.partNumber ?? 1) === (part.partNumber ?? i + 1)) ??
      existingReels[i];

    if (!reel) {
      reel = cloneSeriesReelFromAnchor(anchor, {
        partNumber: part.partNumber,
        partCount: part.partCount,
      });
    } else {
      staleMedia.push(...(await resetReelForReplan(reel)));
    }

    reel.title = part.title;
    reel.hook = part.title;
    reel.genre = part.genre ?? anchor.genre;
    reel.redditStory = redditPayloadFromStoryPart(part);
    reel.markModified("redditStory");
    reel.seriesId = nextSeriesId;
    reel.partNumber = part.partNumber;
    reel.partCount = part.partCount;
    reel.manualUpdateUrls = keepManualLinks ? anchor.manualUpdateUrls : undefined;
    reel.status = "planning";
    reel.progress = 5;
    reel.error = undefined;
    await reel.save();
    updatedReels.push(reel);
    await removeReelJob(reel._id.toString());
    await enqueueReelPlan(reel._id.toString());
  }

  const keepIds = new Set(updatedReels.map((reel) => reel._id.toString()));
  for (const reel of existingReels) {
    const id = reel._id.toString();
    if (keepIds.has(id)) continue;
    await deleteReel(id);
  }

  if (plannedParts.length === 1) {
    const sole = updatedReels[0];
    sole.seriesId = undefined;
    sole.partNumber = 1;
    sole.partCount = 1;
    if (sole.redditStory) {
      sole.redditStory.partNumber = 1;
      sole.redditStory.partCount = 1;
      sole.markModified("redditStory");
    }
    await sole.save();
  }

  if (reservedStoryId && updatedReels[0]) {
    await markStoryReel(reservedStoryId, updatedReels[0]._id.toString());
  }

  // Re-plan story-gen LLM spend (cut selection / rewrite / cliffhanger judge)
  // is shared across parts — record it on part 1's ledger.
  if (storyCosts.length && updatedReels[0]) {
    applyMeasuredCostsToReel(updatedReels[0], storyCosts, "Series re-plan");
    await updatedReels[0].save();
  }

  await deleteS3Urls(staleMedia);

  const returnId = keepIds.has(reelId) ? reelId : updatedReels[0]._id.toString();
  return loadReel(returnId);
}

/** Discard the current plan and re-plan (new story / reference / pasted script). */
export async function replanReel(
  reelId: string,
  patch: {
    topic?: string;
    providedScript?: string;
    horrorReferenceId?: string;
    selectedStoryId?: string;
    selectedSeedUrl?: string;
  }
): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertEditable(reel);
  if (patch.topic !== undefined) reel.topic = patch.topic;
  if (patch.providedScript !== undefined) reel.providedScript = patch.providedScript;
  if (patch.horrorReferenceId !== undefined) reel.horrorReferenceId = patch.horrorReferenceId;

  // Drop prior render media before wiping the plan so S3 doesn't keep orphans.
  const staleMedia = await resetReelForReplan(reel);
  const storyCosts: MeasuredCostInput[] = [];

  if (reel.strategy === "gameplay_overlay") {
    const source = (reel.storySource ?? "llm") as StorySource;
    if (patch.selectedStoryId) {
      const story = await loadAndReserveBankStory(patch.selectedStoryId);
      reel.manualUpdateUrls = undefined;
      reel.redditStory = redditPayloadFromStoryDraft(story);
      reel.title = story.title;
      reel.hook = story.title;
      reel.genre = story.genre ?? reel.genre;
      reel.markModified("redditStory");
      await markStoryReel(story.storyId, reelId);
    } else if (patch.selectedSeedUrl) {
      const deferHybrid = source === "hybrid";
      const keepManualLinks = preserveManualLinksForSeed(reel, patch.selectedSeedUrl);
      if (!keepManualLinks) reel.manualUpdateUrls = undefined;
      const story = await materializeFromSeed(patch.selectedSeedUrl, source, reel.genre, reel.tier as Tier, {
        seedOnly: deferHybrid,
        excludeReelId: reelId,
        fetchUpdates: reel.fetchUpdates,
        manualUpdateUrls: keepManualLinks ? reel.manualUpdateUrls : undefined,
        stageAutoUpdates: source === "verbatim",
        onLlmUsage: (usage) =>
          storyCosts.push({ label: usage.label, model: usage.model, costUsd: usage.costUsd, source: "actual" }),
      });
      if (deferHybrid) {
        reel.redditStory = {
          title: story.seedTitle ?? story.title,
          body: "",
          source: story.source,
          genre: story.genre ?? reel.genre,
          subreddit: story.subreddit,
          author: story.author,
          upvotes: story.upvotes,
          comments: story.comments,
          ageHours: story.ageHours,
          seedTitle: story.seedTitle,
          seedUrl: story.seedUrl,
          partNumber: reel.partNumber ?? 1,
          partCount: reel.partCount ?? 1,
        };
      } else {
        reel.redditStory = redditPayloadFromStoryDraft(story);
        reel.title = story.title;
        reel.hook = story.title;
      }
      reel.genre = story.genre ?? reel.genre;
      reel.markModified("redditStory");
    }
  }

  await reel.save();
  applyMeasuredCostsToReel(reel, storyCosts, "Re-plan story");
  if (storyCosts.length) await reel.save();
  await deleteS3Urls(staleMedia);
  await removeReelJob(reelId);
  await enqueueReelPlan(reelId);
  return loadReel(reelId);
}

// ============================================
// Followup/update discovery in Studio — re-scan the OP's later updates, add a
// manual followup link, then fold the chosen updates back into the story and
// recompute parts. Two apply modes: "append" adds new followup part(s) while
// leaving existing parts byte-stable; "recut" re-splits original + all updates
// across the whole series for accurate pacing. See reddit-update-discovery.
// ============================================

function payloadToDiscovery(p: IUpdateDiscoveryPayload): UpdateDiscovery {
  return {
    method: p.method,
    scannedAt: p.scannedAt instanceof Date ? p.scannedAt.getTime() : Date.now(),
    candidates: p.candidates.map((c) => ({
      key: c.key,
      kind: c.kind,
      title: c.title,
      body: c.body,
      url: c.url,
      createdUtc: c.createdUtc,
      matchedSignals: (c.matchedSignals ?? []) as UpdateSignal[],
      signalScore: c.signalScore ?? 0,
      aiConfidence: c.aiConfidence,
      aiReason: c.aiReason,
      decision: c.decision,
    })),
  };
}

function discoveryToPayload(d: UpdateDiscovery, includedKeys: string[]): IUpdateDiscoveryPayload {
  return {
    scannedAt: new Date(d.scannedAt),
    method: d.method,
    candidates: d.candidates.map((c) => ({ ...c })),
    includedKeys,
  };
}

/** Dedupe candidate lists by key, merging matched signals. */
function mergeCandidates(a: UpdateCandidate[], b: UpdateCandidate[]): UpdateCandidate[] {
  const byKey = new Map<string, UpdateCandidate>();
  for (const c of [...a, ...b]) {
    const existing = byKey.get(c.key);
    if (!existing) byKey.set(c.key, { ...c });
    else existing.matchedSignals = [...new Set([...existing.matchedSignals, ...c.matchedSignals])];
  }
  return [...byKey.values()].sort((x, y) => x.createdUtc - y.createdUtc);
}

/** Split a body into `count` sequential part bodies (LLM cut points, cliffhanger-aware). */
async function splitBodyIntoParts(
  title: string,
  body: string,
  count: number,
  tier: Tier,
  onLlmUsage?: (usage: { label: string; model: string; costUsd: number }) => void
): Promise<string[]> {
  const sentences = splitSentencesForReelParts(body);
  const partCount = Math.min(Math.max(count, 1), Math.max(sentences.length, 1));
  if (partCount <= 1) return [body];
  const cuts = await selectVerbatimCuts(title, sentences, partCount, tier, onLlmUsage);
  const ranges = [0, ...cuts, sentences.length];
  return Array.from({ length: ranges.length - 1 }, (_, i) =>
    sentences.slice(ranges[i], ranges[i + 1]).join(" ")
  );
}

/** Put shared story/editing LLM spend on part 1, where the series ledger lives. */
async function recordSeriesStoryCosts(reel: IReel, costs: MeasuredCostInput[], label: string): Promise<void> {
  if (!costs.length) return;
  const series = reel.seriesId ? sortSeriesReels(await listReelsBySeries(reel.seriesId)) : [reel];
  const ledger = series[0];
  applyMeasuredCostsToReel(ledger, costs, label);
  await ledger.save();
}

function makePartDraft(
  post: RedditPost,
  baseTitle: string,
  body: string,
  partNumber: number,
  partCount: number,
  discovery?: UpdateDiscovery,
  cardUsername?: string
): StoryPartDraft {
  return {
    title: partCount > 1 ? titleWithPart(baseTitle, partNumber) : baseTitle,
    body,
    source: "verbatim",
    subreddit: post.subreddit,
    author: post.author,
    cardUsername,
    upvotes: post.ups,
    comments: post.comments,
    ageHours: post.ageHours,
    seedTitle: post.title,
    seedUrl: post.url,
    partNumber,
    partCount,
    updateDiscovery: discovery,
  };
}

/**
 * Re-scan a reel's source post for the OP's followups/updates (and optionally
 * add a manual link). Refreshes the candidate list for Studio review WITHOUT
 * touching the body or parts — apply happens separately.
 */
export async function rescanReelUpdates(
  reelId: string,
  opts: { manualUrl?: string } = {}
): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertEditable(reel);
  if (reel.strategy !== "gameplay_overlay" || !reel.redditStory) {
    throw new Error("Updates are only available for Reddit gameplay reels");
  }
  const story = reel.redditStory;
  const existing = story.updateDiscovery ? payloadToDiscovery(story.updateDiscovery) : undefined;
  const priorManual = (existing?.candidates ?? []).filter((c) => c.kind === "manual");
  const costs: MeasuredCostInput[] = [];

  const manualUrl = opts.manualUrl?.trim();
  let discovery: UpdateDiscovery;
  if (story.seedUrl) {
    const post = await fetchPostByUrl(story.seedUrl);
    if (!post) throw new Error(`Could not re-fetch the source post: ${story.seedUrl}`);
    const manual = manualUrl ? await resolveManualUpdates([manualUrl], post) : [];
    if (manualUrl && manual.length === 0) throw new Error(`Could not resolve that Reddit link: ${manualUrl}`);
    discovery = await discoverStoryUpdates(post, {
      tier: reel.tier as Tier,
      existing: mergeCandidates(priorManual, manual),
      onLlmUsage: (usage) =>
        costs.push({ label: usage.label, model: usage.model, costUsd: usage.costUsd, source: "actual" }),
    });
  } else {
    // No source post (e.g. bank story) — only manual links can be added.
    const manual = manualUrl ? await resolveManualUpdates([manualUrl]) : [];
    if (manualUrl && manual.length === 0) throw new Error(`Could not resolve that Reddit link: ${manualUrl}`);
    const candidates = mergeCandidates(existing?.candidates ?? [], manual);
    discovery = { method: "signals", candidates, scannedAt: Date.now() };
  }

  // Preserve prior inclusions across the re-scan.
  const priorIncluded = new Set(story.updateDiscovery?.includedKeys ?? includedUpdateKeys(existing));
  for (const c of discovery.candidates) {
    if (priorIncluded.has(c.key) && c.decision !== "rejected") c.decision = "include";
  }

  const payload = discoveryToPayload(discovery, includedUpdateKeys(discovery));
  const relatedReels = reel.seriesId ? sortSeriesReels(await listReelsBySeries(reel.seriesId)) : [reel];
  const resolvedManualUrls = discovery.candidates
    .filter((candidate) => candidate.kind === "manual")
    .map((candidate) => candidate.url);
  for (const related of relatedReels) {
    if (!related.redditStory) continue;
    related.redditStory.updateDiscovery = payload;
    // Persist Studio-added manual links with this source so same-source replan
    // can reproduce them; replan explicitly drops them for a different seed.
    related.manualUpdateUrls = [...new Set([...(related.manualUpdateUrls ?? []), ...resolvedManualUrls])];
    related.markModified("redditStory");
    await related.save();
  }
  await recordSeriesStoryCosts(relatedReels[0], costs, "Update discovery");
  return loadReel(reelId);
}

/**
 * Fold the chosen updates into the story and recompute parts. "append" adds the
 * newly-included followups as new part(s) (existing parts untouched); "recut"
 * re-splits original + all included updates across the whole series.
 */
export async function applyReelUpdates(
  reelId: string,
  patch: { includedKeys: string[]; mode: "append" | "recut" }
): Promise<IReel> {
  const anchor = await loadReel(reelId);
  assertEditable(anchor);
  if (anchor.strategy !== "gameplay_overlay" || !anchor.redditStory) {
    throw new Error("Updates are only available for Reddit gameplay reels");
  }
  if (anchor.storySource && anchor.storySource !== "verbatim") {
    throw new Error(
      "Applying updates recomputes verbatim parts; for hybrid/llm reels use Re-plan to regenerate the story"
    );
  }
  const discoveryPayload = anchor.redditStory.updateDiscovery;
  if (!discoveryPayload) throw new Error("No discovered updates — run a scan first");
  const seedUrl = anchor.redditStory.seedUrl;
  if (!seedUrl) throw new Error("This story has no source URL to recompute from");

  const includeSet = new Set(patch.includedKeys);
  for (const candidate of discoveryPayload.candidates) {
    if (candidate.kind === "manual") includeSet.add(candidate.key);
  }
  const effectiveIncludedKeys = [...includeSet];
  const discovery = payloadToDiscovery(discoveryPayload);
  for (const c of discovery.candidates) {
    c.decision = includeSet.has(c.key)
      ? "include"
      : c.decision === "include"
        ? "candidate"
        : c.decision;
  }

  const original = await fetchPostByUrl(seedUrl);
  if (!original) throw new Error(`Could not re-fetch the source post: ${seedUrl}`);

  const seriesReels = anchor.seriesId
    ? sortSeriesReels(await listReelsBySeries(anchor.seriesId))
    : [anchor];
  for (const r of seriesReels) assertEditable(r);

  const priorIncluded = new Set(discoveryPayload.includedKeys ?? []);
  const removed = [...priorIncluded].some((k) => !includeSet.has(k));

  // Append only makes sense for an existing multi-part series with pure additions.
  if (patch.mode === "append" && seriesReels.length > 1 && !removed) {
    return appendUpdatesAsParts(anchor, seriesReels, original, discovery, effectiveIncludedKeys, priorIncluded);
  }
  return recutSeriesFromBody(anchor, seriesReels, original, discovery, effectiveIncludedKeys);
}

/** Rebuild the whole series from original + included updates (accurate re-cut). */
async function recutSeriesFromBody(
  anchor: IReel,
  seriesReels: IReel[],
  original: RedditPost,
  discovery: UpdateDiscovery,
  includedKeys: string[]
): Promise<IReel> {
  const baseTitle = anchor.redditStory?.seedTitle ?? original.title;
  const continuations = updatesToContinuations(discovery, includedKeys);
  const combined = combinePostWithContinuations(original, continuations);
  const body = cleanRedditBody(combined.body);

  // Keep at least the current episode count, but add parts if the combined story
  // (original + updates) is too long to fit ~2 min per reel.
  const targetParts = resolvePartCount(seriesReels.length, wordCount(body), { capLength: true });
  const costs: MeasuredCostInput[] = [];
  const bodies = await splitBodyIntoParts(baseTitle, body, targetParts, anchor.tier as Tier, (usage) =>
    costs.push({ label: usage.label, model: usage.model, costUsd: usage.costUsd, source: "actual" })
  );
  const partCount = bodies.length;
  const seriesId = partCount > 1 ? anchor.seriesId ?? randomUUID() : undefined;

  const drafts = bodies.map((partBody, i) =>
    makePartDraft(
      original,
      baseTitle,
      partBody,
      i + 1,
      partCount,
      discovery,
      anchor.redditStory?.cardUsername
    )
  );
  const rebuilt = await rebuildSeriesFromDrafts(anchor, seriesReels, drafts, seriesId);
  await recordSeriesStoryCosts(rebuilt, costs, "Update re-cut");
  return rebuilt;
}

/**
 * Overwrite a series' reels from a list of part drafts: reuse existing reels in
 * order (clearing their assets), clone new ones as needed, delete leftovers, and
 * re-enqueue the plan stage for each. Shared by re-cut and manual restructuring.
 */
async function rebuildSeriesFromDrafts(
  anchor: IReel,
  seriesReels: IReel[],
  drafts: StoryPartDraft[],
  seriesId: string | undefined
): Promise<IReel> {
  const partCount = drafts.length;
  const donorCover = seriesReels.map((part) => snapshotCreatorShortsCover(part)).find((cover) => cover?.imageUrl);
  const preservedCoverUrls = new Set(
    seriesReels
      .map((part) => snapshotCreatorShortsCover(part)?.imageUrl)
      .filter((url): url is string => Boolean(url))
  );
  if (donorCover?.imageUrl) preservedCoverUrls.add(donorCover.imageUrl);
  const staleMedia: string[] = [];
  const updated: IReel[] = [];
  for (let i = 0; i < drafts.length; i++) {
    const reel = seriesReels[i] ?? cloneSeriesReelFromAnchor(anchor, { partNumber: i + 1, partCount });
    if (seriesReels[i]) {
      staleMedia.push(...(await resetReelForReplan(reel)));
    }
    // After reset (or for brand-new parts), restore the series vertical cover.
    if (donorCover?.imageUrl && !reel.shortsCover?.imageUrl) {
      reel.shortsCover = { ...donorCover, updatedAt: new Date() };
      reel.markModified("shortsCover");
    }
    reel.title = drafts[i].title;
    reel.hook = drafts[i].title;
    reel.redditStory = redditPayloadFromStoryPart(drafts[i]);
    reel.markModified("redditStory");
    reel.seriesId = seriesId;
    reel.partNumber = i + 1;
    reel.partCount = partCount;
    reel.status = "planning";
    reel.progress = 5;
    reel.error = undefined;
    await reel.save();
    updated.push(reel);
    await removeReelJob(reel._id.toString());
    await enqueueReelPlan(reel._id.toString());
  }

  // Delete any parts beyond the new count. Strip shared vertical-cover URLs
  // first so reclaiming part 3 cannot delete the S3 object parts 1–2 still use.
  const keep = new Set(updated.map((r) => r._id.toString()));
  for (const reel of seriesReels) {
    if (keep.has(reel._id.toString())) continue;
    if (reel.shortsCover?.imageUrl && preservedCoverUrls.has(reel.shortsCover.imageUrl)) {
      reel.shortsCover = undefined;
      reel.markModified("shortsCover");
      await reel.save();
    }
    await deleteReel(reel._id.toString());
  }
  await deleteS3Urls(staleMedia.filter((url) => !preservedCoverUrls.has(url)));

  const returnId = keep.has(anchor._id.toString()) ? anchor._id.toString() : updated[0]._id.toString();
  return loadReel(returnId);
}

/**
 * Manually restructure a Reddit series into `parts` episodes — split a single
 * reel into several, add more parts, or re-balance — by concatenating the
 * current story across siblings and re-splitting. Works in plan_review or after
 * creation. Costs LLM cut-selection credits and re-plans each part.
 *
 * `honorRequested` applies an explicit AI/user part count as-is. Without it,
 * the length floor can bump e.g. "2 parts" back up to 3 and silently ignore
 * the choice the creator just confirmed.
 */
export async function restructureSeriesParts(
  reelId: string,
  parts: number | "auto",
  opts: { honorRequested?: boolean } = {}
): Promise<IReel> {
  const anchor = await loadReel(reelId);
  assertEditable(anchor);
  if (anchor.strategy !== "gameplay_overlay" || !anchor.redditStory) {
    throw new Error("Series restructuring is only supported for Reddit gameplay reels");
  }
  const seriesReels = anchor.seriesId
    ? sortSeriesReels(await listReelsBySeries(anchor.seriesId))
    : [anchor];
  for (const r of seriesReels) assertEditable(r);

  const card = anchor.redditStory;
  const baseTitle = card.seedTitle ?? card.title;
  // Prefer spoken scene text (same source as structure advice) so part math
  // matches what the AI recommendation UI just showed.
  const fullBody = seriesAssembledText(seriesReels, "spoken");
  if (!fullBody.trim()) throw new Error("No story text to restructure");

  const wordTotal = wordCount(fullBody);
  const targetParts =
    opts.honorRequested && typeof parts === "number"
      ? Math.max(1, Math.min(12, Math.round(parts)))
      : resolvePartCount(parts, wordTotal, { capLength: true });
  const costs: MeasuredCostInput[] = [];
  const bodies = await splitBodyIntoParts(baseTitle, fullBody, targetParts, anchor.tier as Tier, (usage) =>
    costs.push({ label: usage.label, model: usage.model, costUsd: usage.costUsd, source: "actual" })
  );
  const partCount = bodies.length;
  const seriesId = partCount > 1 ? anchor.seriesId ?? randomUUID() : undefined;

  // Reconstruct the card fields the drafts need (no re-fetch of the source post).
  const pseudo: RedditPost = {
    id: "",
    title: baseTitle,
    body: "",
    url: card.seedUrl ?? "",
    subreddit: card.subreddit ?? "",
    author: card.author ?? "",
    ups: card.upvotes ?? 0,
    comments: card.comments ?? 0,
    ageHours: card.ageHours ?? 0,
    createdUtc: 0,
  };
  const discovery = card.updateDiscovery ? payloadToDiscovery(card.updateDiscovery) : undefined;
  const drafts = bodies.map((b, i) =>
    makePartDraft(pseudo, baseTitle, b, i + 1, partCount, discovery, card.cardUsername)
  );
  const rebuilt = await rebuildSeriesFromDrafts(anchor, seriesReels, drafts, seriesId);
  await recordSeriesStoryCosts(rebuilt, costs, "Series restructure");
  return rebuilt;
}

/**
 * Assembled series text for structure fingerprinting.
 * Prefer spoken scene narration when present — produce syncs `redditStory.body`
 * from scenes, so body-only hashes go stale after part 1 renders.
 */
function seriesAssembledText(series: IReel[], mode: "body" | "spoken"): string {
  if (mode === "body") {
    return cleanRedditBody(series.map((part) => part.redditStory?.body ?? "").join(" "));
  }
  return cleanRedditBody(
    series
      .map((part) =>
        part.scenes?.length
          ? part.scenes.map((scene) => scene.narration.trim()).filter(Boolean).join(" ")
          : (part.redditStory?.body ?? "")
      )
      .join(" ")
  );
}

function hashStructureFingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Current canonical fingerprint (spoken/scenes when available). */
function canonicalStructureFingerprint(series: IReel[]): string {
  return hashStructureFingerprint(seriesAssembledText(series, "spoken"));
}

/** Accept either body-era or spoken-era fingerprints so older decisions still match. */
function structureContentFingerprints(series: IReel[]): string[] {
  const texts = [seriesAssembledText(series, "body"), seriesAssembledText(series, "spoken")];
  return [...new Set(texts.filter(Boolean).map((text) => hashStructureFingerprint(text)))];
}

function findSeriesStructureDecision(
  series: IReel[]
): NonNullable<IRedditStoryPayload["structureDecision"]> | undefined {
  for (const part of series) {
    const decision = part.redditStory?.structureDecision;
    if (decision?.choice === "recommended" || decision?.choice === "manual") {
      return decision;
    }
  }
  return undefined;
}

function findSeriesStructureAdvice(
  series: IReel[]
): NonNullable<IRedditStoryPayload["structureAdvice"]> | undefined {
  for (const part of series) {
    const advice = part.redditStory?.structureAdvice;
    if (advice?.fingerprint) return advice;
  }
  return undefined;
}

async function clearSeriesStructureDecision(series: IReel[]): Promise<void> {
  let changed = false;
  for (const part of series) {
    if (!part.redditStory?.structureDecision) continue;
    part.redditStory.structureDecision = undefined;
    part.markModified("redditStory");
    changed = true;
  }
  if (changed) await Promise.all(series.map((part) => part.save()));
}

/** Mirror advice/decision onto every part and refresh fingerprints after produce drift. */
async function mirrorSeriesStructureState(
  series: IReel[],
  advice: NonNullable<IRedditStoryPayload["structureAdvice"]> | undefined,
  decision: NonNullable<IRedditStoryPayload["structureDecision"]> | undefined,
  fingerprint: string
): Promise<void> {
  const persistedAdvice = advice ? { ...advice, fingerprint } : undefined;
  const persistedDecision = decision
    ? { fingerprint, choice: decision.choice, decidedAt: decision.decidedAt ?? new Date() }
    : undefined;
  await Promise.all(
    series.map(async (part) => {
      if (!part.redditStory) return;
      if (persistedAdvice) part.redditStory.structureAdvice = persistedAdvice;
      if (persistedDecision) part.redditStory.structureDecision = persistedDecision;
      part.markModified("redditStory");
      await part.save();
    })
  );
}

export type SeriesStructureAdviceResult = SeriesStructureAdvice & {
  currentParts: number;
  /** True when the creator already accepted Keep current / Use AI for this series. */
  decisionSatisfied: boolean;
};

/**
 * Paid, cached editorial advice for the current assembled story. It reads every
 * sibling body so an included follow-up/manual link is assessed as part of the
 * same narrative, not as an afterthought on the final episode.
 */
export async function getSeriesStructureAdvice(reelId: string): Promise<SeriesStructureAdviceResult> {
  const anchor = await loadReel(reelId);
  if (anchor.strategy !== "gameplay_overlay" || !anchor.redditStory) {
    throw new Error("Series advice is only supported for Reddit gameplay reels");
  }
  const seriesReels = anchor.seriesId
    ? sortSeriesReels(await listReelsBySeries(anchor.seriesId))
    : [anchor];
  const body = seriesAssembledText(seriesReels, "spoken");
  if (!body) throw new Error("No story text is available to assess");
  const ledgerReel = seriesReels[0];
  const fingerprint = canonicalStructureFingerprint(seriesReels);
  const acceptedFingerprints = new Set(structureContentFingerprints(seriesReels));
  const cached = findSeriesStructureAdvice(seriesReels);
  const existingDecision = findSeriesStructureDecision(seriesReels);

  // Cache hit when the hash still matches, OR when a Keep/Use-AI choice already
  // exists — produce sync can rewrite body from scenes and change the hash
  // without invalidating that editorial decision.
  if (cached && (acceptedFingerprints.has(cached.fingerprint) || existingDecision)) {
    await mirrorSeriesStructureState(seriesReels, cached, existingDecision, fingerprint);
    return {
      wordCount: cached.wordCount,
      sentenceCount: cached.sentenceCount,
      estimatedDurationSeconds: cached.estimatedDurationSeconds,
      minimumParts: cached.minimumParts,
      recommendedParts: cached.recommendedParts,
      reason: cached.reason,
      breaks: cached.breaks.map((item) => ({ ...item })),
      hasWeakBreaks: cached.hasWeakBreaks,
      currentParts: seriesReels.length,
      decisionSatisfied: Boolean(existingDecision),
    };
  }

  // Decision on file but advice missing from every part — honor the choice and
  // skip a paid re-assessment; Generate does not need the recommendation UI.
  if (existingDecision) {
    await mirrorSeriesStructureState(seriesReels, undefined, existingDecision, fingerprint);
    return {
      wordCount: wordCount(body),
      sentenceCount: 0,
      estimatedDurationSeconds: 0,
      minimumParts: 1,
      recommendedParts: seriesReels.length,
      reason: "Using your earlier series structure decision.",
      breaks: [],
      hasWeakBreaks: false,
      currentParts: seriesReels.length,
      decisionSatisfied: true,
    };
  }

  const costs: MeasuredCostInput[] = [];
  const advice = await assessVerbatimSeriesStructureWithAi(body, ledgerReel.tier as Tier, (usage) =>
    costs.push({ label: usage.label, model: usage.model, costUsd: usage.costUsd, source: "actual" })
  );
  const persistedAdvice = { fingerprint, ...advice, assessedAt: new Date() };
  for (const part of seriesReels) {
    if (!part.redditStory) continue;
    part.redditStory.structureAdvice = persistedAdvice;
    part.redditStory.structureDecision = undefined;
    part.markModified("redditStory");
  }
  // The assessment is a real OpenRouter LLM request, so record it immediately
  // on part 1 even though the series may still be awaiting plan approval.
  applyMeasuredCostsToReel(ledgerReel, costs, "Series structure assessment");
  await Promise.all(seriesReels.map((part) => part.save()));
  return {
    ...advice,
    currentParts: seriesReels.length,
    decisionSatisfied: false,
  };
}

type StructureChoice = "recommended" | "manual";

/** Record an explicit choice; the recommended choice can safely re-split first. */
export async function chooseSeriesStructure(reelId: string, choice: StructureChoice): Promise<IReel> {
  const anchor = await loadReel(reelId);
  assertEditable(anchor);
  if (anchor.strategy !== "gameplay_overlay" || !anchor.redditStory) {
    throw new Error("Series structure choices are only supported for Reddit gameplay reels");
  }
  const series = anchor.seriesId ? sortSeriesReels(await listReelsBySeries(anchor.seriesId)) : [anchor];
  const ledger = series[0];
  const fingerprint = canonicalStructureFingerprint(series);
  const acceptedFingerprints = new Set(structureContentFingerprints(series));
  const advice = findSeriesStructureAdvice(series) ?? ledger.redditStory?.structureAdvice;
  if (!advice || !acceptedFingerprints.has(advice.fingerprint)) {
    throw new Error("Run the AI structure assessment for the current story before choosing a plan");
  }

  let result = anchor;
  if (choice === "recommended" && advice.recommendedParts !== series.length) {
    // Honor the count shown in the confirm modal — do not let the length floor
    // silently bump "2 parts" back to 3 after the creator accepted the AI plan.
    result = await restructureSeriesParts(reelId, advice.recommendedParts, {
      honorRequested: true,
    });
  }

  const updatedSeries = result.seriesId ? sortSeriesReels(await listReelsBySeries(result.seriesId)) : [result];
  const updatedLedger = updatedSeries[0];
  if (!updatedLedger.redditStory) throw new Error("Story data disappeared while recording structure choice");
  const updatedFingerprint = canonicalStructureFingerprint(updatedSeries);
  const persistedAdvice = { ...advice, fingerprint: updatedFingerprint };
  const persistedDecision = { fingerprint: updatedFingerprint, choice, decidedAt: new Date() };
  await mirrorSeriesStructureState(updatedSeries, persistedAdvice, persistedDecision, updatedFingerprint);
  return loadReel(result._id.toString());
}

async function assertStructureChoice(reel: IReel): Promise<void> {
  if (reel.strategy !== "gameplay_overlay" || !reel.redditStory?.body) return;
  const series = reel.seriesId ? sortSeriesReels(await listReelsBySeries(reel.seriesId)) : [reel];
  const decision = findSeriesStructureDecision(series);
  if (!decision) {
    throw new Error(
      "Review series structure and accept the AI recommendation or keep your manual plan before generating"
    );
  }
  // A recorded Keep/Use-AI choice stays valid across produce-time body sync and
  // Part 2+ routes. Refresh fingerprints + mirror so siblings stay consistent.
  const fingerprint = canonicalStructureFingerprint(series);
  const advice = findSeriesStructureAdvice(series);
  await mirrorSeriesStructureState(series, advice, decision, fingerprint);
}

/** Append newly-included followups as new part(s); existing parts stay byte-stable. */
async function appendUpdatesAsParts(
  anchor: IReel,
  seriesReels: IReel[],
  original: RedditPost,
  discovery: UpdateDiscovery,
  includedKeys: string[],
  priorIncluded: Set<string>
): Promise<IReel> {
  const baseTitle = anchor.redditStory?.seedTitle ?? original.title;
  const newly = discovery.candidates.filter(
    (c) => includedKeys.includes(c.key) && !priorIncluded.has(c.key)
  );

  const seriesId = anchor.seriesId!;
  const oldCount = seriesReels.length;

  // Persist the shared review state on every episode, so it remains available
  // no matter which part the user opens in Studio.
  const discoveryPayload = discoveryToPayload(discovery, includedKeys);

  if (newly.length === 0) {
    for (const reel of seriesReels) {
      if (!reel.redditStory) continue;
      reel.redditStory.updateDiscovery = discoveryPayload;
      reel.markModified("redditStory");
      await reel.save();
    }
    return loadReel(anchor._id.toString());
  }

  // Build the appended body from the new candidates, split into 1..N episodes.
  const deltaBody = cleanRedditBody(
    newly
      .map((c) => `${c.title.toLowerCase().includes("update") ? c.title : "Update"}: ${c.body}`)
      .join("\n\n")
  );
  const addCount = resolvePartCount("auto", wordCount(deltaBody), { capLength: true });
  const costs: MeasuredCostInput[] = [];
  const bodies = await splitBodyIntoParts(baseTitle, deltaBody, addCount, anchor.tier as Tier, (usage) =>
    costs.push({ label: usage.label, model: usage.model, costUsd: usage.costUsd, source: "actual" })
  );
  const newCount = oldCount + bodies.length;

  // Bump partCount on every existing part (numbering) — no body/asset changes.
  // New episodes change series structure, so the prior Keep/Use-AI choice is void.
  for (const reel of seriesReels) {
    reel.partCount = newCount;
    if (reel.redditStory) {
      reel.redditStory.partCount = newCount;
      reel.redditStory.updateDiscovery = discoveryPayload;
      reel.redditStory.sourceSegment ??= "original";
      reel.redditStory.structureDecision = undefined;
      reel.markModified("redditStory");
    }
  }
  for (const reel of seriesReels) await reel.save();

  // Create the appended parts (each derives from a new followup segment).
  for (let j = 0; j < bodies.length; j++) {
    const partNumber = oldCount + j + 1;
    const draft = makePartDraft(
      original,
      baseTitle,
      bodies[j],
      partNumber,
      newCount,
      discovery,
      anchor.redditStory?.cardUsername
    );
    const reel = cloneSeriesReelFromAnchor(anchor, { partNumber, partCount: newCount });
    reel.seriesId = seriesId;
    reel.title = draft.title;
    reel.hook = draft.title;
    const payload = redditPayloadFromStoryPart(draft);
    payload.sourceSegment = newly[Math.min(j, newly.length - 1)].key;
    reel.redditStory = payload;
    reel.markModified("redditStory");
    reel.status = "planning";
    reel.progress = 5;
    await reel.save();
    await enqueueReelPlan(reel._id.toString());
  }

  const updated = await loadReel(anchor._id.toString());
  await recordSeriesStoryCosts(updated, costs, "Append updates");
  return updated;
}
