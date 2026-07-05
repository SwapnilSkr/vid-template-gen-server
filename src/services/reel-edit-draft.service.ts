import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { config } from "../config";
import { resolveModels, resolveTtsChoice, type Tier } from "../config/models";
import { getRecipe } from "../config/niche-styles";
import { resolveArtStyleRefKeys } from "./art-style.service";
import { appendBouncingCaptionCues, renderGameplayReel } from "./reel-gameplay.service";
import { renderMotionReel, type MotionScene } from "./reel-motion.service";
import { renderImageKenBurns, applyEditEffects, hasEditEffects, type RenderScene } from "./reel-render.service";
import { appendBrandedOutro } from "./reel-outro.service";
import { generateImage, generateNarration } from "./openrouter-media.service";
import { cdnUrlFor, uploadAudio, uploadImage, uploadSubtitles, uploadVideo } from "./s3.service";
import { Reel, type ICaptionStyle, type IReel } from "../models";
import { mergeCaptionStyle } from "../utils/caption-style.utils";
import { deleteFromS3 } from "./s3.service";
import { cleanupDirectory, cleanupFiles, cleanupRenderScratch, ensureDir } from "../utils";

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
  if (reel.strategy === "gameplay_overlay") {
    throw new Error("Draft editor previews are only supported for image reels right now");
  }
}

function isHorrorNiche(niche: string): boolean {
  return niche.startsWith("horror");
}

function narrationForTts(text: string, niche: string): string {
  if (!isHorrorNiche(niche)) return text;
  return text.replace(/:\s+/g, "... ").replace(/;\s+/g, "... ").replace(/\s+/g, " ").trim();
}

function narrationProfileFor(reel: IReel): "horror" | "whisper" | "phone" | "tape" | "distant" | undefined {
  if (!isHorrorNiche(reel.niche)) return undefined;
  const profile = reel.audioPost?.voiceProfile ?? "horror";
  return profile === "none" ? undefined : profile;
}

function localAssetUrl(draftId: string, filename: string): string {
  return `/api/reels/drafts/${encodeURIComponent(draftId)}/assets/${encodeURIComponent(filename)}`;
}

async function downloadAsset(url: string, targetPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not reuse generated asset (${res.status}): ${url}`);
  await writeFile(targetPath, Buffer.from(await res.arrayBuffer()));
}

async function loadReel(reelId: string): Promise<IReel> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  return reel;
}

async function cleanupExistingDraft(reel: IReel): Promise<void> {
  if (!reel.editDraft?.rootDir) return;
  await cleanupDirectory(reel.editDraft.rootDir).catch((error: unknown) => {
    console.error(`Could not clean edit draft ${reel.editDraft?.id}:`, error);
  });
  reel.editDraft = undefined;
  reel.markModified("editDraft");
}

async function deleteSupersededUrls(urls: (string | undefined)[]): Promise<void> {
  const unique = [...new Set(urls.filter((url): url is string => Boolean(url)))];
  await Promise.all(unique.map((url) => deleteFromS3(url).catch(() => {})));
}

/** Upload staged draft outputs to S3, update the reel doc, and delete replaced
 *  objects so we do not rely on the 2h reconciliation sweep for every edit. */
async function commitRenderOutputs(
  reel: IReel,
  preview: {
    outputPath?: string;
    subtitlesPath?: string;
    sceneAssets: NonNullable<IReel["editDraft"]>["sceneAssets"];
  }
): Promise<void> {
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
        `${reelKey}_${item.index}.png`
      );
    }
    if (item.audioPath) {
      if (scene.audioUrl) superseded.push(scene.audioUrl);
      scene.audioUrl = await uploadAudio(
        await readFile(item.audioPath),
        `${reelKey}_${item.index}.mp3`
      );
    }
  }

  if (preview.outputPath) {
    if (reel.outputUrl) superseded.push(reel.outputUrl);
    reel.outputUrl = await uploadVideo(
      await readFile(preview.outputPath),
      "reels",
      `${reelKey}.mp4`
    );
  }

  if (preview.subtitlesPath) {
    reel.subtitlesUrl = await uploadSubtitles(
      await readFile(preview.subtitlesPath, "utf-8"),
      reelKey
    );
  }

  reel.status = "completed";
  reel.progress = 100;
  reel.markModified("scenes");
  await deleteSupersededUrls(superseded);
}

export async function getDraftAssetPath(draftId: string, filename: string): Promise<string> {
  const reel = await Reel.findOne({ "editDraft.id": draftId });
  if (!reel?.editDraft) throw new Error("Draft not found");
  const root = reel.editDraft.rootDir;
  const allowed = new Set<string>();
  if (reel.editDraft.outputPath) allowed.add(basename(reel.editDraft.outputPath));
  if (reel.editDraft.subtitlesPath) allowed.add(basename(reel.editDraft.subtitlesPath));
  for (const item of reel.editDraft.sceneAssets) {
    if (item.assetPath) allowed.add(basename(item.assetPath));
    if (item.audioPath) allowed.add(basename(item.audioPath));
  }
  if (!allowed.has(filename)) throw new Error("Draft asset not found");
  return join(root, filename);
}

async function buildDraftPreview(
  reel: IReel,
  draftId: string,
  rootDir: string,
  localFiles: string[]
): Promise<{ outputPath: string; subtitlesPath: string; sceneAssets: NonNullable<IReel["editDraft"]>["sceneAssets"] }> {
  const recipe = getRecipe(reel.niche);
  const models = resolveModels(reel.tier as Tier);
  const tts = resolveTtsChoice(models.tts, recipe.voice ?? {}, reel.voiceOverride ?? {});
  const imagePaths: string[] = [];
  const audioPaths: string[] = [];
  const sceneAssets: NonNullable<IReel["editDraft"]>["sceneAssets"] = [];

  for (let i = 0; i < reel.scenes.length; i++) {
    const scene = reel.scenes[i];
    const draftScene = reel.editDraft?.sceneAssets.find((item) => item.index === i);
    let imagePath = draftScene?.assetPath;
    let audioPath = draftScene?.audioPath;

    if (!imagePath) {
      if (!scene.assetUrl) throw new Error(`Scene ${i + 1} has no image to render`);
      imagePath = join(rootDir, `scene_${i}_reused.png`);
      await downloadAsset(scene.assetUrl, imagePath);
    }
    if (!audioPath) {
      if (!scene.audioUrl) throw new Error(`Scene ${i + 1} has no narration to render`);
      audioPath = join(rootDir, `scene_${i}_reused.mp3`);
      await downloadAsset(scene.audioUrl, audioPath);
    }
    imagePaths[i] = imagePath;
    audioPaths[i] = audioPath;
    localFiles.push(imagePath, audioPath);
    sceneAssets.push({
      index: i,
      assetPath: draftScene?.assetPath,
      assetUrl: draftScene?.assetPath ? localAssetUrl(draftId, basename(draftScene.assetPath)) : undefined,
      audioPath: draftScene?.audioPath,
      audioUrl: draftScene?.audioPath ? localAssetUrl(draftId, basename(draftScene.audioPath)) : undefined,
    });
  }

  const useMotion = reel.scenes.some((s) => s.motion.type === "parallax" || s.motion.type === "ai_motion");
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
          })
        ),
        {
          videoModel: models.video,
          horrorEffects: isHorrorNiche(reel.niche),
          comicEffects: reel.niche === "horror_comic",
          horrorAudioKey: reel.horrorAudioKey,
          captionStyle: reel.captionStyle,
        }
      )
    : await renderImageKenBurns(
        `draft_${draftId}`,
        reel.scenes.map(
          (s, i): RenderScene => ({
            imagePath: imagePaths[i],
            audioPath: audioPaths[i],
            narration: s.narration,
            motion: s.motion,
          })
        ),
        true,
        {
          horrorEffects: isHorrorNiche(reel.niche),
          comicEffects: reel.niche === "horror_comic",
          horrorAudioKey: reel.horrorAudioKey,
          captionStyle: reel.captionStyle,
        }
      );

  if (hasEditEffects(reel.editEffects)) {
    const fxPath = join(rootDir, "preview_fx.mp4");
    await applyEditEffects(result.videoPath, fxPath, reel.editEffects);
    localFiles.push(result.videoPath, fxPath);
    result.videoPath = fxPath;
  }

  const outroResult = await appendBrandedOutro(result.videoPath, reel, tts);
  if (outroResult) {
    localFiles.push(result.videoPath, outroResult.videoPath);
    result.videoPath = outroResult.videoPath;
    if (outroResult.subtitle) {
      await appendBouncingCaptionCues(result.assPath, [outroResult.subtitle]);
    }
  }

  const outputPath = join(rootDir, "preview.mp4");
  const subtitlesPath = join(rootDir, "preview.ass");
  await writeFile(outputPath, await readFile(result.videoPath));
  await writeFile(subtitlesPath, await readFile(result.assPath));
  localFiles.push(result.videoPath, result.assPath);

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
  targets: ("image" | "audio")[]
): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertEditable(reel);
  if (!reel.scenes[index]) throw new Error(`Scene ${index} not found`);

  await cleanupExistingDraft(reel);
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
  };

  const recipe = getRecipe(reel.niche);
  const models = resolveModels(reel.tier as Tier);
  const imageModel = reel.imageModelOverride || resolveModels(recipe.imageTier as Tier).image;
  const tts = resolveTtsChoice(models.tts, recipe.voice ?? {}, reel.voiceOverride ?? {});
  const artRef = await resolveArtStyleRefKeys(reel.artStyleId);
  const referenceImageUrls = artRef?.keys.length ? artRef.keys.map(cdnUrlFor) : undefined;
  const scene = reel.scenes[index];
  const draftScene: NonNullable<IReel["editDraft"]>["sceneAssets"][number] = { index };

  if (targets.includes("image")) {
    const imagePath = await generateImage(scene.visualPrompt, reel.style, { model: imageModel, referenceImageUrls });
    const stagedPath = join(rootDir, `scene_${index}_image.png`);
    await writeFile(stagedPath, await readFile(imagePath));
    await cleanupFiles([imagePath]);
    draftScene.assetPath = stagedPath;
    draftScene.assetUrl = localAssetUrl(draftId, basename(stagedPath));
  }

  if (targets.includes("audio")) {
    const { audioPath } = await generateNarration(narrationForTts(scene.narration, reel.niche), {
      model: tts.model,
      voice: tts.voice,
      format: tts.format,
      profile: narrationProfileFor(reel),
    });
    const stagedPath = join(rootDir, `scene_${index}_audio.mp3`);
    await writeFile(stagedPath, await readFile(audioPath));
    await cleanupFiles([audioPath]);
    draftScene.audioPath = stagedPath;
    draftScene.audioUrl = localAssetUrl(draftId, basename(stagedPath));
  }

  reel.editDraft.sceneAssets = [draftScene];
  const localFiles: string[] = [];
  const preview = await buildDraftPreview(reel, draftId, rootDir, localFiles);
  reel.editDraft.sceneAssets = preview.sceneAssets.filter(
    (item) => item.assetPath || item.audioPath
  );
  reel.editDraft.outputPath = preview.outputPath;
  reel.editDraft.outputUrl = localAssetUrl(draftId, basename(preview.outputPath));
  reel.editDraft.subtitlesPath = preview.subtitlesPath;
  reel.editDraft.subtitlesUrl = localAssetUrl(draftId, basename(preview.subtitlesPath));
  await reel.save();
  await cleanupFiles(localFiles.filter((path) => !path.startsWith(rootDir)));
  await cleanupRenderScratch(`draft_${draftId}`);
  return reel;
}

export async function createReelEditDraft(
  reelId: string,
  mode: "render_only" | "assets"
): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertEditable(reel);
  if (reel.scenes.length === 0) throw new Error("Nothing to regenerate — plan the reel first");

  await cleanupExistingDraft(reel);
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
  };

  if (mode === "assets") {
    const recipe = getRecipe(reel.niche);
    const models = resolveModels(reel.tier as Tier);
    const imageModel = reel.imageModelOverride || resolveModels(recipe.imageTier as Tier).image;
    const tts = resolveTtsChoice(models.tts, recipe.voice ?? {}, reel.voiceOverride ?? {});
    const artRef = await resolveArtStyleRefKeys(reel.artStyleId);
    const referenceImageUrls = artRef?.keys.length ? artRef.keys.map(cdnUrlFor) : undefined;

    for (let i = 0; i < reel.scenes.length; i++) {
      const scene = reel.scenes[i];
      const draftScene: NonNullable<IReel["editDraft"]>["sceneAssets"][number] = { index: i };
      if (!scene.isHero) {
        const imagePath = await generateImage(scene.visualPrompt, reel.style, {
          model: imageModel,
          referenceImageUrls,
        });
        const stagedImagePath = join(rootDir, `scene_${i}_image.png`);
        await writeFile(stagedImagePath, await readFile(imagePath));
        await cleanupFiles([imagePath]);
        draftScene.assetPath = stagedImagePath;
        draftScene.assetUrl = localAssetUrl(draftId, basename(stagedImagePath));
      }

      const { audioPath } = await generateNarration(narrationForTts(scene.narration, reel.niche), {
        model: tts.model,
        voice: tts.voice,
        format: tts.format,
        profile: narrationProfileFor(reel),
      });
      const stagedAudioPath = join(rootDir, `scene_${i}_audio.mp3`);
      await writeFile(stagedAudioPath, await readFile(audioPath));
      await cleanupFiles([audioPath]);
      draftScene.audioPath = stagedAudioPath;
      draftScene.audioUrl = localAssetUrl(draftId, basename(stagedAudioPath));
      reel.editDraft.sceneAssets.push(draftScene);
    }
  }

  const localFiles: string[] = [];
  const preview = await buildDraftPreview(reel, draftId, rootDir, localFiles);
  reel.editDraft.sceneAssets = preview.sceneAssets.filter(
    (item) => item.assetPath || item.audioPath
  );
  reel.editDraft.outputPath = preview.outputPath;
  reel.editDraft.outputUrl = localAssetUrl(draftId, basename(preview.outputPath));
  reel.editDraft.subtitlesPath = preview.subtitlesPath;
  reel.editDraft.subtitlesUrl = localAssetUrl(draftId, basename(preview.subtitlesPath));
  await reel.save();
  await cleanupFiles(localFiles.filter((path) => !path.startsWith(rootDir)));
  await cleanupRenderScratch(`draft_${draftId}`);
  return reel;
}

export async function saveEditDraft(reelId: string): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertEditable(reel);
  const draft = reel.editDraft;
  if (!draft?.outputPath || !draft.subtitlesPath) {
    throw new Error("No pending edit draft to save");
  }

  await commitRenderOutputs(reel, {
    outputPath: draft.outputPath,
    subtitlesPath: draft.subtitlesPath,
    sceneAssets: draft.sceneAssets,
  });
  await cleanupExistingDraft(reel);
  await reel.save();
  return reel;
}

/** Persist caption style, re-render locally, upload to S3, and delete the
 *  previous output video — no intermediate editDraft for the client to save. */
export async function applyCaptionsAndRender(
  reelId: string,
  patch: ICaptionStyle
): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertEditable(reel);
  if (!reel.scenes.length) throw new Error("Nothing to render — plan the reel first");

  reel.captionStyle = mergeCaptionStyle(reel.captionStyle, patch);
  reel.markModified("captionStyle");

  await cleanupExistingDraft(reel);
  const draftId = randomUUID();
  const rootDir = join(config.processingPath, "edit-drafts", reelId, draftId);
  await ensureDir(rootDir);

  const localFiles: string[] = [];
  const preview = await buildDraftPreview(reel, draftId, rootDir, localFiles);

  await commitRenderOutputs(reel, preview);
  await cleanupDirectory(rootDir).catch(() => {});
  await cleanupFiles(localFiles.filter((path) => !path.startsWith(rootDir)));
  await cleanupRenderScratch(`draft_${draftId}`);
  await reel.save();
  return reel;
}

export async function discardEditDraft(reelId: string): Promise<IReel> {
  const reel = await loadReel(reelId);
  await cleanupExistingDraft(reel);
  await reel.save();
  return reel;
}
