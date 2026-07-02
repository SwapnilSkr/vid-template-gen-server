import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Reel, type IReel, type StorySource } from "../models";
import { config } from "../config";
import { resolveModels, type Tier } from "../config/models";
import { ensureDir, cleanupFiles } from "../utils";
import { getErrorMessage } from "../types";
import { planReel, planRedditStory } from "./reel-script.service";
import { getRecipe, pickStyle, type NicheRecipe } from "../config/niche-styles";
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
import { buildReelReviewPackage } from "./reel-review.service";
import {
  uploadImage,
  uploadAudio,
  uploadVideo,
  uploadSubtitles,
  deleteFromS3,
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
  ttsModel?: string;
  ttsVoice?: string;
  ttsFormat?: "mp3" | "pcm";
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

  if (recipe.strategy === "gameplay_overlay" && parts !== "off") {
    return createGameplayReelSeries({
      niche,
      topic,
      tier,
      parts,
      source: options.source,
      genre: options.genre,
      gameplayKey: options.gameplayKey,
      ttsModel: options.ttsModel,
      ttsVoice: options.ttsVoice,
      ttsFormat: options.ttsFormat,
    });
  }

  if (recipe.strategy === "gameplay_overlay" && (options.source || options.genre)) {
    return createGameplayReelFromStory(options);
  }

  const reel = new Reel({
    niche,
    topic,
    tier,
    storySource: options.source,
    genre: options.genre,
    strategy: recipe.strategy,
    gameplayKey: options.gameplayKey,
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

  const models = resolveModels(reel.tier as Tier); // tts/video from reel tier
  const imageModel = resolveModels(recipe.imageTier as Tier).image; // niche-appropriate stills
  // precedence: tier default < niche voice override < explicit pick at creation
  const tts = { ...models.tts, ...(recipe.voice ?? {}), ...(reel.voiceOverride ?? {}) };
  const style = pickStyle(recipe); // rotate one style from the niche pool

  try {
    await ensureDir(config.processingPath);

    // 1. Plan (LLM script + scene graph)
    await updateStatus(reelId, "planning", 5);
    const plan = await planReel(reel.niche, reel.topic, reel.tier as Tier);
    reel.title = plan.title;
    reel.hook = plan.hook;
    reel.style = style.promptSuffix;
    console.log(`🎨 Style: ${style.id} | image=${imageModel} | voice=${tts.model}/${tts.voice}`);
    reel.scenes = plan.scenes.map((s, i) => ({
      index: i,
      narration: s.narration,
      visualPrompt: s.visualPrompt,
      motion: { type: "ken_burns", direction: i % 2 === 0 ? "in" : "out" },
      startTime: 0,
      duration: 0,
      isHero: false,
    }));
    await reel.save();

    // 2. Images
    await updateStatus(reelId, "generating_assets", 20);
    const imagePaths: string[] = [];
    for (let i = 0; i < reel.scenes.length; i++) {
      const scene = reel.scenes[i];
      const imagePath = await generateImage(scene.visualPrompt, reel.style, {
        model: imageModel,
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
      const { audioPath } = await generateNarration(scene.narration, {
        model: tts.model,
        voice: tts.voice,
        format: tts.format,
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
    const renderScenes: RenderScene[] = reel.scenes.map((s, i) => ({
      imagePath: imagePaths[i],
      audioPath: audioPaths[i],
      narration: s.narration,
      motion: s.motion,
    }));
    const result = await renderImageKenBurns(reelId, renderScenes);
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
  const tts = { ...resolveModels(reel.tier as Tier).tts, ...(recipe.voice ?? {}), ...(reel.voiceOverride ?? {}) };

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
