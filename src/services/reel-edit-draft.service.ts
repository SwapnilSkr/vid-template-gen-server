import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { config } from "../config";
import { resolveModels, resolveTtsChoice, type Tier } from "../config/models";
import { getRecipe } from "../config/niche-styles";
import { resolveArtStyleRefKeys } from "./art-style.service";
import { appendBouncingCaptionCues } from "./reel-gameplay.service";
import { renderMotionReel, type MotionScene } from "./reel-motion.service";
import {
  renderImageKenBurns,
  applyEditEffects,
  hasEditEffects,
  type RenderScene,
} from "./reel-render.service";
import {
  appendBrandedOutro,
  invalidateFinalDestinationRenders,
} from "./reel-outro.service";
import { generateImage, generateNarration } from "./openrouter-media.service";
import {
  applyMeasuredCostsToReel,
  type MeasuredCostInput,
} from "./reel-cost.service";
import {
  cdnUrlFor,
  downloadFromUrl,
  uploadAudio,
  uploadImage,
  uploadSubtitles,
  uploadVideo,
  deleteS3Urls,
} from "./s3.service";
import { Reel, type ICaptionStyle, type IEditDraftBaseline, type IReel } from "../models";
import { mergeCaptionStyle } from "../utils/caption-style.utils";
import {
  cleanupDirectory,
  cleanupFiles,
  cleanupRenderScratch,
  ensureDir,
} from "../utils";
import { assertFfmpegReady } from "./ffmpeg-capability.service";

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
    throw new Error(
      `Cannot edit while generation is active (status: ${reel.status})`,
    );
  }
}

function assertImageDraftEditable(reel: IReel): void {
  assertEditable(reel);
  if (reel.strategy === "gameplay_overlay") {
    throw new Error(
      "Draft editor previews are only supported for image reels right now",
    );
  }
}

function isHorrorNiche(niche: string): boolean {
  return niche.startsWith("horror");
}

function narrationForTts(text: string, niche: string): string {
  if (!isHorrorNiche(niche)) return text;
  return text
    .replace(/:\s+/g, "... ")
    .replace(/;\s+/g, "... ")
    .replace(/\s+/g, " ")
    .trim();
}

function narrationProfileFor(
  reel: IReel,
): "horror" | "whisper" | "phone" | "tape" | "distant" | undefined {
  if (!isHorrorNiche(reel.niche)) return undefined;
  const profile = reel.audioPost?.voiceProfile ?? "horror";
  return profile === "none" ? undefined : profile;
}

function localAssetUrl(draftId: string, filename: string): string {
  return `/api/reels/drafts/${encodeURIComponent(draftId)}/assets/${encodeURIComponent(filename)}`;
}

async function downloadAsset(url: string, targetPath: string): Promise<void> {
  try {
    await writeFile(targetPath, await downloadFromUrl(url));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not reuse generated asset: ${url} — ${message}`);
  }
}

async function loadReel(reelId: string): Promise<IReel> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  return reel;
}

function snapshotEditDraftBaseline(reel: IReel): IEditDraftBaseline {
  return {
    assemblyVideoUrl: reel.assemblyVideoUrl,
    bodyVideoUrl: reel.bodyVideoUrl,
    outroAudioUrl: reel.outroAudioUrl,
    outroAudioSignature: reel.outroAudioSignature,
    scenes: reel.scenes.map((scene) => ({
      index: scene.index,
      assetUrl: scene.assetUrl,
      audioUrl: scene.audioUrl,
    })),
  };
}

/** Collect `from` when it differs from `to` (superseded object). */
function pushReplaced(
  out: (string | undefined)[],
  from: string | undefined,
  to: string | undefined,
): void {
  if (from && from !== to) out.push(from);
}

/** Discard: restore pre-draft media and delete preview-only S3 uploads. */
async function restoreEditDraftBaseline(reel: IReel): Promise<void> {
  const baseline = reel.editDraft?.baseline;
  if (!baseline) return;

  const superseded: (string | undefined)[] = [];
  pushReplaced(superseded, reel.assemblyVideoUrl, baseline.assemblyVideoUrl);
  pushReplaced(superseded, reel.bodyVideoUrl, baseline.bodyVideoUrl);
  pushReplaced(superseded, reel.outroAudioUrl, baseline.outroAudioUrl);

  const priorByIndex = new Map(baseline.scenes.map((scene) => [scene.index, scene]));
  for (const scene of reel.scenes) {
    const prior = priorByIndex.get(scene.index);
    pushReplaced(superseded, scene.assetUrl, prior?.assetUrl);
    pushReplaced(superseded, scene.audioUrl, prior?.audioUrl);
    scene.assetUrl = prior?.assetUrl;
    scene.audioUrl = prior?.audioUrl;
  }

  reel.assemblyVideoUrl = baseline.assemblyVideoUrl;
  reel.bodyVideoUrl = baseline.bodyVideoUrl;
  reel.outroAudioUrl = baseline.outroAudioUrl;
  reel.outroAudioSignature = baseline.outroAudioSignature;
  reel.markModified("scenes");
  await deleteS3Urls(superseded);
}

/** Save: drop the pre-draft objects that preview replaced. */
async function deleteEditDraftBaseline(reel: IReel): Promise<void> {
  const baseline = reel.editDraft?.baseline;
  if (!baseline) return;

  const superseded: (string | undefined)[] = [];
  pushReplaced(superseded, baseline.assemblyVideoUrl, reel.assemblyVideoUrl);
  pushReplaced(superseded, baseline.bodyVideoUrl, reel.bodyVideoUrl);
  pushReplaced(superseded, baseline.outroAudioUrl, reel.outroAudioUrl);

  const currentByIndex = new Map(reel.scenes.map((scene) => [scene.index, scene]));
  for (const prior of baseline.scenes) {
    const scene = currentByIndex.get(prior.index);
    pushReplaced(superseded, prior.assetUrl, scene?.assetUrl);
    pushReplaced(superseded, prior.audioUrl, scene?.audioUrl);
  }
  await deleteS3Urls(superseded);
}

async function cleanupExistingDraft(
  reel: IReel,
  opts: { strict?: boolean; restore?: boolean } = {},
): Promise<void> {
  if (!reel.editDraft?.rootDir) return;
  // Default restore so Discard / replace-draft rolls back preview uploads.
  // Save passes restore:false after committing + deleting the baseline.
  if (opts.restore !== false) {
    await restoreEditDraftBaseline(reel);
  }
  const draftId = reel.editDraft.id;
  const rootDir = reel.editDraft.rootDir;
  try {
    await cleanupDirectory(rootDir);
  } catch (error: unknown) {
    console.error(`Could not clean edit draft ${draftId}:`, error);
    if (opts.strict) throw error;
  }
  reel.editDraft = undefined;
  reel.markModified("editDraft");
}

/** Upload staged draft outputs to S3, update the reel doc, and delete replaced
 *  objects so we do not rely on the 2h reconciliation sweep for every edit. */
async function commitRenderOutputs(
  reel: IReel,
  preview: {
    outputPath?: string;
    subtitlesPath?: string;
    sceneAssets: NonNullable<IReel["editDraft"]>["sceneAssets"];
  },
): Promise<string[]> {
  const reelKey = reel._id.toString();
  const superseded: string[] = [];

  for (const item of preview.sceneAssets) {
    const scene = reel.scenes[item.index];
    if (!scene) continue;
    if (item.assetPath) {
      if (scene.assetUrl) superseded.push(scene.assetUrl);
      scene.assetUrl = await uploadImage(
        await readFile(item.assetPath),
        "compositions",
        `${reelKey}_${item.index}.png`,
      );
    }
    if (item.audioPath) {
      if (scene.audioUrl) superseded.push(scene.audioUrl);
      scene.audioUrl = await uploadAudio(
        await readFile(item.audioPath),
        `${reelKey}_${item.index}.mp3`,
      );
    }
  }

  if (preview.outputPath) {
    if (reel.outputUrl) superseded.push(reel.outputUrl);
    reel.outputUrl = await uploadVideo(
      await readFile(preview.outputPath),
      "reels",
      `${reelKey}.mp4`,
    );
    // This draft has rebuilt the shared body and primary final. Any sibling
    // destination still points at the old body, so make it unpublishable until
    // the queued outro-only pass rebuilds its channel-specific final.
    superseded.push(
      ...invalidateFinalDestinationRenders(reel, {
        reason: "A studio image/caption draft rebuilt the shared body",
        includePrimary: false,
        includeExtras: true,
      }),
    );
  }

  if (preview.subtitlesPath) {
    reel.subtitlesUrl = await uploadSubtitles(
      await readFile(preview.subtitlesPath, "utf-8"),
      reelKey,
    );
  }

  reel.status = "completed";
  reel.progress = 100;
  reel.markModified("scenes");
  // Callers save the new references first, then delete these objects. That
  // ordering prevents a concurrent publish/read from observing a "ready" URL
  // which has already been deleted from S3.
  return [...new Set(superseded)];
}

export async function getDraftAssetPath(
  draftId: string,
  filename: string,
): Promise<string> {
  const reel = await Reel.findOne({ "editDraft.id": draftId });
  if (!reel?.editDraft) throw new Error("Draft not found");
  const root = reel.editDraft.rootDir;
  const allowed = new Set<string>();
  if (reel.editDraft.outputPath)
    allowed.add(basename(reel.editDraft.outputPath));
  if (reel.editDraft.subtitlesPath)
    allowed.add(basename(reel.editDraft.subtitlesPath));
  for (const item of reel.editDraft.sceneAssets) {
    if (item.assetPath) allowed.add(basename(item.assetPath));
    if (item.audioPath) allowed.add(basename(item.audioPath));
  }
  if (!allowed.has(filename)) throw new Error("Draft asset not found");
  const path = join(root, filename);
  // The referenced draft can be superseded (its files wiped) while the client
  // still polls the old URL. Verify on disk so the caller returns a clean 404
  // instead of Bun.file throwing ENOENT at stream time (a stack-trace flood).
  if (!(await Bun.file(path).exists()))
    throw new Error("Draft asset not available yet");
  return path;
}

/** Image-gen params for regenerating a still that a settings change cleared. */
async function resolveDraftImageGen(
  reel: IReel,
): Promise<{ model: string; referenceImageUrls?: string[] }> {
  const recipe = getRecipe(reel.niche);
  const model =
    reel.imageModelOverride || resolveModels(recipe.imageTier as Tier).image;
  const artRef = await resolveArtStyleRefKeys(reel.artStyleId);
  const referenceImageUrls = artRef?.keys.length
    ? artRef.keys.map(cdnUrlFor)
    : undefined;
  return { model, referenceImageUrls };
}

/** Copy a freshly generated asset into the draft dir and drop the temp source. */
async function stageGeneratedFile(
  srcPath: string,
  destPath: string,
): Promise<string> {
  try {
    await writeFile(destPath, await readFile(srcPath));
  } finally {
    await cleanupFiles([srcPath]);
  }
  return destPath;
}

async function buildDraftPreview(
  reel: IReel,
  draftId: string,
  rootDir: string,
  localFiles: string[],
  measuredCosts: MeasuredCostInput[] = [],
): Promise<{
  outputPath: string;
  subtitlesPath: string;
  sceneAssets: NonNullable<IReel["editDraft"]>["sceneAssets"];
}> {
  const recipe = getRecipe(reel.niche);
  const models = resolveModels(reel.tier as Tier);
  const tts = resolveTtsChoice(
    models.tts,
    recipe.voice ?? {},
    reel.voiceOverride ?? {},
  );
  const imagePaths: string[] = [];
  const audioPaths: string[] = [];
  const sceneAssets: NonNullable<IReel["editDraft"]>["sceneAssets"] = [];
  // Resolved lazily the first time a cleared still needs regenerating.
  let imageGen: { model: string; referenceImageUrls?: string[] } | undefined;
  const reelKey = reel._id.toString();
  let recovered = false;

  for (let i = 0; i < reel.scenes.length; i++) {
    const scene = reel.scenes[i];
    const draftScene = reel.editDraft?.sceneAssets.find(
      (item) => item.index === i,
    );
    let imagePath = draftScene?.assetPath;
    let audioPath = draftScene?.audioPath;

    if (!imagePath) {
      if (scene.assetUrl) {
        imagePath = join(rootDir, `scene_${i}_reused.png`);
        await downloadAsset(scene.assetUrl, imagePath);
      } else {
        // Still was cleared (art / image-model change) — regenerate and PERSIST
        // it to the scene now. The clearing was already committed, so this is a
        // recovery, not a draft experiment; persisting means later renders reuse
        // it instead of regenerating the whole reel on every pass.
        imageGen ??= await resolveDraftImageGen(reel);
        const resolvedImageGen = imageGen;
        const raw = await generateImage(
          scene.visualPrompt,
          reel.style,
          {
            ...resolvedImageGen,
            onUsage: (usage) => {
              measuredCosts.push({
                label: `Draft image ${i + 1}`,
                model: resolvedImageGen.model,
                costUsd: usage.costUsd,
                source: usage.costUsd !== undefined ? "actual" : "estimated",
              });
            },
          },
        );
        imagePath = await stageGeneratedFile(
          raw,
          join(rootDir, `scene_${i}_image.png`),
        );
        scene.assetUrl = await uploadImage(
          await readFile(imagePath),
          "compositions",
          `${reelKey}_${i}.png`,
        );
        recovered = true;
      }
    }
    if (!audioPath) {
      if (scene.audioUrl) {
        audioPath = join(rootDir, `scene_${i}_reused.mp3`);
        await downloadAsset(scene.audioUrl, audioPath);
      } else {
        // Narration was cleared (voice / voice-FX change) — regenerate with the
        // current voice + treatment and persist it, so later renders reuse it.
        const raw = await generateNarration(
          narrationForTts(scene.narration, reel.niche),
          {
            model: tts.model,
            voice: tts.voice,
            format: tts.format,
            profile: narrationProfileFor(reel),
            onUsage: (usage) => {
              measuredCosts.push({
                label: `Draft narration ${i + 1}`,
                model: `${tts.model}/${tts.voice}`,
                costUsd: usage.costUsd,
                source: usage.costUsd !== undefined ? "actual" : "estimated",
              });
            },
          },
        );
        audioPath = await stageGeneratedFile(
          raw.audioPath,
          join(rootDir, `scene_${i}_audio.mp3`),
        );
        scene.audioUrl = await uploadAudio(
          await readFile(audioPath),
          `${reelKey}_${i}.mp3`,
        );
        recovered = true;
      }
    }
    imagePaths[i] = imagePath;
    audioPaths[i] = audioPath;
    localFiles.push(imagePath, audioPath);
    // Only draft-override assets (scene regen) belong in the draft's sceneAssets;
    // recovered cleared assets are already committed to the scene above.
    sceneAssets.push({
      index: i,
      assetPath: draftScene?.assetPath,
      assetUrl: draftScene?.assetPath
        ? localAssetUrl(draftId, basename(draftScene.assetPath))
        : undefined,
      audioPath: draftScene?.audioPath,
      audioUrl: draftScene?.audioPath
        ? localAssetUrl(draftId, basename(draftScene.audioPath))
        : undefined,
    });
  }

  // Persist recovered stills/narration so a subsequent re-render reuses them
  // rather than regenerating the whole reel again.
  if (recovered) {
    reel.markModified("scenes");
    await reel.save();
  }

  const useMotion = reel.scenes.some(
    (s) => s.motion.type === "parallax" || s.motion.type === "ai_motion",
  );
  const result = useMotion
    ? await renderMotionReel(
        `draft_${draftId}`,
        reel.scenes.map(
          (s, i): MotionScene => ({
            imagePath: imagePaths[i],
            assetUrl: sceneAssets[i]?.assetUrl ?? s.assetUrl,
            audioPath: audioPaths[i],
            narration: s.narration,
            visualPrompt: s.visualPrompt,
            motion: s.motion,
          }),
        ),
        {
          videoModel: models.video,
          horrorEffects: isHorrorNiche(reel.niche),
          comicEffects: reel.niche === "horror_comic",
          horrorAudioKey: reel.horrorAudioKey,
          captionStyle: reel.captionStyle,
        },
      )
    : await renderImageKenBurns(
        `draft_${draftId}`,
        reel.scenes.map(
          (s, i): RenderScene => ({
            imagePath: imagePaths[i],
            audioPath: audioPaths[i],
            narration: s.narration,
            motion: s.motion,
          }),
        ),
        true,
        {
          horrorEffects: isHorrorNiche(reel.niche),
          comicEffects: reel.niche === "horror_comic",
          horrorAudioKey: reel.horrorAudioKey,
          captionStyle: reel.captionStyle,
        },
      );

  if (result.assemblyPath) {
    localFiles.push(result.assemblyPath);
    // Keep the previous assembly until Save/Discard so Discard can restore it.
    reel.assemblyVideoUrl = await uploadVideo(
      await readFile(result.assemblyPath),
      "reels",
      `${reelKey}_assembly.mp4`,
    );
  }

  let bodyPath = result.videoPath;
  if (hasEditEffects(reel.editEffects)) {
    const fxPath = join(rootDir, "preview_fx.mp4");
    await applyEditEffects(result.videoPath, fxPath, reel.editEffects);
    localFiles.push(result.videoPath, fxPath);
    bodyPath = fxPath;
  }

  reel.bodyVideoUrl = await uploadVideo(
    await readFile(bodyPath),
    "reels",
    `${reelKey}_body.mp4`,
  );

  const outroResult = await appendBrandedOutro(bodyPath, reel, tts);
  let finalVideoPath = bodyPath;
  if (outroResult) {
    localFiles.push(outroResult.videoPath);
    if (outroResult.outroAudioGenerated) {
      localFiles.push(outroResult.outroAudioPath);
      reel.outroAudioUrl = await uploadAudio(
        await readFile(outroResult.outroAudioPath),
        `${reelKey}_outro.mp3`,
      );
    }
    reel.outroAudioSignature = outroResult.outroAudioSignature;
    finalVideoPath = outroResult.videoPath;
    if (outroResult.subtitle) {
      await appendBouncingCaptionCues(result.assPath, [outroResult.subtitle]);
    }
  } else if (reel.skipBrandedOutro && reel.outroAudioUrl) {
    // Baseline still holds the prior outro audio for Discard restore.
    reel.outroAudioUrl = undefined;
    reel.outroAudioSignature = undefined;
  }

  const outputPath = join(rootDir, "preview.mp4");
  const subtitlesPath = join(rootDir, "preview.ass");
  await writeFile(outputPath, await readFile(finalVideoPath));
  await writeFile(subtitlesPath, await readFile(result.assPath));
  localFiles.push(finalVideoPath, result.assPath);

  result.scenes.forEach((t, i) => {
    reel.scenes[i].startTime = t.startTime;
    reel.scenes[i].duration = t.duration;
  });
  reel.markModified("scenes");

  return { outputPath, subtitlesPath, sceneAssets };
}

export async function createSceneEditDraft(
  reelId: string,
  index: number,
  targets: ("image" | "audio")[],
): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertImageDraftEditable(reel);
  if (!reel.scenes[index]) throw new Error(`Scene ${index} not found`);

  await cleanupExistingDraft(reel, { strict: true });
  const draftId = randomUUID();
  const rootDir = join(config.processingPath, "edit-drafts", reelId, draftId);
  await ensureDir(rootDir);
  reel.editDraft = {
    id: draftId,
    kind: "scene_regen",
    status: "ready",
    rootDir,
    createdAt: new Date(),
    sceneAssets: [],
    baseline: snapshotEditDraftBaseline(reel),
  };

  const localFiles: string[] = [];
  const measuredCosts: MeasuredCostInput[] = [];
  try {
    const recipe = getRecipe(reel.niche);
    const models = resolveModels(reel.tier as Tier);
    const imageModel =
      reel.imageModelOverride || resolveModels(recipe.imageTier as Tier).image;
    const tts = resolveTtsChoice(
      models.tts,
      recipe.voice ?? {},
      reel.voiceOverride ?? {},
    );
    const artRef = await resolveArtStyleRefKeys(reel.artStyleId);
    const referenceImageUrls = artRef?.keys.length
      ? artRef.keys.map(cdnUrlFor)
      : undefined;
    const scene = reel.scenes[index];
    const draftScene: NonNullable<IReel["editDraft"]>["sceneAssets"][number] = {
      index,
    };

    if (targets.includes("image")) {
      const imagePath = await generateImage(scene.visualPrompt, reel.style, {
        model: imageModel,
        referenceImageUrls,
        onUsage: (usage) => {
          measuredCosts.push({
            label: `Draft image ${index + 1}`,
            model: imageModel,
            costUsd: usage.costUsd,
            source: usage.costUsd !== undefined ? "actual" : "estimated",
          });
        },
      });
      localFiles.push(imagePath);
      const stagedPath = join(rootDir, `scene_${index}_image.png`);
      await writeFile(stagedPath, await readFile(imagePath));
      await cleanupFiles([imagePath]);
      draftScene.assetPath = stagedPath;
      draftScene.assetUrl = localAssetUrl(draftId, basename(stagedPath));
    }

    if (targets.includes("audio")) {
      const { audioPath } = await generateNarration(
        narrationForTts(scene.narration, reel.niche),
        {
          model: tts.model,
          voice: tts.voice,
          format: tts.format,
          profile: narrationProfileFor(reel),
          onUsage: (usage) => {
            measuredCosts.push({
              label: `Draft narration ${index + 1}`,
              model: `${tts.model}/${tts.voice}`,
              costUsd: usage.costUsd,
              source: usage.costUsd !== undefined ? "actual" : "estimated",
            });
          },
        },
      );
      localFiles.push(audioPath);
      const stagedPath = join(rootDir, `scene_${index}_audio.mp3`);
      await writeFile(stagedPath, await readFile(audioPath));
      await cleanupFiles([audioPath]);
      draftScene.audioPath = stagedPath;
      draftScene.audioUrl = localAssetUrl(draftId, basename(stagedPath));
    }

    reel.editDraft.sceneAssets = [draftScene];
    const preview = await buildDraftPreview(reel, draftId, rootDir, localFiles, measuredCosts);
    reel.editDraft.sceneAssets = preview.sceneAssets.filter(
      (item) => item.assetPath || item.audioPath,
    );
    reel.editDraft.outputPath = preview.outputPath;
    reel.editDraft.outputUrl = localAssetUrl(
      draftId,
      basename(preview.outputPath),
    );
    reel.editDraft.subtitlesPath = preview.subtitlesPath;
    reel.editDraft.subtitlesUrl = localAssetUrl(
      draftId,
      basename(preview.subtitlesPath),
    );
    applyMeasuredCostsToReel(reel, measuredCosts, "Studio draft");
    await reel.save();
    await cleanupFiles(localFiles.filter((path) => !path.startsWith(rootDir)));
    await cleanupRenderScratch(`draft_${draftId}`);
    return reel;
  } catch (error) {
    await cleanupFiles(localFiles.filter((path) => !path.startsWith(rootDir)));
    await cleanupDirectory(rootDir).catch(() => {});
    await cleanupRenderScratch(`draft_${draftId}`);
    throw error;
  }
}

export async function createReelEditDraft(
  reelId: string,
  mode: "render_only" | "assets" | "outro_only" | "composite_only",
): Promise<IReel> {
  const reel = await loadReel(reelId);
  // Cheap intents always go through the produce queue.
  if (mode === "outro_only" || mode === "composite_only") {
    const { regenerateReel } = await import("./reel-edit.service");
    return regenerateReel(reelId, mode);
  }
  // Gameplay has no local image draft — queue produce (reuse cached TTS when present).
  if (reel.strategy === "gameplay_overlay") {
    const { regenerateReel } = await import("./reel-edit.service");
    // Visual-only / caption re-renders with a full narration cache → composite_only.
    if (
      mode === "render_only" &&
      reel.titleAudioUrl &&
      reel.scenes.length > 0 &&
      reel.scenes.every((s) => Boolean(s.audioUrl))
    ) {
      return regenerateReel(reelId, "composite_only");
    }
    return regenerateReel(reelId, mode);
  }
  // Horror/image: caption/FX re-render from assembly cache skips Ken Burns.
  if (mode === "render_only" && reel.assemblyVideoUrl) {
    const { regenerateReel } = await import("./reel-edit.service");
    return regenerateReel(reelId, "composite_only");
  }
  assertFfmpegReady("Re-render");
  assertImageDraftEditable(reel);
  if (reel.scenes.length === 0)
    throw new Error("Nothing to regenerate — plan the reel first");

  await cleanupExistingDraft(reel, { strict: true });
  const draftId = randomUUID();
  const rootDir = join(config.processingPath, "edit-drafts", reelId, draftId);
  await ensureDir(rootDir);
  reel.editDraft = {
    id: draftId,
    kind: mode === "assets" ? "scene_regen" : "render_only",
    status: "ready",
    rootDir,
    createdAt: new Date(),
    sceneAssets: [],
    baseline: snapshotEditDraftBaseline(reel),
  };

  const localFiles: string[] = [];
  const measuredCosts: MeasuredCostInput[] = [];
  try {
    if (mode === "assets") {
      const recipe = getRecipe(reel.niche);
      const models = resolveModels(reel.tier as Tier);
      const imageModel =
        reel.imageModelOverride ||
        resolveModels(recipe.imageTier as Tier).image;
      const tts = resolveTtsChoice(
        models.tts,
        recipe.voice ?? {},
        reel.voiceOverride ?? {},
      );
      const artRef = await resolveArtStyleRefKeys(reel.artStyleId);
      const referenceImageUrls = artRef?.keys.length
        ? artRef.keys.map(cdnUrlFor)
        : undefined;

      for (let i = 0; i < reel.scenes.length; i++) {
        const scene = reel.scenes[i];
        const draftScene: NonNullable<
          IReel["editDraft"]
        >["sceneAssets"][number] = { index: i };
        if (!scene.isHero) {
          const imagePath = await generateImage(
            scene.visualPrompt,
            reel.style,
            {
              model: imageModel,
              referenceImageUrls,
              onUsage: (usage) => {
                measuredCosts.push({
                  label: `Draft image ${i + 1}`,
                  model: imageModel,
                  costUsd: usage.costUsd,
                  source: usage.costUsd !== undefined ? "actual" : "estimated",
                });
              },
            },
          );
          localFiles.push(imagePath);
          const stagedImagePath = join(rootDir, `scene_${i}_image.png`);
          await writeFile(stagedImagePath, await readFile(imagePath));
          await cleanupFiles([imagePath]);
          draftScene.assetPath = stagedImagePath;
          draftScene.assetUrl = localAssetUrl(
            draftId,
            basename(stagedImagePath),
          );
        }

        const { audioPath } = await generateNarration(
          narrationForTts(scene.narration, reel.niche),
          {
            model: tts.model,
            voice: tts.voice,
            format: tts.format,
            profile: narrationProfileFor(reel),
            onUsage: (usage) => {
              measuredCosts.push({
                label: `Draft narration ${i + 1}`,
                model: `${tts.model}/${tts.voice}`,
                costUsd: usage.costUsd,
                source: usage.costUsd !== undefined ? "actual" : "estimated",
              });
            },
          },
        );
        localFiles.push(audioPath);
        const stagedAudioPath = join(rootDir, `scene_${i}_audio.mp3`);
        await writeFile(stagedAudioPath, await readFile(audioPath));
        await cleanupFiles([audioPath]);
        draftScene.audioPath = stagedAudioPath;
        draftScene.audioUrl = localAssetUrl(draftId, basename(stagedAudioPath));
        reel.editDraft.sceneAssets.push(draftScene);
      }
    }

    const preview = await buildDraftPreview(reel, draftId, rootDir, localFiles, measuredCosts);
    reel.editDraft.sceneAssets = preview.sceneAssets.filter(
      (item) => item.assetPath || item.audioPath,
    );
    reel.editDraft.outputPath = preview.outputPath;
    reel.editDraft.outputUrl = localAssetUrl(
      draftId,
      basename(preview.outputPath),
    );
    reel.editDraft.subtitlesPath = preview.subtitlesPath;
    reel.editDraft.subtitlesUrl = localAssetUrl(
      draftId,
      basename(preview.subtitlesPath),
    );
    applyMeasuredCostsToReel(reel, measuredCosts, "Studio draft");
    await reel.save();
    await cleanupFiles(localFiles.filter((path) => !path.startsWith(rootDir)));
    await cleanupRenderScratch(`draft_${draftId}`);
    return reel;
  } catch (error) {
    await cleanupFiles(localFiles.filter((path) => !path.startsWith(rootDir)));
    await cleanupDirectory(rootDir).catch(() => {});
    await cleanupRenderScratch(`draft_${draftId}`);
    throw error;
  }
}

export async function saveEditDraft(reelId: string): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertImageDraftEditable(reel);
  const draft = reel.editDraft;
  if (!draft?.outputPath || !draft.subtitlesPath) {
    throw new Error("No pending edit draft to save");
  }

  const superseded = await commitRenderOutputs(reel, {
    outputPath: draft.outputPath,
    subtitlesPath: draft.subtitlesPath,
    sceneAssets: draft.sceneAssets,
  });
  await deleteEditDraftBaseline(reel);
  await cleanupExistingDraft(reel, { strict: true, restore: false });
  await cleanupRenderScratch(`draft_${draft.id}`);
  await reel.save();
  await deleteS3Urls(superseded);
  if ((reel.destinations ?? []).length) {
    const { regenerateReel } = await import("./reel-edit.service");
    return regenerateReel(reelId, "outro_only");
  }
  return reel;
}

/** Persist caption style, re-render locally, upload to S3, and delete the
 *  previous output video — no intermediate editDraft for the client to save.
 *  Uses assembly/narration caches when present (composite_only / gameplay). */
export async function applyCaptionsAndRender(
  reelId: string,
  patch: ICaptionStyle,
): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertEditable(reel);
  if (!reel.scenes.length)
    throw new Error("Nothing to render — plan the reel first");

  reel.captionStyle = mergeCaptionStyle(reel.captionStyle, patch);
  reel.markModified("captionStyle");
  // Captions are burned into body; assembly stays reusable.
  const staleBody = [
    reel.bodyVideoUrl,
    ...invalidateFinalDestinationRenders(reel, {
      reason: "Captions changed",
    }),
  ];
  reel.bodyVideoUrl = undefined;
  await reel.save();
  await deleteS3Urls(staleBody);

  const { regenerateReel } = await import("./reel-edit.service");
  if (reel.strategy === "gameplay_overlay") {
    const cacheReady =
      Boolean(reel.titleAudioUrl) &&
      reel.scenes.length > 0 &&
      reel.scenes.every((s) => Boolean(s.audioUrl));
    return regenerateReel(
      reelId,
      cacheReady ? "composite_only" : "render_only",
    );
  }
  if (reel.assemblyVideoUrl) {
    return regenerateReel(reelId, "composite_only");
  }

  assertFfmpegReady("Apply captions");
  await cleanupExistingDraft(reel, { strict: true });
  const draftId = randomUUID();
  const rootDir = join(config.processingPath, "edit-drafts", reelId, draftId);
  await ensureDir(rootDir);

  const localFiles: string[] = [];
  const measuredCosts: MeasuredCostInput[] = [];
  try {
    const preview = await buildDraftPreview(reel, draftId, rootDir, localFiles, measuredCosts);
    const superseded = await commitRenderOutputs(reel, preview);
    applyMeasuredCostsToReel(reel, measuredCosts, "Studio draft");
    await reel.save();
    await deleteS3Urls(superseded);
    if ((reel.destinations ?? []).length) {
      const { regenerateReel } = await import("./reel-edit.service");
      return regenerateReel(reelId, "outro_only");
    }
    return reel;
  } finally {
    await cleanupDirectory(rootDir).catch(() => {});
    await cleanupFiles(localFiles.filter((path) => !path.startsWith(rootDir)));
    await cleanupRenderScratch(`draft_${draftId}`);
  }
}

export async function discardEditDraft(reelId: string): Promise<IReel> {
  const reel = await loadReel(reelId);
  const draftId = reel.editDraft?.id;
  await cleanupExistingDraft(reel, { strict: true });
  if (draftId) await cleanupRenderScratch(`draft_${draftId}`);
  await reel.save();
  return reel;
}
