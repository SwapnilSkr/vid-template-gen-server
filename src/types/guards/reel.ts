import { t } from "elysia";

/**
 * Create reel request body.
 * `topic` is optional/empty/"auto" → pulls from the story bank (Reddit niche)
 * or lets the planner pick freely (other niches).
 */
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
});

export type TCreateReelBody = typeof CreateReelBody.static;

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

export const ThumbnailFrameBody = t.Object({
  atSeconds: t.Number({ minimum: 0 }),
});

export type TThumbnailFrameBody = typeof ThumbnailFrameBody.static;

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
