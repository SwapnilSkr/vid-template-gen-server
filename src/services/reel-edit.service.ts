import { randomUUID } from "node:crypto";
import {
  Reel,
  type IReel,
  type ICaptionStyle,
  type IAudioPost,
  type IEditEffects,
  type ISceneMotion,
  type ReelMotionMode,
  type IRedditStoryPayload,
} from "../models";
import { mergeCaptionStyle } from "../utils/caption-style.utils";
import { enqueueReelPlan, enqueueReelProduce, removeReelJob } from "../queue/queues";
import {
  syncRedditBodyFromScenes,
  redditPayloadFromStoryDraft,
  redditPayloadFromStoryPart,
  listReelsBySeries,
  deleteReel,
  collectReelS3AssetUrls,
  cleanupReelLocalStaging,
} from "./reel.service";
import { assertFfmpegReady } from "./ffmpeg-capability.service";
import { deleteS3Urls } from "./s3.service";
import {
  generateStorySeries,
  loadAndReserveBankStory,
  markStoryReel,
  materializeFromSeed,
} from "./story.service";
import type { StorySource } from "../models";
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

function sceneMediaUrls(reel: IReel): (string | undefined)[] {
  return reel.scenes.flatMap((scene) => [scene.assetUrl, scene.audioUrl]);
}

/** Clear cached render artifacts that are invalidated by body/composite changes. */
async function clearBodyVideoCache(reel: IReel): Promise<void> {
  const stale = reel.bodyVideoUrl;
  await Reel.updateOne({ _id: reel._id }, { $unset: { bodyVideoUrl: "" } });
  await deleteS3Urls([stale]);
}

/** Clear pre-caption assembly (scene/stills/audio/motion changes). */
async function clearAssemblyCache(reel: IReel): Promise<void> {
  const stale = [reel.assemblyVideoUrl, reel.bodyVideoUrl];
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
  ];
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
  await reel.save();
  // Card is burned into the body video; title audio only invalidates when spoken.
  // Gameplay has no assemblyVideoUrl — clearing body is enough for composite rebuild.
  const stale = [reel.bodyVideoUrl, titleChanged ? reel.titleAudioUrl : undefined];
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
    outro?: IReel["outro"];
    skipPartOutro?: boolean;
    skipBrandedOutro?: boolean;
    voice?: { model?: string; voice?: string; format?: "mp3" | "pcm" };
    audioPost?: IAudioPost;
    editEffects?: IEditEffects;
  }
): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertEditable(reel);
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
  if (patch.gameplayKey !== undefined) reel.gameplayKey = patch.gameplayKey || undefined;
  const prevOutroChannel = reel.outroChannelId;
  const prevSpokenLine = reel.outro?.spokenLine;
  const prevOutroChannelName = reel.outro?.channelName;
  if (patch.outroChannelId !== undefined) reel.outroChannelId = patch.outroChannelId || undefined;
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
  if (patch.motionMode !== undefined) {
    reel.motionMode = patch.motionMode;
    reel.scenes.forEach((scene, i) => {
      scene.motion = { ...scene.motion, type: motionTypeFor(patch.motionMode!, i, reel.scenes.length) };
    });
    reel.markModified("scenes");
  }
  await reel.save();

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
    (patch.outro !== undefined &&
      (patch.outro.spokenLine !== prevSpokenLine ||
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
    s3Delete.push(
      ...prevSceneAudios,
      prevTitleAudioUrl,
      prevPartOutroAudioUrl,
      prevOutroAudioUrl
    );
  } else if (clearsOutroAudio) {
    unset.outroAudioUrl = "";
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
    s3Delete.push(prevOutroAudioUrl);
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
  await markQueued(reelId);
  await enqueueReelProduce(reelId);
  return loadReel(reelId);
}

/** Wipe scenes/plan state before attaching a new story. Returns stale S3 URLs. */
async function resetReelForReplan(reel: IReel): Promise<string[]> {
  const staleMedia = collectReelS3AssetUrls(reel);
  await cleanupReelLocalStaging(reel);

  reel.scenes = [];
  reel.title = undefined;
  reel.hook = undefined;
  reel.outputUrl = undefined;
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
  if (reel.review?.thumbnailUrl) {
    reel.review.thumbnailUrl = undefined;
    reel.markModified("review");
  }
  if (reel.shortsCover?.imageUrl) {
    reel.shortsCover.imageUrl = undefined;
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
    return source === "verbatim" ? "auto" : undefined;
  }
  return parts;
}

function defaultSeriesParts(reel: IReel): "off" | "auto" | number {
  if (reel.partCount && reel.partCount > 1) return reel.partCount;
  return "auto";
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
    outro: anchor.outro,
    thumbnailMode: anchor.thumbnailMode,
    imageModelOverride: anchor.imageModelOverride,
    voiceOverride: anchor.voiceOverride,
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

  const plannedParts = await generateStorySeries(source, {
    genre: anchor.genre,
    tier: anchor.tier as Tier,
    parts: generateParts,
    selectedStoryId: patch.selectedStoryId,
    selectedSeedUrl: patch.selectedSeedUrl,
    excludeReelIds,
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

  if (reel.strategy === "gameplay_overlay") {
    const source = (reel.storySource ?? "llm") as StorySource;
    if (patch.selectedStoryId) {
      const story = await loadAndReserveBankStory(patch.selectedStoryId);
      reel.redditStory = redditPayloadFromStoryDraft(story);
      reel.title = story.title;
      reel.hook = story.title;
      reel.genre = story.genre ?? reel.genre;
      reel.markModified("redditStory");
      await markStoryReel(story.storyId, reelId);
    } else if (patch.selectedSeedUrl) {
      const deferHybrid = source === "hybrid";
      const story = await materializeFromSeed(patch.selectedSeedUrl, source, reel.genre, reel.tier as Tier, {
        seedOnly: deferHybrid,
        excludeReelId: reelId,
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
  await deleteS3Urls(staleMedia);
  await removeReelJob(reelId);
  await enqueueReelPlan(reelId);
  return loadReel(reelId);
}
