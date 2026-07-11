import { t } from "elysia";

/**
 * Create reel request body.
 * `topic` is optional/empty/"auto" → pulls from the story bank (Reddit niche)
 * or lets the planner pick freely (other niches).
 */
/** Co-creatable cinematic edit effects (render-only). Shared by create + settings. */
export const EditEffectsBody = t.Object({
  rain: t.Optional(t.Boolean()),
  rainIntensity: t.Optional(t.Number({ minimum: 0, maximum: 1 })),
  grain: t.Optional(t.Number({ minimum: 0, maximum: 1.5 })),
  vignette: t.Optional(t.Number({ minimum: 0, maximum: 1 })),
  letterbox: t.Optional(t.Boolean()),
  desaturate: t.Optional(t.Number({ minimum: 0, maximum: 1 })),
  flicker: t.Optional(t.Number({ minimum: 0, maximum: 1 })),
  chromatic: t.Optional(t.Number({ minimum: 0, maximum: 1 })),
  scanlines: t.Optional(t.Number({ minimum: 0, maximum: 1 })),
});

export const OutroSettingsBody = t.Object({
  channelName: t.Optional(t.String()),
  channelHandle: t.Optional(t.String()),
  spokenLine: t.Optional(t.String()),
  title: t.Optional(t.String()),
  subtitle: t.Optional(t.String()),
  cta: t.Optional(t.String()),
  footer: t.Optional(t.String()),
});

export const CreateReelBody = t.Object({
  niche: t.String(),
  genre: t.Optional(t.String()),
  topic: t.Optional(t.String()),
  tier: t.Optional(
    t.Union([t.Literal("cheap"), t.Literal("value"), t.Literal("premium")])
  ),
  source: t.Optional(
    t.Union([t.Literal("llm"), t.Literal("hybrid"), t.Literal("verbatim")])
  ),
  parts: t.Optional(t.Union([t.Literal("off"), t.Literal("auto"), t.Number()])),
  /** explicit S3 key (gameplay/xxx.mp4) to use instead of a random pick */
  gameplayKey: t.Optional(t.String()),
  /** explicit global S3 key (horror-audio/xxx.mp3) for horror background bed */
  horrorAudioKey: t.Optional(t.String()),
  /** connected YouTube channel id used for rendered outro branding */
  outroChannelId: t.Optional(t.String()),
  /** rendered outro copy/brand overrides */
  outro: t.Optional(OutroSettingsBody),
  /** thumbnail generation policy: pick a video frame later, or generate AI thumbnail during render */
  thumbnailMode: t.Optional(t.Union([t.Literal("frame"), t.Literal("ai")])),
  /** explicit image model pick from the compatible image model catalog */
  imageModel: t.Optional(t.String()),
  /** reference-art style id (config/art-styles.ts) for horror/image niches */
  artStyleId: t.Optional(t.String()),
  /** per-reel motion policy */
  motionMode: t.Optional(
    t.Union([
      t.Literal("ken_burns"),
      t.Literal("parallax"),
      t.Literal("ai_hybrid"),
      t.Literal("ai_full"),
    ])
  ),
  /** explicit TTS pick from the voice catalog — overrides the tier/niche default */
  ttsModel: t.Optional(t.String()),
  ttsVoice: t.Optional(t.String()),
  ttsFormat: t.Optional(t.Union([t.Literal("mp3"), t.Literal("pcm")])),
  /** style preset bundle (config/style-presets.ts) seeding art/voice/captions/motion */
  presetId: t.Optional(t.String()),
  /** gate after planning for human review ("review") or run straight through ("auto") */
  pipelineMode: t.Optional(t.Union([t.Literal("auto"), t.Literal("review")])),
  /** user-supplied story to structure into scenes instead of AI-generated */
  providedScript: t.Optional(t.String()),
  /** pre-chosen scraped horror reference id fed to the planner */
  horrorReferenceId: t.Optional(t.String()),
  /** cinematic edit FX applied as a final render pass (rain/grain/vignette/letterbox) */
  editEffects: t.Optional(EditEffectsBody),
});

export type TCreateReelBody = typeof CreateReelBody.static;

// ---- Studio editing (co-creation) ----

export const SeriesParams = t.Object({
  seriesId: t.String(),
});
export type TSeriesParams = typeof SeriesParams.static;

// index stays a string param (route params must be string-typed for Elysia's
// Context); controllers parse it to a number.
export const SceneIndexParams = t.Object({
  id: t.String(),
  index: t.String(),
});
export type TSceneIndexParams = typeof SceneIndexParams.static;

const SceneMotionBody = t.Object({
  type: t.Union([
    t.Literal("ken_burns"),
    t.Literal("static"),
    t.Literal("parallax"),
    t.Literal("ai_motion"),
  ]),
  direction: t.Optional(t.Union([t.Literal("in"), t.Literal("out")])),
  intensity: t.Optional(t.Number({ minimum: 0, maximum: 1 })),
});

export const UpdateSceneBody = t.Object({
  narration: t.Optional(t.String()),
  visualPrompt: t.Optional(t.String()),
  motion: t.Optional(SceneMotionBody),
});
export type TUpdateSceneBody = typeof UpdateSceneBody.static;

export const RegenerateSceneBody = t.Object({
  regenerate: t.Array(t.Union([t.Literal("image"), t.Literal("audio")]), {
    minItems: 1,
    maxItems: 2,
  }),
});
export type TRegenerateSceneBody = typeof RegenerateSceneBody.static;

export const AddSceneBody = t.Object({
  atIndex: t.Optional(t.Numeric({ minimum: 0 })),
  narration: t.String({ minLength: 1 }),
  visualPrompt: t.Optional(t.String()),
});
export type TAddSceneBody = typeof AddSceneBody.static;

export const ReorderScenesBody = t.Object({
  order: t.Array(t.Numeric({ minimum: 0 }), { minItems: 1 }),
});
export type TReorderScenesBody = typeof ReorderScenesBody.static;

export const UpdateReelSettingsBody = t.Object({
  thumbnailSceneIndex: t.Optional(t.Number({ minimum: 0 })),
  artStyleId: t.Optional(t.String()),
  motionMode: t.Optional(
    t.Union([
      t.Literal("ken_burns"),
      t.Literal("parallax"),
      t.Literal("ai_hybrid"),
      t.Literal("ai_full"),
    ])
  ),
  imageModel: t.Optional(t.String()),
  horrorAudioKey: t.Optional(t.String()),
  horrorReferenceId: t.Optional(t.String()),
  gameplayKey: t.Optional(t.String()),
  outroChannelId: t.Optional(t.String()),
  outro: t.Optional(OutroSettingsBody),
  voice: t.Optional(
    t.Object({
      model: t.Optional(t.String()),
      voice: t.Optional(t.String()),
      format: t.Optional(t.Union([t.Literal("mp3"), t.Literal("pcm")])),
    })
  ),
  audioPost: t.Optional(
    t.Object({
      voiceProfile: t.Optional(
        t.Union([
          t.Literal("none"),
          t.Literal("horror"),
          t.Literal("whisper"),
          t.Literal("phone"),
          t.Literal("tape"),
          t.Literal("distant"),
        ])
      ),
      bedVolume: t.Optional(t.Number({ minimum: 0, maximum: 1 })),
    })
  ),
  editEffects: t.Optional(EditEffectsBody),
});
export type TUpdateReelSettingsBody = typeof UpdateReelSettingsBody.static;

export const UpdateCaptionsBody = t.Object({
  fontName: t.Optional(t.String()),
  fontSize: t.Optional(t.Number({ minimum: 8, maximum: 200 })),
  primaryColor: t.Optional(t.String()),
  activeColor: t.Optional(t.String()),
  outlineColor: t.Optional(t.String()),
  outlineWidth: t.Optional(t.Number({ minimum: 0, maximum: 20 })),
  shadow: t.Optional(t.Number({ minimum: 0, maximum: 20 })),
  alignment: t.Optional(t.Number({ minimum: 1, maximum: 9 })),
  marginV: t.Optional(t.Number({ minimum: 0, maximum: 1920 })),
  marginL: t.Optional(t.Number({ minimum: 0, maximum: 1080 })),
  marginR: t.Optional(t.Number({ minimum: 0, maximum: 1080 })),
  chunkSize: t.Optional(t.Number({ minimum: 1, maximum: 12 })),
  bold: t.Optional(t.Boolean()),
  uppercase: t.Optional(t.Boolean()),
  animation: t.Optional(t.Union([t.Literal("none"), t.Literal("pop")])),
});
export type TUpdateCaptionsBody = typeof UpdateCaptionsBody.static;

export const UpdateRedditCardBody = t.Object({
  title: t.Optional(t.String({ minLength: 1 })),
  subreddit: t.Optional(t.String()),
  cardUsername: t.Optional(t.String()),
  author: t.Optional(t.String()),
  ageHours: t.Optional(t.Number({ minimum: 0 })),
  upvotes: t.Optional(t.Number({ minimum: 0 })),
  comments: t.Optional(t.Number({ minimum: 0 })),
});
export type TUpdateRedditCardBody = typeof UpdateRedditCardBody.static;

export const RegenerateReelBody = t.Object({
  mode: t.Union([
    t.Literal("render_only"),
    t.Literal("assets"),
    t.Literal("outro_only"),
    t.Literal("composite_only"),
  ]),
});
export type TRegenerateReelBody = typeof RegenerateReelBody.static;

export const DraftAssetParams = t.Object({
  draftId: t.String(),
  filename: t.String(),
});
export type TDraftAssetParams = typeof DraftAssetParams.static;

export const ReplanReelBody = t.Object({
  topic: t.Optional(t.String()),
  providedScript: t.Optional(t.String()),
  horrorReferenceId: t.Optional(t.String()),
});
export type TReplanReelBody = typeof ReplanReelBody.static;

export const RevoiceReelBody = t.Object({
  variants: t.Array(
    t.Object({
      model: t.Optional(t.String()),
      voice: t.Optional(t.String()),
      format: t.Optional(t.Union([t.Literal("mp3"), t.Literal("pcm")])),
      label: t.Optional(t.String()),
    }),
    { minItems: 1, maxItems: 5 }
  ),
});

export type TRevoiceReelBody = typeof RevoiceReelBody.static;

export const VariantParams = t.Object({
  id: t.String(),
  variantId: t.String(),
});

export type TVariantParams = typeof VariantParams.static;

export const UpdateReelReviewBody = t.Object({
  title: t.Optional(t.String()),
  description: t.Optional(t.String()),
  tags: t.Optional(t.Array(t.String())),
  thumbnailPrompt: t.Optional(t.String()),
  visibilityNotes: t.Optional(t.String()),
  status: t.Optional(t.Union([t.Literal("draft"), t.Literal("ready"), t.Literal("approved")])),
});

export type TUpdateReelReviewBody = typeof UpdateReelReviewBody.static;

export const PublishReelBody = t.Object({
  channelId: t.Optional(t.String()),
});

export type TPublishReelBody = typeof PublishReelBody.static;

const ThumbnailAspectRatio = t.Optional(t.Union([t.Literal("16:9"), t.Literal("9:16"), t.Literal("1:1")]));

export const ThumbnailFrameBody = t.Object({
  atSeconds: t.Number({ minimum: 0 }),
  aspectRatio: ThumbnailAspectRatio,
});

export type TThumbnailFrameBody = typeof ThumbnailFrameBody.static;

export const ThumbnailSceneBody = t.Object({
  sceneIndex: t.Number({ minimum: 0 }),
  aspectRatio: ThumbnailAspectRatio,
});

export type TThumbnailSceneBody = typeof ThumbnailSceneBody.static;

/** Aspect-corrected background source for the client-side Thumbnail Studio
 *  canvas — a video frame, a scene still, or the currently saved thumbnail. */
export const ThumbnailSourceBody = t.Object({
  sourceType: t.Union([t.Literal("frame"), t.Literal("scene"), t.Literal("saved")]),
  atSeconds: t.Optional(t.Number({ minimum: 0 })),
  sceneIndex: t.Optional(t.Number({ minimum: 0 })),
  aspectRatio: ThumbnailAspectRatio,
});

export type TThumbnailSourceBody = typeof ThumbnailSourceBody.static;

/** Client-rendered Thumbnail Studio canvas export — a base64 PNG data URL plus
 *  the opaque editor state so the studio can restore the layer stack later. */
export const StageThumbnailImageBody = t.Object({
  imageDataUrl: t.String({ minLength: 32, maxLength: 20_000_000 }),
  aspectRatio: ThumbnailAspectRatio,
  editorState: t.Optional(t.Record(t.String(), t.Unknown())),
});

export type TStageThumbnailImageBody = typeof StageThumbnailImageBody.static;

export const SaveShortsCoverBody = t.Object({
  imageDataUrl: t.String({ minLength: 32, maxLength: 20_000_000 }),
  sourceType: t.Union([t.Literal("reddit_title_card"), t.Literal("scene"), t.Literal("video_frame")]),
  sceneIndex: t.Optional(t.Number({ minimum: 0 })),
  atSeconds: t.Optional(t.Number({ minimum: 0 })),
  placement: t.Optional(t.Union([t.Literal("opening"), t.Literal("source_scene")])),
  holdSeconds: t.Optional(t.Number({ minimum: 0.25, maximum: 5 })),
  editorState: t.Optional(t.Record(t.String(), t.Unknown())),
  sourceFingerprint: t.Optional(t.String()),
});
export type TSaveShortsCoverBody = typeof SaveShortsCoverBody.static;

/** Composition controls shared by the one-shot custom thumbnail endpoints and
 *  Thumbnail Studio draft staging. */
const thumbnailComposeFields = {
  atSeconds: t.Number({ minimum: 0 }),
  sourceType: t.Optional(t.Union([t.Literal("frame"), t.Literal("scene")])),
  sceneIndex: t.Optional(t.Number({ minimum: 0 })),
  aspectRatio: ThumbnailAspectRatio,
  xPct: t.Optional(t.Number({ minimum: 0, maximum: 1 })),
  yPct: t.Optional(t.Number({ minimum: 0, maximum: 1 })),
  widthPct: t.Optional(t.Number({ minimum: 0.2, maximum: 1 })),
  align: t.Optional(t.Union([t.Literal("left"), t.Literal("center"), t.Literal("right")])),
  lineHeight: t.Optional(t.Number({ minimum: 0.8, maximum: 2 })),
  effect: t.Optional(
    t.Union([
      t.Literal("none"),
      t.Literal("shadow"),
      t.Literal("glow"),
      t.Literal("neon"),
      t.Literal("impact"),
      t.Literal("pill"),
      t.Literal("outline"),
      t.Literal("pop"),
      t.Literal("box"),
    ])
  ),
  photoLook: t.Optional(
    t.Union([
      t.Literal("none"),
      t.Literal("vivid"),
      t.Literal("cinematic"),
      t.Literal("noir"),
      t.Literal("warm"),
      t.Literal("cool"),
      t.Literal("punch"),
    ])
  ),
  fontFamily: t.Optional(t.String()),
  fontSize: t.Optional(t.Number({ minimum: 20, maximum: 400 })),
  color: t.Optional(t.String()),
  outlineColor: t.Optional(t.String()),
  outlineWidth: t.Optional(t.Number({ minimum: 0, maximum: 30 })),
  // vertical anchor for the text band
  position: t.Optional(t.Union([t.Literal("top"), t.Literal("middle"), t.Literal("bottom")])),
  uppercase: t.Optional(t.Boolean()),
};

/** Manual thumbnail: a video frame + custom overlay caption text. */
export const CustomThumbnailBody = t.Object({
  ...thumbnailComposeFields,
  text: t.String({ minLength: 1, maxLength: 200 }),
});

export type TCustomThumbnailBody = typeof CustomThumbnailBody.static;

/** Thumbnail Studio draft staging — text optional so a clean source (no
 *  overlay) can be staged locally too. */
export const StageThumbnailDraftBody = t.Object({
  ...thumbnailComposeFields,
  text: t.Optional(t.String({ maxLength: 200 })),
});

export type TStageThumbnailDraftBody = typeof StageThumbnailDraftBody.static;

export const VoiceSampleQuery = t.Object({
  model: t.String(),
  voice: t.String(),
});

export type TVoiceSampleQuery = typeof VoiceSampleQuery.static;

export const ReelDefaultsQuery = t.Object({
  niche: t.String(),
  tier: t.Optional(t.Union([t.Literal("cheap"), t.Literal("value"), t.Literal("premium")])),
});

export type TReelDefaultsQuery = typeof ReelDefaultsQuery.static;

export const ConnectYouTubeBody = t.Object({
  label: t.String({ minLength: 1 }),
  channelKey: t.Optional(t.String()),
  privacyStatus: t.Optional(
    t.Union([t.Literal("private"), t.Literal("unlisted"), t.Literal("public")])
  ),
  categoryId: t.Optional(t.String()),
  niches: t.Optional(t.Array(t.String())),
});

export type TConnectYouTubeBody = typeof ConnectYouTubeBody.static;

export const YouTubeCallbackQuery = t.Object({
  code: t.Optional(t.String()),
  state: t.Optional(t.String()),
  error: t.Optional(t.String()),
  error_description: t.Optional(t.String()),
});

export type TYouTubeCallbackQuery = typeof YouTubeCallbackQuery.static;
