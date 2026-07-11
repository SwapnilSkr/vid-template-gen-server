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
  | "plan_review" // paused after cheap plan; awaiting human review/approval
  | "generating_assets" // image generation
  | "generating_audio" // TTS narration
  | "aligning" // caption timing from actual audio durations
  | "rendering" // FFmpeg assembly
  | "uploading"
  | "completed"
  | "failed";

/** Whether the pipeline pauses for human review after planning.
 *  - review: stop at `plan_review` after the cheap plan; produce on approval.
 *  - auto:   plan chains straight into production (high-volume, e.g. Reddit). */
export type ReelPipelineMode = "auto" | "review";

/** Motion config for animating a still.
 *  - ken_burns: classic pan/zoom (fake motion)
 *  - static:    no motion
 *  - parallax:  FFmpeg "living still" — layered drift + fog + breathing (free)
 *  - ai_motion: real image-to-video clip generated from the still (paid) */
export interface ISceneMotion {
  type: "ken_burns" | "static" | "parallax" | "ai_motion";
  direction: "in" | "out";
  /** 0-1 motion strength (parallax drift / breathing amplitude). Default ~0.5. */
  intensity?: number;
}

/** Per-reel motion policy, resolved into per-scene motion types at plan time. */
export type ReelMotionMode = "ken_burns" | "parallax" | "ai_hybrid" | "ai_full";

/** Deep story materials produced by the two-pass horror planner (Pass 1).
 *  Persisted so the story arc is inspectable and reusable (review/thumbnail). */
export interface IStoryBible {
  premise: string;
  setting: string;
  protagonist: string;
  anchorObject: string; // the ordinary object/place that turns impossible
  impossibleRule: string; // the single supernatural law of this story
  escalation: string[]; // beat-by-beat dread ladder
  soundCues?: string[]; // per-beat sound-design hints
  artDirection: string; // recurring visual motifs (keeps scenes coherent)
  finalTwist: string; // the recontextualizing last line
}

/** Caption cue produced by the align stage (drives ASS karaoke). */
export interface ICaptionCue {
  t: number; // start (s, global timeline)
  end: number; // end (s, global timeline)
  text: string;
}

/** Editable caption look — threaded into `buildPortraitKaraoke`'s ASS style.
 *  Every field is optional; unset falls back to the renderer's built-in default
 *  (Arial 64, white idle / amber active, MarginV 320, 4-word chunks) so an
 *  untouched reel renders exactly as before. Manually edited by the user
 *  (non-AI) in the Studio's live caption editor. */
export interface ICaptionStyle {
  fontName?: string;
  fontSize?: number;
  primaryColor?: string; // idle word, #RRGGBB
  activeColor?: string; // spoken word highlight, #RRGGBB (== primary → no highlight)
  outlineColor?: string; // #RRGGBB
  outlineWidth?: number;
  shadow?: number;
  alignment?: number; // ASS numpad 1-9 (2 = bottom-center)
  marginV?: number; // vertical margin from the alignment edge (px @ 1080×1920)
  marginL?: number;
  marginR?: number;
  chunkSize?: number; // words shown together (1 = one word at a time)
  bold?: boolean;
  uppercase?: boolean; // render caption text ALL CAPS
  animation?: "none" | "pop";
  karaoke?: boolean; // letter-by-letter fill: word starts in activeColor, text (primaryColor) catches up as spoken. Off = flat text colour only.
}

/** Voice post-processing controls (applied at render — no TTS re-spend). */
export interface IAudioPost {
  voiceProfile?: "none" | "horror" | "whisper" | "phone" | "tape" | "distant"; // narration FX profile
  bedVolume?: number; // 0-1 mix level for the horror audio bed (horrorAudioKey)
}

/** Co-creatable cinematic editing effects applied as a final full-video pass
 *  (applyEditEffects in reel-render.service.ts) — render-only, so toggling any
 *  of these just needs a free re-render, no asset regeneration. All optional;
 *  an unset/empty object leaves the reel exactly as the base render. */
export interface IEditEffects {
  rain?: boolean; // procedural animated rain overlay (white alpha streaks)
  rainIntensity?: number; // 0-1 opacity of the rain (default ~0.5)
  grain?: number; // 0-1.5 extra film grain (0 = none)
  vignette?: number; // 0-1 extra vignette darkening (0 = none)
  letterbox?: boolean; // cinematic black bars top + bottom
  desaturate?: number; // 0-1 cold desaturation pass
  flicker?: number; // 0-1 unstable light flicker
  chromatic?: number; // 0-1 red/blue channel shift
  scanlines?: number; // 0-1 analog scanline overlay
}

/** Rendered outro copy/brand overrides. These are render-only: changing them
 *  should rebuild the local preview/final video, not scene stills or narration. */
export interface IOutroSettings {
  channelName?: string;
  channelHandle?: string;
  spokenLine?: string;
  title?: string;
  subtitle?: string;
  cta?: string;
  footer?: string;
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

export interface ISceneDraftAsset {
  index: number;
  assetUrl?: string;
  audioUrl?: string;
  assetPath?: string;
  audioPath?: string;
}

export interface IReelEditDraft {
  id: string;
  kind: "scene_regen" | "render_only";
  status: "ready";
  sceneAssets: ISceneDraftAsset[];
  outputUrl?: string;
  outputPath?: string;
  subtitlesUrl?: string;
  subtitlesPath?: string;
  rootDir: string;
  createdAt: Date;
}

/** A locally staged thumbnail composition (Thumbnail Studio). The composed PNG
 *  lives under `rootDir` on this server only — nothing touches S3 until the
 *  draft is saved (upload + delete superseded thumbnail) or it is wiped on
 *  discard/restage/reel delete, so abandoned experiments never bloat storage.
 *  `input` echoes the composition controls so the studio can restore them. */
export interface IThumbnailDraft {
  id: string;
  rootDir: string;
  imagePath: string;
  imageUrl: string; // local /api/reels/thumb-drafts/... serving URL
  input?: Record<string, unknown>;
  aspectRatio?: "16:9" | "9:16" | "1:1";
  createdAt: Date;
}

/** YouTube publish state — separate from the render pipeline `status` so a
 *  publish retry never re-triggers rendering/asset generation. */
export interface IYouTubePublish {
  status: "pending" | "uploading" | "published" | "failed";
  videoId?: string;
  url?: string;
  error?: string;
  channelId?: string;
  channelLabel?: string;
  thumbnailStatus?: "pending" | "uploaded" | "missing" | "failed";
  thumbnailError?: string;
  /**
   * Whether the Shorts vertical cover (`oar2`) changed after our custom upload.
   * `unchanged` means YouTube kept an auto-picked video frame for the Shorts
   * shelf even though `thumbnails.set` succeeded for classic surfaces.
   */
  shortsCoverStatus?: "applied" | "unchanged" | "unknown";
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
  /** Source author handle without `u/` — used when cardUsername is unset. */
  author?: string;
  /** Display username on the title card (with or without `u/` prefix). */
  cardUsername?: string;
  upvotes?: number;
  comments?: number;
  ageHours?: number;
  seedTitle?: string;
  seedUrl?: string;
  partNumber?: number;
  partCount?: number;
}

export interface IHorrorReferencePayload {
  referenceId?: Types.ObjectId;
  title: string;
  author?: string;
  sourceUrl: string;
  license?: "public_domain" | "unknown";
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
  artStyleId?: string; // reference-art style (config/art-styles.ts) if chosen
  presetId?: string; // style preset (config/style-presets.ts) that seeded this reel
  motionMode?: ReelMotionMode; // per-reel motion policy
  captionStyle?: ICaptionStyle; // editable caption look (Studio)
  audioPost?: IAudioPost; // voice post-processing / bed mix
  editEffects?: IEditEffects; // cinematic edit FX (rain/grain/vignette/letterbox), render-only
  pipelineMode?: ReelPipelineMode; // gate after planning ("review") or run through ("auto")
  providedScript?: string; // user-pasted story, structured into scenes at plan time
  tier: "cheap" | "value" | "premium";
  storySource?: "llm" | "hybrid" | "verbatim";
  genre?: string;

  title?: string;
  hook?: string;
  storyBible?: IStoryBible;
  scenes: IScene[];
  redditStory?: IRedditStoryPayload;
  horrorReference?: IHorrorReferencePayload;
  horrorReferenceId?: string; // user-picked reference (feeds the planner before horrorReference resolves)
  seriesId?: string;
  partNumber?: number;
  partCount?: number;

  /** S3 key of the gameplay clip used for this reel (gameplay_overlay only) —
   *  either chosen at creation or picked randomly and recorded so revoice
   *  reuses the exact same background instead of swapping it. */
  gameplayKey?: string;
  horrorAudioKey?: string;
  /** Connected YouTube channel id used for rendered outro branding. */
  outroChannelId?: string;
  outro?: IOutroSettings;
  thumbnailMode?: "frame" | "ai";
  imageModelOverride?: string;
  voiceOverride?: IVoiceOverride;
  narrationVoice?: IVoiceOverride;
  voiceVariants: IVoiceVariant[];
  editDraft?: IReelEditDraft;
  thumbnailDraft?: IThumbnailDraft;

  status: ReelStatus;
  progress: number;
  outputUrl?: string;
  /** Pre-outro assembled body video — enables outro-only re-renders. */
  bodyVideoUrl?: string;
  /**
   * Pre-caption scene assembly (Ken Burns / motion / hybrid). Enables caption
   * and edit-FX re-renders to skip re-assembly from stills.
   */
  assemblyVideoUrl?: string;
  subtitlesUrl?: string;
  /** False when FFmpeg caption burn soft-failed (MP4 has no burned-in text). */
  captionsBurned?: boolean;
  captionBurnError?: string;
  /** Cached title-card narration for gameplay_overlay (reused on render-only). */
  titleAudioUrl?: string;
  /** Cached "Stay tuned for part N" line for multi-part Reddit reels. */
  partOutroAudioUrl?: string;
  /** Cached branded outro narration — reused when the spoken line is unchanged. */
  outroAudioUrl?: string;
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
    type: {
      type: String,
      enum: ["ken_burns", "static", "parallax", "ai_motion"],
      default: "ken_burns",
    },
    direction: { type: String, enum: ["in", "out"], default: "in" },
    intensity: { type: Number, min: 0, max: 1 },
  },
  { _id: false }
);

const storyBibleSchema = new Schema<IStoryBible>(
  {
    premise: { type: String, required: true },
    setting: { type: String, required: true },
    protagonist: { type: String, required: true },
    anchorObject: { type: String, required: true },
    impossibleRule: { type: String, required: true },
    escalation: { type: [String], default: [] },
    soundCues: { type: [String], default: [] },
    artDirection: { type: String, required: true },
    finalTwist: { type: String, required: true },
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

const captionStyleSchema = new Schema<ICaptionStyle>(
  {
    fontName: String,
    fontSize: Number,
    primaryColor: String,
    activeColor: String,
    outlineColor: String,
    outlineWidth: Number,
    shadow: Number,
    alignment: Number,
    marginV: Number,
    marginL: Number,
    marginR: Number,
    chunkSize: Number,
    bold: Boolean,
    uppercase: Boolean,
    animation: { type: String, enum: ["none", "pop"] },
    karaoke: Boolean,
  },
  { _id: false }
);

const audioPostSchema = new Schema<IAudioPost>(
  {
    voiceProfile: { type: String, enum: ["none", "horror", "whisper", "phone", "tape", "distant"] },
    bedVolume: { type: Number, min: 0, max: 1 },
  },
  { _id: false }
);

const editEffectsSchema = new Schema<IEditEffects>(
  {
    rain: Boolean,
    rainIntensity: { type: Number, min: 0, max: 1 },
    grain: { type: Number, min: 0, max: 1.5 },
    vignette: { type: Number, min: 0, max: 1 },
    letterbox: Boolean,
    desaturate: { type: Number, min: 0, max: 1 },
    flicker: { type: Number, min: 0, max: 1 },
    chromatic: { type: Number, min: 0, max: 1 },
    scanlines: { type: Number, min: 0, max: 1 },
  },
  { _id: false }
);

const outroSettingsSchema = new Schema<IOutroSettings>(
  {
    channelName: String,
    channelHandle: String,
    spokenLine: String,
    title: String,
    subtitle: String,
    cta: String,
    footer: String,
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
    cardUsername: String,
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

const horrorReferenceSchema = new Schema<IHorrorReferencePayload>(
  {
    referenceId: { type: Schema.Types.ObjectId, ref: "HorrorReference" },
    title: { type: String, required: true },
    author: String,
    sourceUrl: { type: String, required: true },
    license: { type: String, enum: ["public_domain", "unknown"] },
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

const sceneDraftAssetSchema = new Schema<ISceneDraftAsset>(
  {
    index: { type: Number, required: true },
    assetUrl: String,
    audioUrl: String,
    assetPath: String,
    audioPath: String,
  },
  { _id: false }
);

const reelEditDraftSchema = new Schema<IReelEditDraft>(
  {
    id: { type: String, required: true },
    kind: { type: String, enum: ["scene_regen", "render_only"], required: true },
    status: { type: String, enum: ["ready"], default: "ready" },
    sceneAssets: { type: [sceneDraftAssetSchema], default: [] },
    outputUrl: String,
    outputPath: String,
    subtitlesUrl: String,
    subtitlesPath: String,
    rootDir: { type: String, required: true },
    createdAt: { type: Date, default: () => new Date() },
  },
  { _id: false }
);

const thumbnailDraftSchema = new Schema<IThumbnailDraft>(
  {
    id: { type: String, required: true },
    rootDir: { type: String, required: true },
    imagePath: { type: String, required: true },
    imageUrl: { type: String, required: true },
    input: { type: Schema.Types.Mixed },
    aspectRatio: { type: String, enum: ["16:9", "9:16", "1:1"] },
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
    channelId: String,
    channelLabel: String,
    thumbnailStatus: {
      type: String,
      enum: ["pending", "uploaded", "missing", "failed"],
    },
    thumbnailError: String,
    shortsCoverStatus: {
      type: String,
      enum: ["applied", "unchanged", "unknown"],
    },
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
    artStyleId: String,
    presetId: String,
    motionMode: {
      type: String,
      enum: ["ken_burns", "parallax", "ai_hybrid", "ai_full"],
    },
    captionStyle: captionStyleSchema,
    audioPost: audioPostSchema,
    editEffects: editEffectsSchema,
    pipelineMode: { type: String, enum: ["auto", "review"], default: "auto" },
    providedScript: String,
    tier: { type: String, enum: ["cheap", "value", "premium"], default: "cheap" },
    storySource: { type: String, enum: ["llm", "hybrid", "verbatim"] },
    genre: String,
    title: String,
    hook: String,
    storyBible: storyBibleSchema,
    scenes: { type: [sceneSchema], default: [] },
    redditStory: redditStorySchema,
    horrorReference: horrorReferenceSchema,
    horrorReferenceId: String,
    seriesId: { type: String, index: true },
    partNumber: Number,
    partCount: Number,
    gameplayKey: String,
    horrorAudioKey: String,
    outroChannelId: String,
    outro: outroSettingsSchema,
    thumbnailMode: { type: String, enum: ["frame", "ai"], default: "frame" },
    imageModelOverride: String,
    voiceOverride: voiceOverrideSchema,
    narrationVoice: voiceOverrideSchema,
    voiceVariants: { type: [voiceVariantSchema], default: [] },
    editDraft: reelEditDraftSchema,
    thumbnailDraft: thumbnailDraftSchema,
    status: {
      type: String,
      enum: [
        "pending",
        "planning",
        "plan_review",
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
    bodyVideoUrl: String,
    assemblyVideoUrl: String,
    subtitlesUrl: String,
    captionsBurned: { type: Boolean, default: true },
    captionBurnError: String,
    titleAudioUrl: String,
    partOutroAudioUrl: String,
    outroAudioUrl: String,
    review: reelReviewSchema,
    costUsd: Number,
    costBreakdown: costBreakdownSchema,
    error: String,
    youtube: youtubePublishSchema,
  },
  { timestamps: true }
);

reelSchema.index({ "redditStory.seedUrl": 1 });
reelSchema.index({ "horrorReference.sourceUrl": 1 });

export const Reel = model<IReel>("Reel", reelSchema);
