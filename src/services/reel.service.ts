import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import ffmpeg from "fluent-ffmpeg";
import { join } from "node:path";
import { Reel, type IReel, type StorySource, type ReelMotionMode, type ISceneMotion, type IRedditStoryPayload } from "../models";
import { config } from "../config";
import { resolveModels, resolveTtsChoice, type Tier } from "../config/models";
import { ensureDir, cleanupDirectory, cleanupFiles, cleanupRenderScratch } from "../utils";
import { getErrorMessage } from "../types";
import { planHorrorSeries, planReel, planRedditStory, structureUserScript } from "./reel-script.service";
import { getRecipe, pickStyle, type NicheRecipe } from "../config/niche-styles";
import { pickArtStyle } from "../config/art-styles";
import { getStylePreset, defaultPresetFor } from "../config/style-presets";
import { resolveArtStyleRefKeys } from "./art-style.service";
import { renderMotionReel, type MotionScene } from "./reel-motion.service";
import {
  appendBouncingCaptionCues,
  renderGameplayReel,
  pickGameplay,
  toSentences,
  getPartOutroText,
  DEFAULT_BOUNCE_CAPTION_STYLE,
  type GameplayRenderOpts,
} from "./reel-gameplay.service";
import {
  generateStory,
  generateStorySeries,
  markStoryReel,
  takeNextStory,
  type StoryDraft,
  type StoryPartDraft,
} from "./story.service";
import { generateImage, generateNarration } from "./openrouter-media.service";
import { renderImageKenBurns, applyEditEffects, hasEditEffects, finishFromAssembly, type RenderScene } from "./reel-render.service";
import { renderHybridScene, type HybridScene } from "./reel-hybrid.service";
import { appendBrandedOutro } from "./reel-outro.service";
import { assertFfmpegReady, isCaptionBurnError } from "./ffmpeg-capability.service";
import { getScoutTargets } from "./trend-scout.service";
import { buildReelReviewPackage } from "./reel-review.service";
import {
  accumulateReelCostBreakdown,
  buildReelCostBreakdown,
  type MeasuredCostInput,
} from "./reel-cost.service";
import { markHorrorReferenceUsed } from "./horror-reference.service";
import { resolveStoryMatchedTts } from "./reel-voice-match.service";
import {
  uploadImage,
  uploadAudio,
  uploadVideo,
  uploadSubtitles,
  deleteFromS3,
  cdnUrlFor,
} from "./s3.service";
import {
  enqueueReel,
  enqueueReelPlan,
  enqueuePublish,
  removeReelJob,
} from "../queue/queues";

interface CreateReelOptions {
  niche: string;
  topic: string;
  tier?: IReel["tier"];
  parts?: "off" | "auto" | number;
  source?: StorySource;
  genre?: string;
  gameplayKey?: string;
  horrorAudioKey?: string;
  outroChannelId?: string;
  outro?: IReel["outro"];
  thumbnailMode?: IReel["thumbnailMode"];
  imageModel?: string;
  artStyleId?: string;
  motionMode?: ReelMotionMode;
  editEffects?: IReel["editEffects"];
  presetId?: string;
  pipelineMode?: IReel["pipelineMode"];
  providedScript?: string;
  horrorReferenceId?: string;
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

function isFullSourceStory(text?: string): boolean {
  return (text?.trim().split(/\s+/).filter(Boolean).length ?? 0) >= 80;
}

function resolveSeriesPartCount(parts: Exclude<CreateReelOptions["parts"], undefined>): number {
  if (parts === "off") return 1;
  if (parts === "auto") return 3;
  return Math.min(4, Math.max(2, Math.round(parts)));
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
  // Always require ffmpeg up front — even review-mode reels need it on approve/produce.
  assertFfmpegReady("Create reel");

  const { niche, topic, tier = "cheap", parts = "off" } = options;
  const recipe = getRecipe(niche);
  if (options.horrorAudioKey && !/^horror-audio\/.+\.mp3$/i.test(options.horrorAudioKey)) {
    throw new Error("Invalid horror audio key");
  }

  if (isHorror(niche) && parts !== "off") {
    return createHorrorReelSeries({
      ...options,
      niche,
      topic,
      tier,
      parts,
    });
  }

  if (recipe.strategy === "gameplay_overlay" && (parts !== "off" || options.source === "verbatim")) {
    return createGameplayReelSeries({
      niche,
      topic,
      tier,
      parts: options.source === "verbatim" && parts === "off" ? "auto" : parts,
      source: options.source,
      genre: options.genre,
      gameplayKey: options.gameplayKey,
      horrorAudioKey: options.horrorAudioKey,
      outroChannelId: options.outroChannelId,
      outro: options.outro,
      thumbnailMode: options.thumbnailMode,
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

  // Style preset (the "Lurker"-style bundle) seeds art/motion/voice/captions.
  // Explicit options always win; the preset fills what the caller left unset.
  const preset = getStylePreset(options.presetId) ?? defaultPresetFor(niche);
  const artStyleId =
    options.artStyleId ?? preset?.artStyleId ?? (isHorror(niche) ? pickArtStyle(niche)?.id : undefined);
  const motionMode =
    options.motionMode ?? preset?.motionMode ?? (isHorror(niche) ? "parallax" : undefined);
  const voiceOverride = toVoiceOverride(options) ?? preset?.voice;
  // Horror is human-in-the-loop by default (gate after the cheap plan);
  // other niches run straight through unless the caller asks for review.
  const pipelineMode = options.pipelineMode ?? (isHorror(niche) ? "review" : "auto");

  const reel = new Reel({
    niche,
    topic,
    tier,
    storySource: options.source,
    genre,
    strategy: recipe.strategy,
    artStyleId,
    presetId: preset?.id,
    motionMode,
    captionStyle: preset?.captionStyle,
    audioPost: preset?.audioPost,
    editEffects: options.editEffects,
    pipelineMode,
    providedScript: options.providedScript,
    horrorReferenceId: options.horrorReferenceId,
    gameplayKey: options.gameplayKey,
    horrorAudioKey: options.horrorAudioKey,
    outroChannelId: options.outroChannelId,
    outro: options.outro,
    thumbnailMode: options.thumbnailMode ?? "frame",
    imageModelOverride: options.imageModel,
    voiceOverride,
    status: "pending",
    progress: 0,
  });
  await reel.save();
  console.log(`🎬 Created reel: ${reel._id} (${niche}) [${pipelineMode}]`);

  if (pipelineMode === "review") await enqueueReelPlan(reel._id.toString());
  else await enqueueReel(reel._id.toString());

  return { reel, reels: [reel] };
}

async function createGameplayReelFromStory(options: CreateReelOptions): Promise<CreateReelResult> {
  const { niche, topic, tier = "cheap" } = options;
  const autoTopic = !topic?.trim() || topic.trim().toLowerCase() === "auto";
  const source = options.source ?? (autoTopic ? (config.storyMode as StorySource) : "llm");
  const startedAt = Date.now();
  console.log(
    `📝 Creating Reddit reel (sync story) source=${source} genre=${options.genre ?? "any"} topic=${autoTopic ? "auto" : topic}`
  );
  const story = autoTopic
    ? await generateStory(source, { genre: options.genre, tier: tier as Tier })
    : await generateStory("llm", { genre: options.genre, tier: tier as Tier });
  console.log(
    `📝 Reddit story ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s: "${story.title.slice(0, 60)}"`
  );
  const pipelineMode = options.pipelineMode ?? "review";

  const reel = new Reel({
    niche,
    topic,
    tier,
    storySource: source,
    genre: story.genre ?? options.genre,
    strategy: "gameplay_overlay",
    gameplayKey: options.gameplayKey,
    horrorAudioKey: options.horrorAudioKey,
    outroChannelId: options.outroChannelId,
    outro: options.outro,
    thumbnailMode: options.thumbnailMode ?? "frame",
    imageModelOverride: options.imageModel,
    voiceOverride: toVoiceOverride(options),
    captionStyle: DEFAULT_BOUNCE_CAPTION_STYLE,
    pipelineMode,
    status: "pending",
    progress: 0,
    title: story.title,
    hook: story.title,
    redditStory: stabilizeRedditCard(toSingleRedditStoryPayload(story)),
  });
  await reel.save();
  if (pipelineMode === "review") await enqueueReelPlan(reel._id.toString());
  else await enqueueReel(reel._id.toString());

  return { reel, reels: [reel] };
}

async function createGameplayReelSeries(
  options: CreateReelOptions & { parts: Exclude<CreateReelOptions["parts"], undefined> }
): Promise<CreateReelResult> {
  const { niche, topic, tier = "cheap", parts } = options;
  const autoTopic = !topic?.trim() || topic.trim().toLowerCase() === "auto";
  const source = options.source ?? (autoTopic ? (config.storyMode as StorySource) : "llm");
  const seriesStartedAt = Date.now();
  console.log(
    `📝 Creating Reddit series (sync story) source=${source} parts=${String(parts)} genre=${options.genre ?? "any"}`
  );
  const plannedParts = await generateStorySeries(source, {
    topic: autoTopic ? undefined : topic,
    genre: options.genre,
    tier: tier as Tier,
    parts: parts === "off" ? "auto" : parts,
  });
  console.log(
    `📝 Reddit series ready in ${((Date.now() - seriesStartedAt) / 1000).toFixed(1)}s: ${plannedParts.length} part(s)`
  );

  const seriesId = plannedParts.length > 1 ? randomUUID() : undefined;
  const reels: IReel[] = [];
  const pipelineMode = options.pipelineMode ?? "review";

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
      outroChannelId: options.outroChannelId,
      outro: options.outro,
      thumbnailMode: options.thumbnailMode ?? "frame",
      imageModelOverride: options.imageModel,
      voiceOverride: toVoiceOverride(options),
      captionStyle: DEFAULT_BOUNCE_CAPTION_STYLE,
      pipelineMode,
      status: "pending",
      progress: 0,
      title: part.title,
      hook: part.title,
      redditStory: stabilizeRedditCard(toRedditStoryPayload(part)),
      seriesId,
      partNumber: part.partNumber,
      partCount: part.partCount,
    });
    await reel.save();
    reels.push(reel);
    if (pipelineMode === "review") await enqueueReelPlan(reel._id.toString());
    else await enqueueReel(reel._id.toString());
  }

  console.log(
    `🎬 Created Reddit ${seriesId ? "series" : "reel"}: ${reels
      .map((r) => r._id)
      .join(", ")}`
  );

  return { reel: reels[0], reels, seriesId };
}

async function createHorrorReelSeries(
  options: CreateReelOptions & { parts: Exclude<CreateReelOptions["parts"], undefined> }
): Promise<CreateReelResult> {
  const { niche, topic, tier = "cheap", parts } = options;
  const partCount = resolveSeriesPartCount(parts);
  const recipe = getRecipe(niche);
  const genre = options.genre ?? pickRandomGenre(niche);
  const preset = getStylePreset(options.presetId) ?? defaultPresetFor(niche);
  const artStyleId =
    options.artStyleId ?? preset?.artStyleId ?? (isHorror(niche) ? pickArtStyle(niche)?.id : undefined);
  const motionMode =
    options.motionMode ?? preset?.motionMode ?? (isHorror(niche) ? "parallax" : undefined);
  const voiceOverride = toVoiceOverride(options) ?? preset?.voice;
  const pipelineMode = options.pipelineMode ?? "review";
  const seriesStartedAt = Date.now();
  console.log(`📚 Planning horror series (${partCount} parts) niche=${niche} genre=${genre}`);
  const planned = await planHorrorSeries(
    niche,
    options.providedScript?.trim() || topic,
    tier as Tier,
    genre,
    partCount,
    undefined,
    options.horrorReferenceId
  );
  console.log(
    `📚 Horror series plan ready in ${((Date.now() - seriesStartedAt) / 1000).toFixed(1)}s: ${planned.parts.length} part(s)`
  );
  const seriesId = randomUUID();
  const reels: IReel[] = [];

  for (const part of planned.parts) {
    const partSeed = [
      part.brief,
      `Opening state: ${part.openingState}`,
      `Ending state: ${part.endingState}`,
      part.cliffhanger ? `Cliffhanger: ${part.cliffhanger}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const reel = new Reel({
      niche,
      topic: partSeed || topic,
      tier,
      genre,
      strategy: recipe.strategy,
      artStyleId,
      presetId: preset?.id,
      motionMode,
      captionStyle: preset?.captionStyle,
      audioPost: preset?.audioPost,
      editEffects: options.editEffects,
      pipelineMode,
      storyBible: planned.storyBible,
      horrorReference: planned.horrorReference,
      horrorReferenceId: options.horrorReferenceId,
      horrorAudioKey: options.horrorAudioKey,
      outroChannelId: options.outroChannelId,
      outro: options.outro,
      thumbnailMode: options.thumbnailMode ?? "frame",
      imageModelOverride: options.imageModel,
      voiceOverride,
      status: "pending",
      progress: 0,
      title: part.title,
      hook: part.hook,
      seriesId,
      partNumber: part.partNumber,
      partCount: part.partCount,
    });
    await reel.save();
    reels.push(reel);
    if (pipelineMode === "review") await enqueueReelPlan(reel._id.toString());
    else await enqueueReel(reel._id.toString());
  }

  console.log(`🎬 Created horror series ${seriesId}: ${reels.map((r) => r._id).join(", ")}`);
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

const CARD_NAME_PARTS = [
  "throwaway", "anon", "confused", "quiet", "tired", "petty", "curious", "notthe",
  "just", "reluctant", "former", "the_real", "mildly", "sudden",
];
const CARD_SUBREDDITS = [
  "r/AmItheAsshole", "r/relationships", "r/pettyrevenge", "r/entitledparents",
  "r/JUSTNOMIL", "r/tifu", "r/confession",
];

/** Mongoose subdocs hide schema fields from object spread — flatten first. */
function plainRedditStory(story: IRedditStoryPayload): IRedditStoryPayload {
  const maybeDoc = story as IRedditStoryPayload & { toObject?: () => IRedditStoryPayload };
  return typeof maybeDoc.toObject === "function" ? maybeDoc.toObject() : { ...story };
}

/** Fill missing title-card fields once at plan time so render never randomizes. */
export function stabilizeRedditCard(story: IRedditStoryPayload): IRedditStoryPayload {
  const base = plainRedditStory(story);
  const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
  const subreddit = base.subreddit?.trim() || pick(CARD_SUBREDDITS);
  const cardUsername =
    base.cardUsername?.trim() ||
    (base.author
      ? base.author.startsWith("u/")
        ? base.author
        : `u/${base.author}`
      : `u/${pick(CARD_NAME_PARTS)}_${Math.floor(Math.random() * 9000 + 1000)}`);
  return {
    ...base,
    subreddit,
    cardUsername,
    ageHours: Number.isFinite(base.ageHours) ? base.ageHours : Math.floor(Math.random() * 11) + 2,
    upvotes: Number.isFinite(base.upvotes) ? base.upvotes : Math.round((Math.random() * 20 + 4) * 1000),
    comments: Number.isFinite(base.comments) ? base.comments : Math.round((Math.random() * 3 + 0.4) * 1000),
  };
}

/** Build sentence scenes from a Reddit story body (no AI images). */
export function buildGameplayScenesFromBody(body: string): IReel["scenes"] {
  const sentences = toSentences(body);
  const lines = sentences.length ? sentences : [body.trim() || "..."];
  return lines.map((narration, i) => ({
    index: i,
    narration,
    visualPrompt: "gameplay background",
    motion: { type: "static" as const, direction: "in" as const },
    startTime: 0,
    duration: 0,
    isHero: false,
  }));
}

/** Rebuild redditStory.body from sentence scenes (spoken body source of truth). */
export function syncRedditBodyFromScenes(reel: IReel): void {
  if (!reel.redditStory || reel.strategy !== "gameplay_overlay") return;
  const body = reel.scenes.map((s) => s.narration.trim()).filter(Boolean).join(" ");
  if (body) reel.redditStory.body = body;
}

function logReelProgress(
  id: string,
  status: IReel["status"],
  progress: number,
  currentStep?: string
): void {
  console.log(
    `📡 Reel ${id}: ${status} ${progress}%${currentStep ? ` — ${currentStep}` : ""}`
  );
}

async function updateStatus(
  id: string,
  status: IReel["status"],
  progress: number,
  options?: { error?: string; currentStep?: string | null }
): Promise<void> {
  const clamped = Math.min(100, Math.max(0, progress));
  const $set: Record<string, unknown> = { status, progress: clamped };
  if (options?.error) $set.error = options.error;

  const update: Record<string, unknown> = { $set };
  if (options?.currentStep === null) {
    update.$unset = { currentStep: "" };
  } else if (options?.currentStep !== undefined) {
    $set.currentStep = options.currentStep;
  }

  logReelProgress(
    id,
    status,
    clamped,
    options?.currentStep === null ? undefined : options?.currentStep
  );
  await Reel.findByIdAndUpdate(id, update);
}

/** Persist in-memory scene asset/audio changes + status so polling clients see
 *  each still/narration as soon as it lands on S3 (not only after the full batch). */
async function persistProduceProgress(
  reel: IReel,
  status: IReel["status"],
  progress: number,
  currentStep: string
): Promise<void> {
  const clamped = Math.min(100, Math.max(0, progress));
  reel.status = status;
  reel.progress = clamped;
  reel.currentStep = currentStep;
  reel.markModified("scenes");
  logReelProgress(String(reel._id), status, clamped, currentStep);
  await reel.save();
}

async function failProduce(reelId: string, error: unknown): Promise<void> {
  const message = getErrorMessage(error);
  const $set: Record<string, unknown> = {
    status: "failed",
    progress: 0,
    error: message,
  };
  if (isCaptionBurnError(error)) {
    $set.captionsBurned = false;
    $set.captionBurnError = message;
  }
  console.error(`💥 Reel ${reelId} produce failed: ${message}`);
  await Reel.findByIdAndUpdate(reelId, { $set, $unset: { currentStep: "" } });
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

function narrationProfileFor(reel: IReel): "horror" | "whisper" | "phone" | "tape" | "distant" | undefined {
  if (!isHorrorNiche(reel.niche)) return undefined;
  const profile = reel.audioPost?.voiceProfile ?? "horror";
  return profile === "none" ? undefined : profile;
}

function isHorrorNiche(niche: string): boolean {
  return niche.startsWith("horror");
}

/** Full auto pipeline: plan → images → narration → render → upload. Used for
 *  `pipelineMode: "auto"` reels (plan and produce in one job run). */
export async function processReel(reelId: string): Promise<void> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  const recipe = getRecipe(reel.niche);
  if (recipe.strategy === "gameplay_overlay") return processGameplayReel(reel, recipe);

  const localFiles: string[] = [];
  const measuredCosts: MeasuredCostInput[] = [];
  try {
    await planImageReel(reel, recipe, measuredCosts);
    await produceImageReel(reel, recipe, measuredCosts, localFiles);
  } catch (error: unknown) {
    await cleanupFiles(localFiles);
    await cleanupRenderScratch(reelId);
    await failProduce(reelId, error);
    throw error;
  }
}

/** Plan stage only: write the script + scene graph cheaply, then STOP at
 *  `plan_review` so a human can edit before any image/audio/render spend.
 *  Enqueued for `pipelineMode: "review"` reels. */
export async function processReelPlan(reelId: string): Promise<void> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  const recipe = getRecipe(reel.niche);

  const measuredCosts: MeasuredCostInput[] = [];
  try {
    if (recipe.strategy === "gameplay_overlay") {
      await planGameplayReel(reel, recipe);
    } else {
      await planImageReel(reel, recipe, measuredCosts);
    }
    reel.status = "plan_review";
    reel.progress = 15;
    reel.currentStep = "Awaiting your review";
    await reel.save();
    console.log(`⏸️  Reel ${reelId} planned — awaiting review`);
  } catch (error: unknown) {
    await updateStatus(reelId, "failed", 0, {
      error: getErrorMessage(error),
      currentStep: null,
    });
    throw error;
  }
}

/** Produce stage: images → narration → render → upload, reusing any assets the
 *  reel already has. Enqueued when a reviewed plan is approved, or to re-render
 *  after edits (surgical regen = clear the changed scene's asset first). */
export async function processReelProduce(
  reelId: string,
  produceMode: "full" | "outro_only" | "composite_only" = "full"
): Promise<void> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  const recipe = getRecipe(reel.niche);

  if (produceMode === "outro_only") {
    await processOutroOnlyReel(reel, recipe);
    return;
  }

  if (produceMode === "composite_only") {
    if (recipe.strategy === "gameplay_overlay") {
      await processGameplayReel(reel, recipe, { requireCachedNarration: true });
      return;
    }
    // Horror / image: finish from assemblyVideoUrl when present.
    await processImageCompositeOnly(reel, recipe);
    return;
  }

  if (recipe.strategy === "gameplay_overlay") return processGameplayReel(reel, recipe);

  const localFiles: string[] = [];
  const measuredCosts: MeasuredCostInput[] = [];
  try {
    await produceImageReel(reel, recipe, measuredCosts, localFiles);
  } catch (error: unknown) {
    await cleanupFiles(localFiles);
    await cleanupRenderScratch(reelId);
    await failProduce(reelId, error);
    throw error;
  }
}

/** Swap a cached media URL on the reel, deleting the superseded S3 object. */
async function replaceCachedMediaUrl(
  reel: IReel,
  field: "bodyVideoUrl" | "assemblyVideoUrl" | "titleAudioUrl" | "partOutroAudioUrl" | "outroAudioUrl",
  nextUrl: string | undefined
): Promise<void> {
  const prev = reel[field];
  if (nextUrl) reel[field] = nextUrl;
  else delete reel[field];
  if (prev && prev !== nextUrl) {
    await deleteFromS3(prev).catch(() => {});
  }
}

/** Persist newly generated outro narration; no-op when the clip reused cache. */
async function persistOutroAudio(
  reel: IReel,
  outroResult:
    | {
        outroAudioPath: string;
        outroAudioGenerated: boolean;
      }
    | undefined,
  localFiles: string[]
): Promise<void> {
  if (!outroResult) return;
  if (outroResult.outroAudioGenerated) {
    localFiles.push(outroResult.outroAudioPath);
    const buf = await readFile(outroResult.outroAudioPath);
    const url = await uploadAudio(buf, `${reel._id}_outro.mp3`);
    await replaceCachedMediaUrl(reel, "outroAudioUrl", url);
  }
}

/** Upload the pre-outro body so later outro-only jobs can skip a full rebuild. */
async function persistBodyVideo(
  reel: IReel,
  bodyPath: string,
  localFiles: string[]
): Promise<void> {
  const buf = await readFile(bodyPath);
  const url = await uploadVideo(buf, "reels", `${reel._id}_body.mp4`);
  await replaceCachedMediaUrl(reel, "bodyVideoUrl", url);
  void localFiles;
}

/** Upload pre-caption assembly so caption/FX edits skip Ken Burns re-assembly. */
async function persistAssemblyVideo(
  reel: IReel,
  assemblyPath: string,
  localFiles: string[]
): Promise<void> {
  localFiles.push(assemblyPath);
  const buf = await readFile(assemblyPath);
  const url = await uploadVideo(buf, "reels", `${reel._id}_assembly.mp4`);
  await replaceCachedMediaUrl(reel, "assemblyVideoUrl", url);
}

/** Put the user-authored vertical cover into the video without touching any AI
 * assets. A short hold makes mobile frame-picking reliable. */
async function applyOpeningShortsCover(
  reel: IReel,
  inputPath: string,
  localFiles: string[]
): Promise<string> {
  if (!reel.shortsCover?.imageUrl || reel.shortsCover.placement !== "opening") return inputPath;
  const reelId = reel._id.toString();
  const coverPath = await downloadGeneratedAsset(reel.shortsCover.imageUrl, `${reelId}_cover_reused.png`);
  const outputPath = join(config.processingPath, `${reelId}_cover_applied.mp4`);
  localFiles.push(coverPath, outputPath);
  const hold = Math.min(5, Math.max(0.25, reel.shortsCover.holdSeconds ?? 0.75)).toFixed(2);
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(inputPath)
      .input(coverPath)
      .complexFilter(`[0:v][1:v]overlay=0:0:enable='lt(t,${hold})'[v]`, ["v"])
      .outputOptions(["-map", "0:a?", "-c:v", "libx264", "-preset", config.ffmpegPreset, "-crf", "21", "-c:a", "copy", "-movflags", "+faststart"])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (error) => reject(new Error(`Shorts cover composite failed: ${error.message}`)))
      .run();
  });
  return outputPath;
}

/** Caption/FX composite from cached assemblyVideoUrl (horror/image) — no Ken Burns. */
async function processImageCompositeOnly(reel: IReel, recipe: NicheRecipe): Promise<void> {
  const reelId = reel._id.toString();
  if (!reel.assemblyVideoUrl || reel.scenes.some((s) => s.startTime === undefined)) {
    console.warn(
      `⚠️  Composite-only requested for ${reelId} but assembly cache is incomplete — falling back to full produce`
    );
    const localFiles: string[] = [];
    const measuredCosts: MeasuredCostInput[] = [];
    try {
      await produceImageReel(reel, recipe, measuredCosts, localFiles);
    } catch (error: unknown) {
      await cleanupFiles(localFiles);
      await cleanupRenderScratch(reelId);
      await failProduce(reelId, error);
      throw error;
    }
    return;
  }

  const localFiles: string[] = [];
  const measuredCosts: MeasuredCostInput[] = [];
  const models = resolveModels(reel.tier as Tier);
  try {
    assertFfmpegReady("Composite-only produce", { fresh: true });
    await ensureDir(config.processingPath);
    await updateStatus(reelId, "rendering", 45, { currentStep: "Composite-only re-render" });

    const assemblyPath = await downloadGeneratedAsset(
      reel.assemblyVideoUrl,
      `${reelId}_assembly_reused.mp4`
    );
    localFiles.push(assemblyPath);

    let result = await finishFromAssembly(
      reelId,
      assemblyPath,
      reel.scenes.map((s) => ({
        narration: s.narration,
        startTime: s.startTime ?? 0,
        duration: s.duration || 1,
      })),
      {
        horrorEffects: isHorrorNiche(reel.niche),
        comicEffects: reel.niche === "horror_comic",
        horrorAudioKey: reel.horrorAudioKey,
        captionStyle: reel.captionStyle,
      }
    );
    localFiles.push(result.videoPath, result.assPath);

    if (hasEditEffects(reel.editEffects)) {
      const fxPath = join(config.processingPath, `${reelId}_fx.mp4`);
      await applyEditEffects(result.videoPath, fxPath, reel.editEffects);
      localFiles.push(fxPath);
      result = { ...result, videoPath: fxPath };
    }

    result = { ...result, videoPath: await applyOpeningShortsCover(reel, result.videoPath, localFiles) };
    await persistBodyVideo(reel, result.videoPath, localFiles);

    const tts = resolveTtsChoice(models.tts, recipe.voice ?? {}, reel.voiceOverride ?? {});
    const hadPriorOutput = Boolean(reel.outputUrl);
    const outroResult = await appendBrandedOutro(result.videoPath, reel, tts, (usage) => {
      measuredCosts.push({
        label: "Outro narration",
        model: `${tts.model}/${tts.voice}`,
        costUsd: usage.costUsd,
        source: usage.costUsd !== undefined ? "actual" : "estimated",
      });
    });
    if (outroResult) {
      localFiles.push(outroResult.videoPath);
      result = {
        ...result,
        videoPath: outroResult.videoPath,
        totalDuration: result.totalDuration + outroResult.durationAdded,
      };
      await persistOutroAudio(reel, outroResult, localFiles);
      if (outroResult.subtitle) {
        await appendBouncingCaptionCues(result.assPath, [outroResult.subtitle]);
      }
    }

    await updateStatus(reelId, "uploading", 90, { currentStep: "Uploading video" });
    reel.captionsBurned = true;
    reel.captionBurnError = undefined;
    const prevOutput = reel.outputUrl;
    reel.outputUrl = await uploadVideo(await readFile(result.videoPath), "reels", `${reelId}.mp4`);
    if (prevOutput && prevOutput !== reel.outputUrl) {
      await deleteFromS3(prevOutput).catch(() => {});
    }
    reel.subtitlesUrl = await uploadSubtitles(await readFile(result.assPath, "utf-8"), reelId);

    const runBreakdown = await buildReelCostBreakdown(reel, {
      llmModel: models.llm,
      tts,
      measuredCosts,
    });
    reel.costBreakdown = hadPriorOutput
      ? accumulateReelCostBreakdown(reel.costBreakdown, runBreakdown, "Composite re-render")
      : runBreakdown;
    reel.costUsd = reel.costBreakdown.totalUsd;
    reel.status = "completed";
    reel.progress = 100;
    reel.currentStep = undefined;
    reel.error = undefined;
    await reel.save();

    await cleanupFiles(localFiles);
    await cleanupRenderScratch(reelId);
    console.log(`🎉 Composite-only re-render complete: ${reel._id} (assembly reused)`);
  } catch (error: unknown) {
    await cleanupFiles(localFiles);
    await cleanupRenderScratch(reelId);
    await failProduce(reelId, error);
    throw error;
  }
}

/** Outro-only produce: concat a new branded outro onto the cached body video. */
async function processOutroOnlyReel(reel: IReel, recipe: NicheRecipe): Promise<void> {
  const reelId = reel._id.toString();
  if (!reel.bodyVideoUrl) {
    console.warn(
      `⚠️  Outro-only requested for ${reelId} but bodyVideoUrl is missing — falling back to full produce`
    );
    if (recipe.strategy === "gameplay_overlay") return processGameplayReel(reel, recipe);
    const localFiles: string[] = [];
    const measuredCosts: MeasuredCostInput[] = [];
    try {
      await produceImageReel(reel, recipe, measuredCosts, localFiles);
    } catch (error: unknown) {
      await cleanupFiles(localFiles);
      await cleanupRenderScratch(reelId);
      await failProduce(reelId, error);
      throw error;
    }
    return;
  }

  const localFiles: string[] = [];
  const measuredCosts: MeasuredCostInput[] = [];
  const models = resolveModels(reel.tier as Tier);
  try {
    assertFfmpegReady("Outro-only produce", { fresh: true });
    await ensureDir(config.processingPath);
    await updateStatus(reelId, "rendering", 50, { currentStep: "Outro-only re-render" });

    const bodyPath = await downloadGeneratedAsset(reel.bodyVideoUrl, `${reelId}_body_reused.mp4`);
    localFiles.push(bodyPath);

    const tts =
      recipe.strategy === "gameplay_overlay"
        ? resolveStoryMatchedTts(
            models.tts,
            recipe.voice ?? {},
            reel.voiceOverride,
            {
              title: reel.redditStory?.title ?? reel.title ?? "",
              body: reel.scenes.map((s) => s.narration).join(" ") || reel.redditStory?.body || "",
            }
          )
        : resolveTtsChoice(models.tts, recipe.voice ?? {}, reel.voiceOverride ?? {});

    let gameplayPath: string | undefined;
    if (recipe.strategy === "gameplay_overlay") {
      const picked = await pickGameplay(reel.gameplayKey);
      gameplayPath = picked.path;
      reel.gameplayKey = picked.key;
      localFiles.push(gameplayPath);
    }

    const hadPriorOutput = Boolean(reel.outputUrl);
    const outroResult = await appendBrandedOutro(
      bodyPath,
      reel,
      tts,
      (usage) => {
        measuredCosts.push({
          label: "Outro narration",
          model: `${tts.model}/${tts.voice}`,
          costUsd: usage.costUsd,
          source: usage.costUsd !== undefined ? "actual" : "estimated",
        });
      },
      { backgroundVideo: gameplayPath }
    );

    let finalPath = bodyPath;
    let assPath: string | undefined;
    if (outroResult) {
      localFiles.push(outroResult.videoPath);
      finalPath = outroResult.videoPath;
      await persistOutroAudio(reel, outroResult, localFiles);
      if (outroResult.subtitle && reel.subtitlesUrl) {
        // Best-effort: rebuild captions file only when we already have one.
        try {
          const existing = await fetch(reel.subtitlesUrl);
          if (existing.ok) {
            assPath = join(config.processingPath, `${reelId}_outro_only.ass`);
            await writeFile(assPath, Buffer.from(await existing.arrayBuffer()));
            await appendBouncingCaptionCues(assPath, [outroResult.subtitle]);
            localFiles.push(assPath);
          }
        } catch {
          /* keep prior subtitles */
        }
      }
    }

    await updateStatus(reelId, "uploading", 90, { currentStep: "Uploading video" });
    const videoBuffer = await readFile(finalPath);
    const prevOutput = reel.outputUrl;
    reel.outputUrl = await uploadVideo(videoBuffer, "reels", `${reelId}.mp4`);
    if (prevOutput && prevOutput !== reel.outputUrl) {
      await deleteFromS3(prevOutput).catch(() => {});
    }
    if (assPath) {
      const assContent = await readFile(assPath, "utf-8");
      const prevSubs = reel.subtitlesUrl;
      reel.subtitlesUrl = await uploadSubtitles(assContent, reelId);
      if (prevSubs && prevSubs !== reel.subtitlesUrl) {
        await deleteFromS3(prevSubs).catch(() => {});
      }
    }

    const runBreakdown = await buildReelCostBreakdown(reel, {
      llmModel: models.llm,
      tts,
      measuredCosts,
    });
    reel.costBreakdown = hadPriorOutput
      ? accumulateReelCostBreakdown(reel.costBreakdown, runBreakdown, "Outro re-render")
      : runBreakdown;
    reel.costUsd = reel.costBreakdown.totalUsd;
    reel.status = "completed";
    reel.progress = 100;
    reel.currentStep = undefined;
    reel.error = undefined;
    await reel.save();

    await cleanupFiles(localFiles);
    await cleanupRenderScratch(reelId);
    console.log(`🎉 Outro-only re-render complete: ${reel._id}`);
  } catch (error: unknown) {
    await cleanupFiles(localFiles);
    await cleanupRenderScratch(reelId);
    await failProduce(reelId, error);
    throw error;
  }
}

/** Plan stage body — LLM script/scene-graph (or structure a user-provided
 *  story), resolve the voice, and save the scene graph. Reuses an existing plan
 *  when scenes are already present (edited/approved plans re-run cheaply). */
async function planGameplayReel(reel: IReel, recipe: NicheRecipe): Promise<void> {
  const reelId = reel._id.toString();
  const models = resolveModels(reel.tier as Tier);
  await ensureDir(config.processingPath);
  await updateStatus(reelId, "planning", 5, { currentStep: "Writing Reddit script" });

  const canReusePlan =
    reel.scenes.length > 0 && Boolean(reel.redditStory?.title && reel.redditStory?.body);
  if (canReusePlan) {
    const stabilized = stabilizeRedditCard(reel.redditStory!);
    reel.redditStory = stabilized;
    if (!reel.captionStyle) reel.captionStyle = DEFAULT_BOUNCE_CAPTION_STYLE;
    const tts = resolveStoryMatchedTts(models.tts, recipe.voice ?? {}, reel.voiceOverride, {
      title: stabilized.title,
      body: stabilized.body,
    });
    reel.narrationVoice = tts;
    console.log(`♻️  Reusing existing Reddit plan for reel ${reelId}`);
    await reel.save();
    return;
  }

  const auto = !reel.topic?.trim() || reel.topic.trim().toLowerCase() === "auto";
  const storySource = (reel.storySource ?? config.storyMode) as StorySource;
  let story: IRedditStoryPayload;
  if (!reel.redditStory) {
    const drafted = auto
      ? await takeNextStory(storySource, reel.tier as Tier)
      : await planRedditStory(reel.topic, reel.tier as Tier, reel.genre);
    const meta = drafted as StoryDraft & { source?: StorySource; storyId?: string };
    story = stabilizeRedditCard(
      toSingleRedditStoryPayload({
        title: drafted.title,
        body: drafted.body,
        source: drafted.source ?? storySource,
        genre: meta.genre ?? reel.genre,
        subreddit: meta.subreddit,
        author: meta.author,
        upvotes: meta.upvotes,
        comments: meta.comments,
        ageHours: meta.ageHours,
        seedTitle: meta.seedTitle,
        seedUrl: meta.seedUrl,
      })
    );
    story.partNumber = reel.partNumber ?? story.partNumber ?? 1;
    story.partCount = reel.partCount ?? story.partCount ?? 1;
    await markStoryReel(meta.storyId, reelId);
  } else {
    const existing = plainRedditStory(reel.redditStory);
    story = stabilizeRedditCard({
      ...existing,
      partNumber: reel.partNumber ?? existing.partNumber,
      partCount: reel.partCount ?? existing.partCount,
    });
  }

  reel.redditStory = story;
  reel.title = story.title;
  reel.hook = story.title;
  reel.scenes = buildGameplayScenesFromBody(story.body);
  if (!reel.captionStyle) reel.captionStyle = DEFAULT_BOUNCE_CAPTION_STYLE;
  const tts = resolveStoryMatchedTts(models.tts, recipe.voice ?? {}, reel.voiceOverride, {
    title: story.title,
    body: story.body,
  });
  reel.narrationVoice = tts;
  await reel.save();
  console.log(`📝 Planned Reddit reel ${reelId}: ${reel.scenes.length} sentence scene(s)`);
}

/** Plan stage body — LLM script/scene-graph (or structure a user-provided
 *  story), resolve the voice, and save the scene graph. Reuses an existing plan
 *  when scenes are already present (edited/approved plans re-run cheaply). */
async function planImageReel(
  reel: IReel,
  recipe: NicheRecipe,
  measuredCosts: MeasuredCostInput[]
): Promise<void> {
  const reelId = reel._id.toString();
  const isHybrid = recipe.strategy === "hybrid_scene";
  const models = resolveModels(reel.tier as Tier);
  const tts = resolveTtsChoice(models.tts, recipe.voice ?? {}, reel.voiceOverride ?? {});
  const artRef = await resolveArtStyleRefKeys(reel.artStyleId);
  const style = artRef
    ? { id: artRef.style.id, promptSuffix: artRef.style.promptSuffix }
    : pickStyle(recipe);
  const motionMode = resolveMotionMode(reel);

  await ensureDir(config.processingPath);
  await updateStatus(reelId, "planning", 5, { currentStep: "Writing horror scenes" });
  reel.narrationVoice = tts;

  const canReusePlan = reel.scenes.length > 0 && Boolean(reel.title && reel.hook);
  if (canReusePlan) {
    console.log(`♻️  Reusing existing plan for reel ${reelId}`);
    await reel.save();
    return;
  }

  const onUsage = (usage: { label: string; model: string; costUsd: number }) =>
    measuredCosts.push({ label: usage.label, model: usage.model, costUsd: usage.costUsd, source: "actual" });

  // Long pasted drafts are structured closely; short horror notes act as creative direction.
  const providedInstruction = reel.providedScript?.trim();
  const instructionTopic =
    isHorrorNiche(reel.niche) && providedInstruction && !isFullSourceStory(providedInstruction)
      ? providedInstruction
      : reel.topic;
  const shouldStructureProvidedScript =
    Boolean(providedInstruction) &&
    (!isHorrorNiche(reel.niche) || isFullSourceStory(providedInstruction));
  const plan = shouldStructureProvidedScript
    ? await structureUserScript(reel.niche, providedInstruction!, reel.tier as Tier, reel.genre, onUsage)
    : await planReel(reel.niche, instructionTopic, reel.tier as Tier, reel.genre, onUsage, reel.horrorReferenceId, {
        storyBible: reel.storyBible,
        partNumber: reel.partNumber,
        partCount: reel.partCount,
      });

  reel.title = plan.title;
  reel.hook = plan.hook;
  reel.thumbnailSceneIndex = plan.thumbnailSceneIndex;
  reel.style = style.promptSuffix;
  if (plan.storyBible) reel.storyBible = plan.storyBible;
  if (plan.horrorReference) reel.horrorReference = plan.horrorReference;
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
    // heroPolicy "one_climax" (horror/mythology/movie_recap today): the final
    // scene is always the hero reveal.
    isHero: isHybrid && i === plan.scenes.length - 1,
  }));
  await reel.save();
  console.log(`📝 Planned ${reel.scenes.length} scenes for reel ${reelId} (${style.id})`);
}

/** Produce stage body — images, narration, render, upload, cost. Reuses any
 *  scene assets already present (surgical/partial regeneration). Assumes the
 *  scene graph is planned. Caller owns the try/catch + cleanup. */
async function produceImageReel(
  reel: IReel,
  recipe: NicheRecipe,
  measuredCosts: MeasuredCostInput[],
  localFiles: string[]
): Promise<void> {
  // Gate BEFORE any OpenRouter spend — missing ffmpeg must not burn image/TTS credits.
  assertFfmpegReady("Produce", { fresh: true });

  const reelId = reel._id.toString();
  const isHybrid = recipe.strategy === "hybrid_scene";
  const models = resolveModels(reel.tier as Tier); // tts/video from reel tier
  const imageModel = reel.imageModelOverride || resolveModels(recipe.imageTier as Tier).image; // niche-appropriate stills
  // precedence: tier default < niche voice override < explicit pick at creation
  const tts = resolveTtsChoice(models.tts, recipe.voice ?? {}, reel.voiceOverride ?? {});
  // Reference-art style (if one is set) supplies the reference images fed to the
  // image model as style anchors.
  const artRef = await resolveArtStyleRefKeys(reel.artStyleId);
  const referenceImageUrls = artRef?.keys.length ? artRef.keys.map(cdnUrlFor) : undefined;

  {
    reel.narrationVoice = tts;
    console.log(
      `🎨 Producing reel ${reelId}${artRef ? ` (art-ref×${referenceImageUrls?.length ?? 0})` : ""} | ` +
        `image=${imageModel} | voice=${tts.model}/${tts.voice}` +
        (isHybrid ? ` | hero=${models.video}` : "")
    );

    // 2. Images — skip the hero scene; its visual comes from generateHeroVideo
    // at render time instead (no point paying for a still that's discarded).
    // Persist each still to Mongo as soon as it uploads so Studio/dashboard
    // polling can stream thumbnails instead of waiting for the full batch.
    const sceneCount = reel.scenes.length;
    await updateStatus(reelId, "generating_assets", 20, {
      currentStep: `Generating images (0/${sceneCount})`,
    });
    const imagePaths: (string | undefined)[] = [];
    const heroVideoPaths: (string | undefined)[] = [];
    for (let i = 0; i < sceneCount; i++) {
      const scene = reel.scenes[i];
      const progress = 20 + Math.round(((i + 1) / sceneCount) * 25);
      const step = `Image ${i + 1}/${sceneCount}`;
      if (scene.isHero) {
        if (scene.assetUrl) {
          const heroVideoPath = await downloadGeneratedAsset(scene.assetUrl, `${reelId}_${i}_hero_reused.mp4`);
          heroVideoPaths[i] = heroVideoPath;
          localFiles.push(heroVideoPath);
        }
        imagePaths.push(undefined);
        await persistProduceProgress(reel, "generating_assets", progress, `${step} (hero video)`);
        continue;
      }
      if (scene.assetUrl) {
        const imagePath = await downloadGeneratedAsset(scene.assetUrl, `${reelId}_${i}_reused.png`);
        imagePaths.push(imagePath);
        localFiles.push(imagePath);
        await persistProduceProgress(reel, "generating_assets", progress, `${step} (cached)`);
        continue;
      }
      console.log(`🖼️  Reel ${reelId}: generating ${step}`);
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
      await persistProduceProgress(reel, "generating_assets", progress, step);
    }

    // 3. Narration (silence-trimmed per scene) — stream each audioUrl the same way.
    await updateStatus(reelId, "generating_audio", 50, {
      currentStep: `Generating narration (0/${sceneCount})`,
    });
    const audioPaths: string[] = [];
    for (let i = 0; i < sceneCount; i++) {
      const scene = reel.scenes[i];
      const progress = 50 + Math.round(((i + 1) / sceneCount) * 20);
      const step = `Narration ${i + 1}/${sceneCount}`;
      if (scene.audioUrl) {
        const audioPath = await downloadGeneratedAsset(scene.audioUrl, `${reelId}_${i}_reused.mp3`);
        audioPaths.push(audioPath);
        localFiles.push(audioPath);
        await persistProduceProgress(reel, "generating_audio", progress, `${step} (cached)`);
        continue;
      }
      console.log(`🎙️  Reel ${reelId}: generating ${step}`);
      const { audioPath } = await generateNarration(narrationForTts(scene.narration, reel.niche), {
        model: tts.model,
        voice: tts.voice,
        format: tts.format,
        profile: narrationProfileFor(reel),
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
      await persistProduceProgress(reel, "generating_audio", progress, step);
    }

    // 4. Render (align happens inside, from actual durations)
    await updateStatus(reelId, "rendering", 75, { currentStep: "Assembling video" });
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
            captionStyle: reel.captionStyle,
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
            captionStyle: reel.captionStyle,
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
            captionStyle: reel.captionStyle,
          }
        );
    if (result.assemblyPath) {
      await persistAssemblyVideo(reel, result.assemblyPath, localFiles);
    }

    // Co-creatable cinematic edit FX (rain/grain/vignette/letterbox) — a final
    // pass over the reel BODY, before the branded outro so the outro stays clean.
    // Render-only: a caption/preset re-render re-applies these for free.
    if (hasEditEffects(reel.editEffects)) {
      const fxPath = join(config.processingPath, `${reelId}_fx.mp4`);
      await applyEditEffects(result.videoPath, fxPath, reel.editEffects);
      localFiles.push(fxPath);
      result.videoPath = fxPath;
    }

    result.videoPath = await applyOpeningShortsCover(reel, result.videoPath, localFiles);
    // Cache body (pre-outro) so Studio outro edits can skip a full rebuild.
    await persistBodyVideo(reel, result.videoPath, localFiles);

    const outroResult = await appendBrandedOutro(result.videoPath, reel, tts, (usage) => {
      measuredCosts.push({
        label: "Outro narration",
        model: `${tts.model}/${tts.voice}`,
        costUsd: usage.costUsd,
        source: usage.costUsd !== undefined ? "actual" : "estimated",
      });
    });
    if (outroResult) {
      localFiles.push(outroResult.videoPath);
      result.videoPath = outroResult.videoPath;
      result.totalDuration += outroResult.durationAdded;
      await persistOutroAudio(reel, outroResult, localFiles);
      if (outroResult.subtitle) {
        await appendBouncingCaptionCues(result.assPath, [outroResult.subtitle]);
      }
    }
    localFiles.push(result.videoPath, result.assPath);

    // record resolved timings
    result.scenes.forEach((t, i) => {
      reel.scenes[i].startTime = t.startTime;
      reel.scenes[i].duration = t.duration;
    });
    // 5. Upload — caption burn hard-fails above, so success always means burned-in.
    await updateStatus(reelId, "uploading", 92, { currentStep: "Uploading video" });
    reel.captionsBurned = true;
    reel.captionBurnError = undefined;
    const videoBuffer = await readFile(result.videoPath);
    reel.outputUrl = await uploadVideo(videoBuffer, "reels", `${reelId}.mp4`);
    const assContent = await readFile(result.assPath, "utf-8");
    reel.subtitlesUrl = await uploadSubtitles(assContent, reelId);
    // Build the review package (incl. the AI thumbnail) only on the FIRST
    // completion — a re-render (caption/preset edit) keeps the existing,
    // possibly user-edited, review so we never re-spend on a thumbnail. The
    // Studio's "Generate AI Thumbnail" button regenerates it on demand.
    if (!reel.review) {
      reel.review = await buildReelReviewPackage(reel, (usage) => {
        measuredCosts.push({
          label: "Thumbnail image",
          model: resolveModels("cheap").image,
          costUsd: usage.costUsd,
          source: usage.costUsd !== undefined ? "actual" : "estimated",
        });
      });
    }
    const heroScene = isHybrid ? result.scenes.find((_, i) => reel.scenes[i]?.isHero) : undefined;
    const hadPriorOutput = Boolean(reel.outputUrl);
    const runBreakdown = await buildReelCostBreakdown(reel, {
      llmModel: models.llm,
      tts,
      measuredCosts,
      heroVideoModel: isHybrid ? models.video : undefined,
      heroDurationSec: heroScene ? Math.min(Math.max(Math.round(heroScene.duration), 4), 8) : undefined,
    });
    const costBreakdown = hadPriorOutput
      ? accumulateReelCostBreakdown(reel.costBreakdown, runBreakdown, "Re-render")
      : runBreakdown;
    reel.costBreakdown = costBreakdown;
    reel.costUsd = costBreakdown.totalUsd;

    reel.status = "completed";
    reel.progress = 100;
    reel.currentStep = undefined;
    // Mark publish pending in the same write as completed so studio polling
    // doesn't stop between "done" and the auto-publish enqueue.
    if (config.autoPublishYoutube) {
      if (reel.youtube) reel.youtube.status = "pending";
      else reel.youtube = { status: "pending" };
    }
    await reel.save();
    await markHorrorReferenceUsed(reel.horrorReference?.referenceId?.toString(), reelId);
    if (config.autoPublishYoutube) await enqueuePublish(reelId, "youtube");

    await cleanupFiles(localFiles);
    await cleanupRenderScratch(reelId);
    console.log(`🎉 Reel complete: ${reel._id} (${result.totalDuration.toFixed(1)}s)`);
  }
}

/** Reddit / AITA pipeline: planned story → narration → gameplay overlay → upload. */
async function processGameplayReel(
  reel: IReel,
  recipe: NicheRecipe,
  options: { requireCachedNarration?: boolean } = {}
): Promise<void> {
  const reelId = reel._id.toString();
  const localFiles: string[] = [];
  const models = resolveModels(reel.tier as Tier);

  try {
    // Gate before any OpenRouter spend — missing ffmpeg must not burn TTS credits.
    assertFfmpegReady("Gameplay produce", { fresh: true });

    await ensureDir(config.processingPath);

    // Ensure a plan exists (auto pipeline may skip plan_review).
    if (!reel.redditStory?.body || reel.scenes.length === 0) {
      await planGameplayReel(reel, recipe);
      await reel.save();
    } else {
      reel.redditStory = stabilizeRedditCard(reel.redditStory);
      syncRedditBodyFromScenes(reel);
    }

    const story = reel.redditStory!;
    story.partNumber = reel.partNumber ?? story.partNumber;
    story.partCount = reel.partCount ?? story.partCount;
    const { path: gameplayPath, key: gameplayKey } = await pickGameplay(reel.gameplayKey);
    reel.gameplayKey = gameplayKey;
    localFiles.push(gameplayPath);

    reel.title = story.title;
    reel.hook = story.title;
    const bodySentences = reel.scenes.map((s) => s.narration.trim()).filter(Boolean);
    const tts = resolveStoryMatchedTts(models.tts, recipe.voice ?? {}, reel.voiceOverride, {
      title: story.title,
      body: bodySentences.join(" ") || story.body,
    });
    reel.narrationVoice = tts;
    if (!reel.captionStyle) reel.captionStyle = DEFAULT_BOUNCE_CAPTION_STYLE;
    await reel.save();

    // Download cached paced narration segments (title / sentences / part-outro).
    const partOutroText = getPartOutroText(story);
    const cachedSegmentPaths: (string | undefined)[] = [];
    let shortsCoverPath: string | undefined;
    let shortsCoverBackground: GameplayRenderOpts["shortsCoverBackground"];
    if (reel.shortsCover?.imageUrl && reel.shortsCover.placement === "opening") {
      shortsCoverPath = await downloadGeneratedAsset(reel.shortsCover.imageUrl, `${reelId}_shorts_cover.png`);
      localFiles.push(shortsCoverPath);
      const editorState = reel.shortsCover.editorState as { background?: GameplayRenderOpts["shortsCoverBackground"] } | undefined;
      shortsCoverBackground = editorState?.background;
    }
    if (reel.titleAudioUrl) {
      const titlePath = await downloadGeneratedAsset(reel.titleAudioUrl, `${reelId}_title_reused.mp3`);
      cachedSegmentPaths[0] = titlePath;
      localFiles.push(titlePath);
    }
    for (let i = 0; i < bodySentences.length; i++) {
      const url = reel.scenes[i]?.audioUrl;
      if (!url) continue;
      const path = await downloadGeneratedAsset(url, `${reelId}_body_${i}_reused.mp3`);
      cachedSegmentPaths[i + 1] = path;
      localFiles.push(path);
    }
    if (partOutroText && reel.partOutroAudioUrl) {
      const path = await downloadGeneratedAsset(
        reel.partOutroAudioUrl,
        `${reelId}_part_outro_reused.mp3`
      );
      cachedSegmentPaths[1 + bodySentences.length] = path;
      localFiles.push(path);
    }

    if (options.requireCachedNarration) {
      const need = 1 + bodySentences.length + (partOutroText ? 1 : 0);
      const have = cachedSegmentPaths.filter(Boolean).length;
      if (have < need) {
        throw new Error(
          `Composite-only requires cached narration (${have}/${need} segments). Run a normal re-render once to populate the cache.`
        );
      }
    }

    await updateStatus(reelId, "generating_audio", 25, {
      currentStep: "Generating narration",
    });
    const gameplayMeasuredCosts: MeasuredCostInput[] = [];
    const hadPriorOutput = Boolean(reel.outputUrl);
    let narrationSpendUsd = 0;
    let narrationCalls = 0;
    const result = await renderGameplayReel(reelId, story, gameplayPath, {
      ...tts,
      bodySentences,
      captionStyle: reel.captionStyle,
      cachedSegmentPaths,
      shortsCoverPath,
      shortsCoverBackground,
      onNarrationUsage: (usage) => {
        narrationCalls += 1;
        if (usage.costUsd !== undefined) narrationSpendUsd += usage.costUsd;
      },
      onNarrationProgress: async ({ index, total, label, generated }) => {
        const progress = 25 + Math.round(((index + 1) / total) * 20);
        await updateStatus(reelId, "generating_audio", progress, {
          currentStep: generated ? label : `${label} (cached)`,
        });
      },
      onNarrationComplete: async () => {
        await updateStatus(reelId, "rendering", 45, {
          currentStep: "Compositing gameplay",
        });
      },
    });

    // Retain paced segments for upload + disk cleanup.
    const segs = result.narrationSegments;
    localFiles.push(segs.titlePath, ...segs.bodyPaths);
    if (segs.partOutroPath) localFiles.push(segs.partOutroPath);

    if (segs.titleGenerated) {
      const url = await uploadAudio(await readFile(segs.titlePath), `${reelId}_title.mp3`);
      await replaceCachedMediaUrl(reel, "titleAudioUrl", url);
    }
    for (let i = 0; i < segs.bodyPaths.length; i++) {
      if (!segs.bodyGenerated[i] || !reel.scenes[i]) continue;
      const prev = reel.scenes[i].audioUrl;
      const url = await uploadAudio(await readFile(segs.bodyPaths[i]), `${reelId}_body_${i}.mp3`);
      reel.scenes[i].audioUrl = url;
      if (prev && prev !== url) await deleteFromS3(prev).catch(() => {});
    }
    if (segs.partOutroPath && segs.partOutroGenerated) {
      const url = await uploadAudio(await readFile(segs.partOutroPath), `${reelId}_part_outro.mp3`);
      await replaceCachedMediaUrl(reel, "partOutroAudioUrl", url);
    } else if (!partOutroText && reel.partOutroAudioUrl) {
      await replaceCachedMediaUrl(reel, "partOutroAudioUrl", undefined);
    }
    reel.markModified("scenes");

    if (narrationCalls > 0) {
      gameplayMeasuredCosts.push({
        label: "Narration",
        model: `${tts.model}/${tts.voice}`,
        costUsd: narrationSpendUsd > 0 ? narrationSpendUsd : undefined,
        source: narrationSpendUsd > 0 ? "actual" : "estimated",
      });
      if (!(narrationSpendUsd > 0)) {
        gameplayMeasuredCosts.pop();
      }
    } else if (segs.generatedCount === 0) {
      console.log(`♻️  Gameplay reel ${reelId}: reused all narration segments (0 TTS calls)`);
    }

    await persistBodyVideo(reel, result.videoPath, localFiles);

    const outroResult = await appendBrandedOutro(
      result.videoPath,
      reel,
      tts,
      (usage) => {
        gameplayMeasuredCosts.push({
          label: "Outro narration",
          model: `${tts.model}/${tts.voice}`,
          costUsd: usage.costUsd,
          source: usage.costUsd !== undefined ? "actual" : "estimated",
        });
      },
      { backgroundVideo: gameplayPath }
    );
    if (outroResult) {
      localFiles.push(outroResult.videoPath);
      result.videoPath = outroResult.videoPath;
      result.totalDuration += outroResult.durationAdded;
      await persistOutroAudio(reel, outroResult, localFiles);
    }
    localFiles.push(result.videoPath, result.assPath);
    if (reel.scenes[0]) reel.scenes[0].duration = result.totalDuration;

    await updateStatus(reelId, "uploading", 90, { currentStep: "Uploading video" });
    reel.captionsBurned = true;
    reel.captionBurnError = undefined;
    const videoBuffer = await readFile(result.videoPath);
    const prevOutput = reel.outputUrl;
    reel.outputUrl = await uploadVideo(videoBuffer, "reels", `${reelId}.mp4`);
    if (prevOutput && prevOutput !== reel.outputUrl) {
      await deleteFromS3(prevOutput).catch(() => {});
    }
    const assContent = await readFile(result.assPath, "utf-8");
    reel.subtitlesUrl = await uploadSubtitles(assContent, reelId);
    if (!reel.review) {
      reel.review = await buildReelReviewPackage(reel, (usage) => {
        gameplayMeasuredCosts.push({
          label: "Thumbnail image",
          model: resolveModels("cheap").image,
          costUsd: usage.costUsd,
          source: usage.costUsd !== undefined ? "actual" : "estimated",
        });
      });
    }
    const runBreakdown = await buildReelCostBreakdown(reel, {
      llmModel: models.llm,
      tts,
      measuredCosts: gameplayMeasuredCosts,
    });
    const costBreakdown = hadPriorOutput
      ? accumulateReelCostBreakdown(reel.costBreakdown, runBreakdown, "Re-render")
      : runBreakdown;
    reel.costBreakdown = costBreakdown;
    reel.costUsd = costBreakdown.totalUsd;

    reel.status = "completed";
    reel.progress = 100;
    reel.currentStep = undefined;
    if (config.autoPublishYoutube) {
      if (reel.youtube) reel.youtube.status = "pending";
      else reel.youtube = { status: "pending" };
    }
    await reel.save();
    if (config.autoPublishYoutube) await enqueuePublish(reelId, "youtube");

    await cleanupFiles(localFiles);
    await cleanupRenderScratch(reelId);
    console.log(
      `🎉 Reddit reel complete: ${reel._id} (${result.totalDuration.toFixed(1)}s, TTS segments=${segs.generatedCount})`
    );
  } catch (error: unknown) {
    await cleanupFiles(localFiles);
    await cleanupRenderScratch(reelId);
    await failProduce(reelId, error);
    throw error;
  }
}

export async function getReel(id: string): Promise<IReel | null> {
  return Reel.findById(id);
}

export async function listReels(limit = 50): Promise<IReel[]> {
  return Reel.find().sort({ createdAt: -1 }).limit(limit);
}

export async function listReelsBySeries(seriesId: string): Promise<IReel[]> {
  return Reel.find({ seriesId }).sort({ partNumber: 1, createdAt: 1 });
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
    reel.bodyVideoUrl,
    reel.assemblyVideoUrl,
    reel.subtitlesUrl,
    reel.titleAudioUrl,
    reel.partOutroAudioUrl,
    reel.outroAudioUrl,
    reel.review?.thumbnailUrl,
    reel.shortsCover?.imageUrl,
    ...reel.scenes.flatMap((s) => [s.assetUrl, s.audioUrl]),
    ...reel.voiceVariants.map((v) => v.videoUrl),
  ].filter((url): url is string => Boolean(url));

  await Promise.all(assetUrls.map((url) => deleteFromS3(url).catch(() => {})));
  // Locally staged drafts (edit previews, thumbnail studio) live only on this
  // server's disk — wipe them too or they outlive the reel forever.
  for (const rootDir of [reel.editDraft?.rootDir, reel.thumbnailDraft?.rootDir]) {
    if (rootDir) await cleanupDirectory(rootDir).catch(() => {});
  }
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
