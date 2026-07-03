import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Reel, type IReel, type StorySource, type ReelMotionMode, type ISceneMotion } from "../models";
import { config } from "../config";
import { resolveModels, resolveTtsChoice, type Tier } from "../config/models";
import { ensureDir, cleanupFiles } from "../utils";
import { getErrorMessage } from "../types";
import { planReel, planRedditStory } from "./reel-script.service";
import { getRecipe, pickStyle, type NicheRecipe } from "../config/niche-styles";
import { pickArtStyle } from "../config/art-styles";
import { resolveArtStyleRefKeys } from "./art-style.service";
import { renderMotionReel, type MotionScene } from "./reel-motion.service";
import { renderGameplayReel, pickGameplay } from "./reel-gameplay.service";
import {
  generateStory,
  generateStorySeries,
  takeNextStory,
  type StoryDraft,
  type StoryPartDraft,
} from "./story.service";
import { generateImage, generateNarration } from "./openrouter-media.service";
import { renderImageKenBurns, type RenderScene } from "./reel-render.service";
import { renderHybridScene, type HybridScene } from "./reel-hybrid.service";
import { getScoutTargets } from "./trend-scout.service";
import { buildReelReviewPackage } from "./reel-review.service";
import { buildReelCostBreakdown, type MeasuredCostInput } from "./reel-cost.service";
import {
  uploadImage,
  uploadAudio,
  uploadVideo,
  uploadSubtitles,
  deleteFromS3,
  cdnUrlFor,
} from "./s3.service";
import { enqueueReel, enqueuePublish, removeReelJob } from "../queue/queues";

interface CreateReelOptions {
  niche: string;
  topic: string;
  tier?: IReel["tier"];
  parts?: "off" | "auto" | number;
  source?: StorySource;
  genre?: string;
  gameplayKey?: string;
  horrorAudioKey?: string;
  imageModel?: string;
  artStyleId?: string;
  motionMode?: ReelMotionMode;
  ttsModel?: string;
  ttsVoice?: string;
  ttsFormat?: "mp3" | "pcm";
}

/** Default per-scene motion type for a reel's motion mode. */
function motionTypeFor(mode: ReelMotionMode, i: number, total: number): ISceneMotion["type"] {
  switch (mode) {
    case "ai_full":
      return "ai_motion";
    case "ai_hybrid":
      // gate real image-to-video to the hook (first) + climax (last) only
      return i === 0 || i === total - 1 ? "ai_motion" : "parallax";
    case "parallax":
      return "parallax";
    case "ken_burns":
    default:
      return "ken_burns";
  }
}

function isHorror(niche: string): boolean {
  return niche.startsWith("horror");
}

/** Resolve the motion mode for a reel: explicit → else parallax for horror, Ken Burns otherwise. */
function resolveMotionMode(reel: IReel): ReelMotionMode {
  return reel.motionMode ?? (isHorror(reel.niche) ? "parallax" : "ken_burns");
}

/** Pick a random genre from this niche's scout targets (undefined if the niche has none, e.g. reddit picks its own way). */
function pickRandomGenre(niche: string): string | undefined {
  const targets = getScoutTargets(niche);
  if (!targets.length) return undefined;
  return targets[Math.floor(Math.random() * targets.length)].genre;
}

/** Build the voiceOverride subdoc from create-options, or undefined if none given. */
function toVoiceOverride(options: CreateReelOptions): IReel["voiceOverride"] {
  if (!options.ttsModel && !options.ttsVoice && !options.ttsFormat) return undefined;
  return { model: options.ttsModel, voice: options.ttsVoice, format: options.ttsFormat };
}

export interface CreateReelResult {
  reel: IReel;
  reels: IReel[];
  seriesId?: string;
}

/** Create a reel and enqueue generation (BullMQ — survives restarts, retries on failure). */
export async function createReel(options: CreateReelOptions): Promise<CreateReelResult> {
  const { niche, topic, tier = "cheap", parts = "off" } = options;
  const recipe = getRecipe(niche);
  if (options.horrorAudioKey && !/^horror-audio\/.+\.mp3$/i.test(options.horrorAudioKey)) {
    throw new Error("Invalid horror audio key");
  }

  if (recipe.strategy === "gameplay_overlay" && parts !== "off") {
    return createGameplayReelSeries({
      niche,
      topic,
      tier,
      parts,
      source: options.source,
      genre: options.genre,
      gameplayKey: options.gameplayKey,
      horrorAudioKey: options.horrorAudioKey,
      imageModel: options.imageModel,
      ttsModel: options.ttsModel,
      ttsVoice: options.ttsVoice,
      ttsFormat: options.ttsFormat,
    });
  }

  if (recipe.strategy === "gameplay_overlay" && (options.source || options.genre)) {
    return createGameplayReelFromStory(options);
  }

  // Niches with their own scout targets (e.g. horror) need a genre assigned
  // at creation time so the planner can pull the matching trend digest —
  // pick one at random when the caller didn't specify one. Reddit is excluded
  // here: it has its own untouched auto-topic flow via generateStory.
  const genre = options.genre ?? (recipe.strategy !== "gameplay_overlay" ? pickRandomGenre(niche) : undefined);

  // Reference-art style + motion policy (horror/image niches). A style is
  // rotated from the niche's pool when the caller didn't pin one; motion
  // defaults to the free parallax "living still" (AI motion is opt-in).
  const artStyleId = options.artStyleId ?? (isHorror(niche) ? pickArtStyle(niche)?.id : undefined);
  const motionMode = options.motionMode ?? (isHorror(niche) ? "parallax" : undefined);

  const reel = new Reel({
    niche,
    topic,
    tier,
    storySource: options.source,
    genre,
    strategy: recipe.strategy,
    artStyleId,
    motionMode,
    gameplayKey: options.gameplayKey,
    horrorAudioKey: options.horrorAudioKey,
    imageModelOverride: options.imageModel,
    voiceOverride: toVoiceOverride(options),
    status: "pending",
    progress: 0,
  });
  await reel.save();
  console.log(`🎬 Created reel: ${reel._id} (${niche})`);

  await enqueueReel(reel._id.toString());

  return { reel, reels: [reel] };
}

async function createGameplayReelFromStory(options: CreateReelOptions): Promise<CreateReelResult> {
  const { niche, topic, tier = "cheap" } = options;
  const autoTopic = !topic?.trim() || topic.trim().toLowerCase() === "auto";
  const source = options.source ?? (autoTopic ? (config.storyMode as StorySource) : "llm");
  const story = autoTopic
    ? await generateStory(source, { genre: options.genre, tier: tier as Tier })
    : await generateStory("llm", { genre: options.genre, tier: tier as Tier });

  const reel = new Reel({
    niche,
    topic,
    tier,
    storySource: source,
    genre: story.genre ?? options.genre,
    strategy: "gameplay_overlay",
    gameplayKey: options.gameplayKey,
    horrorAudioKey: options.horrorAudioKey,
    imageModelOverride: options.imageModel,
    voiceOverride: toVoiceOverride(options),
    status: "pending",
    progress: 0,
    title: story.title,
    hook: story.title,
    redditStory: toSingleRedditStoryPayload(story),
  });
  await reel.save();
  await enqueueReel(reel._id.toString());

  return { reel, reels: [reel] };
}

async function createGameplayReelSeries(
  options: CreateReelOptions & { parts: Exclude<CreateReelOptions["parts"], undefined> }
): Promise<CreateReelResult> {
  const { niche, topic, tier = "cheap", parts } = options;
  const autoTopic = !topic?.trim() || topic.trim().toLowerCase() === "auto";
  const source = options.source ?? (autoTopic ? (config.storyMode as StorySource) : "llm");
  const plannedParts = await generateStorySeries(source, {
    topic: autoTopic ? undefined : topic,
    genre: options.genre,
    tier: tier as Tier,
    parts: parts === "off" ? "auto" : parts,
  });

  const seriesId = plannedParts.length > 1 ? randomUUID() : undefined;
  const reels: IReel[] = [];

  for (const part of plannedParts) {
    const reel = new Reel({
      niche,
      topic,
      tier,
      storySource: source,
      genre: part.genre ?? options.genre,
      strategy: "gameplay_overlay",
      gameplayKey: options.gameplayKey,
      horrorAudioKey: options.horrorAudioKey,
      imageModelOverride: options.imageModel,
      voiceOverride: toVoiceOverride(options),
      status: "pending",
      progress: 0,
      title: part.title,
      hook: part.title,
      redditStory: toRedditStoryPayload(part),
      seriesId,
      partNumber: part.partNumber,
      partCount: part.partCount,
    });
    await reel.save();
    reels.push(reel);
    await enqueueReel(reel._id.toString());
  }

  console.log(
    `🎬 Created Reddit ${seriesId ? "series" : "reel"}: ${reels
      .map((r) => r._id)
      .join(", ")}`
  );

  return { reel: reels[0], reels, seriesId };
}

function toRedditStoryPayload(part: StoryPartDraft): NonNullable<IReel["redditStory"]> {
  return {
    title: part.title,
    body: part.body,
    source: part.source,
    genre: part.genre,
    subreddit: part.subreddit,
    author: part.author,
    upvotes: part.upvotes,
    comments: part.comments,
    ageHours: part.ageHours,
    seedTitle: part.seedTitle,
    seedUrl: part.seedUrl,
    partNumber: part.partNumber,
    partCount: part.partCount,
  };
}

function toSingleRedditStoryPayload(story: StoryDraft & { source: StorySource }): NonNullable<IReel["redditStory"]> {
  return {
    title: story.title,
    body: story.body,
    source: story.source,
    genre: story.genre,
    subreddit: story.subreddit,
    author: story.author,
    upvotes: story.upvotes,
    comments: story.comments,
    ageHours: story.ageHours,
    seedTitle: story.seedTitle,
    seedUrl: story.seedUrl,
    partNumber: 1,
    partCount: 1,
  };
}

async function updateStatus(
  id: string,
  status: IReel["status"],
  progress: number,
  error?: string
): Promise<void> {
  await Reel.findByIdAndUpdate(id, {
    status,
    progress: Math.min(100, Math.max(0, progress)),
    ...(error ? { error } : {}),
  });
}

async function downloadGeneratedAsset(url: string, filename: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not reuse generated asset (${res.status}): ${url}`);
  const path = join(config.processingPath, filename);
  await writeFile(path, Buffer.from(await res.arrayBuffer()));
  return path;
}

function narrationForTts(text: string, niche: string): string {
  if (!isHorrorNiche(niche)) return text;
  const paced = text
    .replace(/:\s+/g, "... ")
    .replace(/;\s+/g, "... ")
    .replace(/\s+/g, " ")
    .trim();
  return paced;
}

function isHorrorNiche(niche: string): boolean {
  return niche.startsWith("horror");
}

/** Full pipeline: plan → images → narration → render → upload. Invoked by the reel-processing worker. */
export async function processReel(reelId: string): Promise<void> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");

  const localFiles: string[] = [];
  const recipe = getRecipe(reel.niche);

  // Reddit / AITA runs a different strategy (gameplay + narration, no images).
  if (recipe.strategy === "gameplay_overlay") {
    return processGameplayReel(reel, recipe);
  }

  const isHybrid = recipe.strategy === "hybrid_scene";
  const models = resolveModels(reel.tier as Tier); // tts/video from reel tier
  const imageModel = reel.imageModelOverride || resolveModels(recipe.imageTier as Tier).image; // niche-appropriate stills
  // precedence: tier default < niche voice override < explicit pick at creation
  const tts = resolveTtsChoice(models.tts, recipe.voice ?? {}, reel.voiceOverride ?? {});
  // Reference-art style (if one is set) wins over the niche prompt-suffix pool,
  // and supplies the reference images fed to the image model as style anchors.
  const artRef = await resolveArtStyleRefKeys(reel.artStyleId);
  const referenceImageUrls = artRef?.keys.length ? artRef.keys.map(cdnUrlFor) : undefined;
  const style = artRef
    ? { id: artRef.style.id, promptSuffix: artRef.style.promptSuffix }
    : pickStyle(recipe); // rotate one style from the niche pool
  const motionMode = resolveMotionMode(reel);
  const measuredCosts: MeasuredCostInput[] = [];

  try {
    await ensureDir(config.processingPath);

    // 1. Plan (LLM script + scene graph)
    await updateStatus(reelId, "planning", 5);
    const canReusePlan = reel.scenes.length > 0 && Boolean(reel.title && reel.hook);
    if (canReusePlan) {
      console.log(`♻️  Reusing existing plan/assets for reel ${reelId}`);
    } else {
      const plan = await planReel(reel.niche, reel.topic, reel.tier as Tier, reel.genre, (usage) => {
        measuredCosts.push({
          label: usage.label,
          model: usage.model,
          costUsd: usage.costUsd,
          source: "actual",
        });
      });
      reel.title = plan.title;
      reel.hook = plan.hook;
      reel.style = style.promptSuffix;
      if (plan.storyBible) reel.storyBible = plan.storyBible;
      reel.scenes = plan.scenes.map((s, i) => ({
        index: i,
        narration: s.narration,
        visualPrompt: s.visualPrompt,
        motion: {
          type: motionTypeFor(motionMode, i, plan.scenes.length),
          direction: i % 2 === 0 ? "in" : "out",
        },
        startTime: 0,
        duration: 0,
        // heroPolicy "one_climax" (horror/mythology/movie_recap today): the
        // final scene is always the hero reveal — matches the "escalate dread,
        // end on a twist" script structure. "trend_gated" heroPolicy isn't used
        // by any hybrid_scene niche yet; revisit this if that changes.
        isHero: isHybrid && i === plan.scenes.length - 1,
      }));
      await reel.save();
    }
    console.log(
      `🎨 Style: ${canReusePlan ? "reused" : style.id}${artRef ? ` (art-ref×${referenceImageUrls?.length ?? 0})` : ""} | ` +
        `motion=${motionMode} | image=${imageModel} | voice=${tts.model}/${tts.voice}` +
        (isHybrid ? ` | hero=${models.video}` : "")
    );

    // 2. Images — skip the hero scene; its visual comes from generateHeroVideo
    // at render time instead (no point paying for a still that's discarded).
    await updateStatus(reelId, "generating_assets", 20);
    const imagePaths: (string | undefined)[] = [];
    const heroVideoPaths: (string | undefined)[] = [];
    for (let i = 0; i < reel.scenes.length; i++) {
      const scene = reel.scenes[i];
      if (scene.isHero) {
        if (scene.assetUrl) {
          const heroVideoPath = await downloadGeneratedAsset(scene.assetUrl, `${reelId}_${i}_hero_reused.mp4`);
          heroVideoPaths[i] = heroVideoPath;
          localFiles.push(heroVideoPath);
        }
        imagePaths.push(undefined);
        continue;
      }
      if (scene.assetUrl) {
        const imagePath = await downloadGeneratedAsset(scene.assetUrl, `${reelId}_${i}_reused.png`);
        imagePaths.push(imagePath);
        localFiles.push(imagePath);
        await updateStatus(
          reelId,
          "generating_assets",
          20 + Math.round(((i + 1) / reel.scenes.length) * 25)
        );
        continue;
      }
      const imagePath = await generateImage(scene.visualPrompt, reel.style, {
        model: imageModel,
        referenceImageUrls,
        onUsage: (usage) => {
          measuredCosts.push({
            label: `Image ${i + 1}`,
            model: imageModel,
            costUsd: usage.costUsd,
            source: usage.costUsd !== undefined ? "actual" : "estimated",
          });
        },
      });
      imagePaths.push(imagePath);
      localFiles.push(imagePath);

      const buffer = await readFile(imagePath);
      scene.assetUrl = await uploadImage(buffer, "compositions", `${reelId}_${i}.png`);
      await updateStatus(
        reelId,
        "generating_assets",
        20 + Math.round(((i + 1) / reel.scenes.length) * 25)
      );
    }
    await reel.save();

    // 3. Narration (silence-trimmed per scene)
    await updateStatus(reelId, "generating_audio", 50);
    const audioPaths: string[] = [];
    for (let i = 0; i < reel.scenes.length; i++) {
      const scene = reel.scenes[i];
      if (scene.audioUrl) {
        const audioPath = await downloadGeneratedAsset(scene.audioUrl, `${reelId}_${i}_reused.mp3`);
        audioPaths.push(audioPath);
        localFiles.push(audioPath);
        await updateStatus(
          reelId,
          "generating_audio",
          50 + Math.round(((i + 1) / reel.scenes.length) * 20)
        );
        continue;
      }
      const { audioPath } = await generateNarration(narrationForTts(scene.narration, reel.niche), {
        model: tts.model,
        voice: tts.voice,
        format: tts.format,
        profile: isHorrorNiche(reel.niche) ? "horror" : undefined,
        onUsage: (usage) => {
          measuredCosts.push({
            label: `Narration ${i + 1}`,
            model: `${tts.model}/${tts.voice}`,
            costUsd: usage.costUsd,
            source: usage.costUsd !== undefined ? "actual" : "estimated",
          });
        },
      });
      audioPaths.push(audioPath);
      localFiles.push(audioPath);

      const buffer = await readFile(audioPath);
      scene.audioUrl = await uploadAudio(buffer, `${reelId}_${i}.mp3`);
      await updateStatus(
        reelId,
        "generating_audio",
        50 + Math.round(((i + 1) / reel.scenes.length) * 20)
      );
    }
    await reel.save();

    // 4. Render (align happens inside, from actual durations)
    await updateStatus(reelId, "rendering", 75);
    // Motion engine handles any reel whose scenes use parallax or real
    // image-to-video; it reuses the same crossfade/caption/horror-mix assembly.
    const useMotion = reel.scenes.some(
      (s) => s.motion.type === "parallax" || s.motion.type === "ai_motion"
    );
    const result = useMotion
      ? await renderMotionReel(
          reelId,
          reel.scenes.map(
            (s, i): MotionScene => ({
              imagePath: imagePaths[i]!,
              assetUrl: s.assetUrl,
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
            onMotionUsage: (index, usage) => {
              measuredCosts.push({
                label: `Motion ${index + 1}`,
                model: models.video,
                costUsd: usage.costUsd,
                source: usage.costUsd !== undefined ? "actual" : "estimated",
              });
            },
          }
        )
      : isHybrid
      ? await renderHybridScene(
          reelId,
          reel.scenes.map(
            (s, i): HybridScene => ({
              imagePath: imagePaths[i] ?? "", // unused for the hero scene
              audioPath: audioPaths[i],
              narration: s.narration,
              visualPrompt: s.visualPrompt,
              motion: s.motion,
              isHero: s.isHero,
              heroVideoPath: heroVideoPaths[i],
            })
          ),
          {
            heroVideoModel: models.video,
            onHeroGenerated: async (heroVideoPath) => {
              const heroIndex = reel.scenes.findIndex((scene) => scene.isHero && !scene.assetUrl);
              if (heroIndex < 0) return;
              localFiles.push(heroVideoPath);
              const buffer = await readFile(heroVideoPath);
              reel.scenes[heroIndex].assetUrl = await uploadVideo(
                buffer,
                "compositions",
                `${reelId}_hero.mp4`
              );
              await reel.save();
            },
            onHeroUsage: (usage) => {
              measuredCosts.push({
                label: "Hero video",
                model: models.video,
                costUsd: usage.costUsd,
                source: usage.costUsd !== undefined ? "actual" : "estimated",
              });
            },
          }
        )
      : await renderImageKenBurns(
          reelId,
          reel.scenes.map(
            (s, i): RenderScene => ({
              imagePath: imagePaths[i]!,
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
          }
        );
    localFiles.push(result.videoPath, result.assPath);

    // record resolved timings
    result.scenes.forEach((t, i) => {
      reel.scenes[i].startTime = t.startTime;
      reel.scenes[i].duration = t.duration;
    });
    // 5. Upload
    await updateStatus(reelId, "uploading", 92);
    const videoBuffer = await readFile(result.videoPath);
    reel.outputUrl = await uploadVideo(videoBuffer, "reels", `${reelId}.mp4`);
    const assContent = await readFile(result.assPath, "utf-8");
    reel.subtitlesUrl = await uploadSubtitles(assContent, reelId);
    reel.review = await buildReelReviewPackage(reel);
    const heroScene = isHybrid ? result.scenes.find((_, i) => reel.scenes[i]?.isHero) : undefined;
    const costBreakdown = await buildReelCostBreakdown(reel, {
      llmModel: models.llm,
      tts,
      measuredCosts,
      heroVideoModel: isHybrid ? models.video : undefined,
      heroDurationSec: heroScene ? Math.min(Math.max(Math.round(heroScene.duration), 4), 8) : undefined,
    });
    reel.costBreakdown = costBreakdown;
    reel.costUsd = costBreakdown.totalUsd;

    reel.status = "completed";
    reel.progress = 100;
    await reel.save();
    if (config.autoPublishYoutube) await enqueuePublish(reelId, "youtube");

    await cleanupFiles(localFiles);
    console.log(`🎉 Reel complete: ${reel._id} (${result.totalDuration.toFixed(1)}s)`);
  } catch (error: unknown) {
    await cleanupFiles(localFiles);
    await updateStatus(reelId, "failed", 0, getErrorMessage(error));
    throw error;
  }
}

/** Reddit / AITA pipeline: story → narration → gameplay overlay → upload. */
async function processGameplayReel(reel: IReel, recipe: NicheRecipe): Promise<void> {
  const reelId = reel._id.toString();
  const localFiles: string[] = [];
  // precedence: tier default < niche voice override < explicit pick at creation
  const models = resolveModels(reel.tier as Tier);
  const tts = resolveTtsChoice(models.tts, recipe.voice ?? {}, reel.voiceOverride ?? {});

  try {
    await ensureDir(config.processingPath);

    // 1. Get the story: explicit topic → generate on-demand; otherwise pull the
    // next fresh one from the story bank (kept topped-up by the scheduled job).
    await updateStatus(reelId, "planning", 8);
    const auto = !reel.topic?.trim() || reel.topic.trim().toLowerCase() === "auto";
    const storySource = (reel.storySource ?? config.storyMode) as StorySource;
    const story = reel.redditStory
      ? reel.redditStory
      : auto
      ? await takeNextStory(storySource, reel.tier as Tier)
      : await planRedditStory(reel.topic, reel.tier as Tier, reel.genre);
    story.partNumber = reel.partNumber ?? story.partNumber;
    story.partCount = reel.partCount ?? story.partCount;
    const { path: gameplayPath, key: gameplayKey } = await pickGameplay(reel.gameplayKey);
    reel.gameplayKey = gameplayKey;
    // Cache is only for this render — S3 stays the source of truth (pickGameplay
    // re-downloads on demand), so don't let clips accumulate on local disk.
    localFiles.push(gameplayPath);
    reel.title = story.title;
    reel.hook = story.title;
    reel.scenes = [
      {
        index: 0,
        narration: story.body,
        visualPrompt: "gameplay background",
        motion: { type: "static", direction: "in" },
        startTime: 0,
        duration: 0,
        isHero: false,
      },
    ];
    await reel.save();

    // 2. Narrate + render (TTS happens inside the gameplay renderer)
    await updateStatus(reelId, "rendering", 45);
    const result = await renderGameplayReel(reelId, story, gameplayPath, tts);
    localFiles.push(result.videoPath, result.assPath);
    reel.scenes[0].duration = result.totalDuration;

    // 3. Upload
    await updateStatus(reelId, "uploading", 90);
    const videoBuffer = await readFile(result.videoPath);
    reel.outputUrl = await uploadVideo(videoBuffer, "reels", `${reelId}.mp4`);
    const assContent = await readFile(result.assPath, "utf-8");
    reel.subtitlesUrl = await uploadSubtitles(assContent, reelId);
    reel.review = await buildReelReviewPackage(reel);
    const costBreakdown = await buildReelCostBreakdown(reel, {
      llmModel: models.llm,
      tts,
    });
    reel.costBreakdown = costBreakdown;
    reel.costUsd = costBreakdown.totalUsd;

    reel.status = "completed";
    reel.progress = 100;
    await reel.save();
    if (config.autoPublishYoutube) await enqueuePublish(reelId, "youtube");

    await cleanupFiles(localFiles);
    console.log(`🎉 Reddit reel complete: ${reel._id} (${result.totalDuration.toFixed(1)}s)`);
  } catch (error: unknown) {
    await cleanupFiles(localFiles);
    await updateStatus(reelId, "failed", 0, getErrorMessage(error));
    throw error;
  }
}

export async function getReel(id: string): Promise<IReel | null> {
  return Reel.findById(id);
}

export async function listReels(limit = 50): Promise<IReel[]> {
  return Reel.find().sort({ createdAt: -1 }).limit(limit);
}

/** Delete a reel's Mongo record, every S3 asset it produced (scene stills/audio,
 *  rendered video, subtitles, thumbnail, voice-variant re-renders), and its
 *  BullMQ job (in case it's stuck/stalled rather than settled). */
export async function deleteReel(id: string): Promise<boolean> {
  const reel = await Reel.findById(id);
  if (!reel) return false;
  if (["planning", "generating_assets", "generating_audio", "aligning", "rendering", "uploading"].includes(reel.status)) {
    throw new Error(`Cannot delete reel while generation is active (current status: ${reel.status})`);
  }

  const assetUrls = [
    reel.outputUrl,
    reel.subtitlesUrl,
    reel.review?.thumbnailUrl,
    ...reel.scenes.flatMap((s) => [s.assetUrl, s.audioUrl]),
    ...reel.voiceVariants.map((v) => v.videoUrl),
  ].filter((url): url is string => Boolean(url));

  await Promise.all(assetUrls.map((url) => deleteFromS3(url).catch(() => {})));
  await removeReelJob(id).catch(() => {});
  await Reel.findByIdAndDelete(id);
  console.log(`🗑️  Deleted reel ${id} + ${assetUrls.length} S3 asset(s)`);
  return true;
}

/** Delete every reel currently marked "failed" — same full cascade as
 *  deleteReel() (S3 assets + BullMQ job + Mongo doc) for each one. */
export async function purgeFailedReels(): Promise<{ deleted: string[]; errors: { id: string; error: string }[] }> {
  const failed = await Reel.find({ status: "failed" }, { _id: 1 });
  const deleted: string[] = [];
  const errors: { id: string; error: string }[] = [];

  for (const reel of failed) {
    const id = reel._id.toString();
    try {
      await deleteReel(id);
      deleted.push(id);
    } catch (error: unknown) {
      errors.push({ id, error: getErrorMessage(error) });
    }
  }

  console.log(`🗑️  Purged ${deleted.length} failed reel(s)${errors.length ? `, ${errors.length} error(s)` : ""}`);
  return { deleted, errors };
}
