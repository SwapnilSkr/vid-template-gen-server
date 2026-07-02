import { Schema, model, type Document, type Types } from "mongoose";

// ============================================
// Scene-graph model (a "Reel" = VideoProject)
// Generalizes Composition beyond the gameplay/characters format so we can
// render image-slideshow niches (dark history, facts, horror, ...) with one
// pipeline + a pluggable render strategy. See docs/architecture/data-model.md.
// ============================================

/**
 * Render strategy id — selects how scenes become a video.
 * Only "image_kenburns" is implemented today (stills + FFmpeg motion).
 */
export type ReelStrategy =
  | "image_kenburns"
  | "gameplay_overlay"
  | "hybrid_scene"
  | "motion_graphics";

export type ReelStatus =
  | "pending"
  | "planning" // LLM writing script + scene graph
  | "generating_assets" // image generation
  | "generating_audio" // TTS narration
  | "aligning" // caption timing from actual audio durations
  | "rendering" // FFmpeg assembly
  | "uploading"
  | "completed"
  | "failed";

/** Ken Burns / motion config for animating a still. */
export interface ISceneMotion {
  type: "ken_burns" | "static";
  direction: "in" | "out";
}

/** Caption cue produced by the align stage (drives ASS karaoke). */
export interface ICaptionCue {
  t: number; // start (s, global timeline)
  end: number; // end (s, global timeline)
  text: string;
}

/** Explicit voice pick made at creation time — overrides the tier default
 *  and any niche voice override (config/niche-styles.ts) for this reel's
 *  initial render. Unset fields fall back to the normal resolution chain. */
export interface IVoiceOverride {
  model?: string;
  voice?: string;
  format?: "mp3" | "pcm";
}

/** A re-narrated render of a completed gameplay reel with a different
 *  TTS model/voice — the same story + gameplay clip, new narration only.
 *  Kept as a list so several voices can be compared before one is promoted
 *  to `reel.outputUrl`. */
export interface IVoiceVariant {
  id: string;
  model: string;
  voice: string;
  format: "mp3" | "pcm";
  label?: string;
  status: "pending" | "ready" | "failed";
  videoUrl?: string;
  error?: string;
  createdAt: Date;
}

/** YouTube publish state — separate from the render pipeline `status` so a
 *  publish retry never re-triggers rendering/asset generation. */
export interface IYouTubePublish {
  status: "pending" | "uploading" | "published" | "failed";
  videoId?: string;
  url?: string;
  error?: string;
  publishedAt?: Date;
}

export interface IReelReviewPackage {
  title?: string;
  description?: string;
  tags: string[];
  thumbnailUrl?: string;
  thumbnailPrompt?: string;
  visibilityNotes?: string;
  status: "draft" | "ready" | "approved";
  updatedAt?: Date;
}

export interface ICostLine {
  label: string;
  model?: string;
  units: number;
  unit: string;
  unitCostUsd: number;
  costUsd: number;
}

export interface ICostBreakdown {
  currency: "USD";
  totalUsd: number;
  lines: ICostLine[];
  note?: string;
  generatedAt: Date;
}

export interface IRedditStoryPayload {
  title: string;
  body: string;
  source?: "llm" | "hybrid" | "verbatim";
  genre?: string;
  subreddit?: string;
  author?: string;
  upvotes?: number;
  comments?: number;
  ageHours?: number;
  seedTitle?: string;
  seedUrl?: string;
  partNumber?: number;
  partCount?: number;
}

/** One beat: a generated visual + its narration + motion + caption timing. */
export interface IScene {
  index: number;
  narration: string;
  visualPrompt: string;
  assetUrl?: string; // S3 URL of generated still (for reuse / regeneration)
  audioUrl?: string; // S3 URL of narration audio
  motion: ISceneMotion;
  startTime: number; // resolved after audio durations are known
  duration: number; // actual rendered scene duration
  captionCues?: ICaptionCue[];
  isHero: boolean; // reserved: render as real AI-video clip (hybrid_scene)
}

export interface IReel extends Document {
  _id: Types.ObjectId;
  niche: string; // "dark_history" | "facts" | "horror" | ...
  topic: string; // seed idea
  strategy: ReelStrategy;
  style: string; // visual style suffix (sepia, cinematic, ...)
  tier: "cheap" | "value" | "premium";
  storySource?: "llm" | "hybrid" | "verbatim";
  genre?: string;

  title?: string;
  hook?: string;
  scenes: IScene[];
  redditStory?: IRedditStoryPayload;
  seriesId?: string;
  partNumber?: number;
  partCount?: number;

  /** S3 key of the gameplay clip used for this reel (gameplay_overlay only) —
   *  either chosen at creation or picked randomly and recorded so revoice
   *  reuses the exact same background instead of swapping it. */
  gameplayKey?: string;
  horrorAudioKey?: string;
  imageModelOverride?: string;
  voiceOverride?: IVoiceOverride;
  voiceVariants: IVoiceVariant[];

  status: ReelStatus;
  progress: number;
  outputUrl?: string;
  subtitlesUrl?: string;
  review?: IReelReviewPackage;
  costUsd?: number;
  costBreakdown?: ICostBreakdown;
  error?: string;
  youtube?: IYouTubePublish;

  createdAt: Date;
  updatedAt: Date;
}

// ============================================
// Schemas
// ============================================

const sceneMotionSchema = new Schema<ISceneMotion>(
  {
    type: { type: String, enum: ["ken_burns", "static"], default: "ken_burns" },
    direction: { type: String, enum: ["in", "out"], default: "in" },
  },
  { _id: false }
);

const captionCueSchema = new Schema<ICaptionCue>(
  {
    t: { type: Number, required: true },
    end: { type: Number, required: true },
    text: { type: String, required: true },
  },
  { _id: false }
);

const redditStorySchema = new Schema<IRedditStoryPayload>(
  {
    title: { type: String, required: true },
    body: { type: String, required: true },
    source: { type: String, enum: ["llm", "hybrid", "verbatim"] },
    genre: String,
    subreddit: String,
    author: String,
    upvotes: Number,
    comments: Number,
    ageHours: Number,
    seedTitle: String,
    seedUrl: String,
    partNumber: Number,
    partCount: Number,
  },
  { _id: false }
);

const voiceOverrideSchema = new Schema<IVoiceOverride>(
  {
    model: String,
    voice: String,
    format: { type: String, enum: ["mp3", "pcm"] },
  },
  { _id: false }
);

const voiceVariantSchema = new Schema<IVoiceVariant>(
  {
    id: { type: String, required: true },
    model: { type: String, required: true },
    voice: { type: String, required: true },
    format: { type: String, enum: ["mp3", "pcm"], required: true },
    label: String,
    status: {
      type: String,
      enum: ["pending", "ready", "failed"],
      default: "pending",
    },
    videoUrl: String,
    error: String,
    createdAt: { type: Date, default: () => new Date() },
  },
  { _id: false }
);

const youtubePublishSchema = new Schema<IYouTubePublish>(
  {
    status: {
      type: String,
      enum: ["pending", "uploading", "published", "failed"],
      default: "pending",
    },
    videoId: String,
    url: String,
    error: String,
    publishedAt: Date,
  },
  { _id: false }
);

const reelReviewSchema = new Schema<IReelReviewPackage>(
  {
    title: String,
    description: String,
    tags: { type: [String], default: [] },
    thumbnailUrl: String,
    thumbnailPrompt: String,
    visibilityNotes: String,
    status: {
      type: String,
      enum: ["draft", "ready", "approved"],
      default: "draft",
      index: true,
    },
    updatedAt: Date,
  },
  { _id: false }
);

const costLineSchema = new Schema<ICostLine>(
  {
    label: { type: String, required: true },
    model: String,
    units: { type: Number, required: true },
    unit: { type: String, required: true },
    unitCostUsd: { type: Number, required: true },
    costUsd: { type: Number, required: true },
  },
  { _id: false }
);

const costBreakdownSchema = new Schema<ICostBreakdown>(
  {
    currency: { type: String, enum: ["USD"], default: "USD" },
    totalUsd: { type: Number, required: true },
    lines: { type: [costLineSchema], default: [] },
    note: String,
    generatedAt: { type: Date, default: () => new Date() },
  },
  { _id: false }
);

const sceneSchema = new Schema<IScene>(
  {
    index: { type: Number, required: true },
    narration: { type: String, required: true },
    visualPrompt: { type: String, required: true },
    assetUrl: { type: String },
    audioUrl: { type: String },
    motion: { type: sceneMotionSchema, default: () => ({}) },
    startTime: { type: Number, default: 0 },
    duration: { type: Number, default: 0 },
    captionCues: { type: [captionCueSchema], default: [] },
    isHero: { type: Boolean, default: false },
  },
  { _id: false }
);

const reelSchema = new Schema<IReel>(
  {
    niche: { type: String, required: true },
    topic: { type: String, required: true },
    strategy: {
      type: String,
      enum: ["image_kenburns", "gameplay_overlay", "hybrid_scene", "motion_graphics"],
      default: "image_kenburns",
    },
    style: { type: String, default: "cinematic" },
    tier: { type: String, enum: ["cheap", "value", "premium"], default: "cheap" },
    storySource: { type: String, enum: ["llm", "hybrid", "verbatim"] },
    genre: String,
    title: String,
    hook: String,
    scenes: { type: [sceneSchema], default: [] },
    redditStory: redditStorySchema,
    seriesId: { type: String, index: true },
    partNumber: Number,
    partCount: Number,
    gameplayKey: String,
    horrorAudioKey: String,
    imageModelOverride: String,
    voiceOverride: voiceOverrideSchema,
    voiceVariants: { type: [voiceVariantSchema], default: [] },
    status: {
      type: String,
      enum: [
        "pending",
        "planning",
        "generating_assets",
        "generating_audio",
        "aligning",
        "rendering",
        "uploading",
        "completed",
        "failed",
      ],
      default: "pending",
    },
    progress: { type: Number, default: 0, min: 0, max: 100 },
    outputUrl: String,
    subtitlesUrl: String,
    review: reelReviewSchema,
    costUsd: Number,
    costBreakdown: costBreakdownSchema,
    error: String,
    youtube: youtubePublishSchema,
  },
  { timestamps: true }
);

export const Reel = model<IReel>("Reel", reelSchema);
