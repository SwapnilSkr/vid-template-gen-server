import { t } from "elysia";

export const SearchYoutubeQuery = t.Object({
  q: t.String({ minLength: 1 }),
  maxResults: t.Optional(t.String()),
  pageToken: t.Optional(t.String({ maxLength: 500 })),
});

export type TSearchYoutubeQuery = typeof SearchYoutubeQuery.static;

export const CreateYtImportBody = t.Object({
  videoId: t.String({ minLength: 6 }),
  storage: t.Union([t.Literal("local"), t.Literal("s3")]),
  downloadCaptions: t.Optional(t.Boolean()),
  extractFrames: t.Optional(t.Boolean()),
  /** Download once, then turn it into muted 9:16 gameplay clips in S3. */
  asGameplay: t.Optional(t.Boolean()),
  sourceTrimStartSec: t.Optional(t.Number({ minimum: 0 })),
  sourceTrimEndSec: t.Optional(t.Number({ minimum: 0 })),
  /** Playback rate baked into the muted gameplay segments (1 = native). */
  gameplaySpeed: t.Optional(t.Number({ minimum: 0.25, maximum: 2 })),
  frameRangeStartSec: t.Optional(t.Number({ minimum: 0 })),
  frameRangeEndSec: t.Optional(t.Number({ minimum: 0 })),
});

export type TCreateYtImportBody = typeof CreateYtImportBody.static;

export const CreateGameplayMixBody = t.Object({
  sources: t.Array(t.Object({
    videoId: t.String({ minLength: 6 }),
    startSec: t.Optional(t.Number({ minimum: 0 })),
    endSec: t.Optional(t.Number({ minimum: 0 })),
  }), { minItems: 2, maxItems: 8 }),
  title: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
});
export type TCreateGameplayMixBody = typeof CreateGameplayMixBody.static;

export const ExtractFramesBody = t.Object({
  startSec: t.Optional(t.Number({ minimum: 0 })),
  endSec: t.Optional(t.Number({ minimum: 0 })),
});

export type TExtractFramesBody = typeof ExtractFramesBody.static;

export const YtImportFrameParams = t.Object({
  id: t.String(),
  frameIndex: t.String(),
});

export type TYtImportFrameParams = typeof YtImportFrameParams.static;

export const CaptionAtQuery = t.Object({
  at: t.String(),
});

export type TCaptionAtQuery = typeof CaptionAtQuery.static;

export const AudioClipQuery = t.Object({
  at: t.String(),
  duration: t.Optional(t.String()),
});

export type TAudioClipQuery = typeof AudioClipQuery.static;

export const ListYtImportsQuery = t.Object({
  limit: t.Optional(t.String()),
});

export type TListYtImportsQuery = typeof ListYtImportsQuery.static;

export const GameplayLibraryDeleteBody = t.Object({
  key: t.String({ minLength: 13 }),
  force: t.Optional(t.Boolean()),
});
export type TGameplayLibraryDeleteBody = typeof GameplayLibraryDeleteBody.static;

export const GameplayLibraryRenameBody = t.Object({
  key: t.String({ minLength: 13 }),
  name: t.String({ minLength: 1, maxLength: 120 }),
});
export type TGameplayLibraryRenameBody = typeof GameplayLibraryRenameBody.static;

export const GameplayLibraryTrimBody = t.Object({
  key: t.String({ minLength: 13 }),
  startSec: t.Number({ minimum: 0 }),
  endSec: t.Number({ minimum: 0 }),
});
export type TGameplayLibraryTrimBody = typeof GameplayLibraryTrimBody.static;

export const GameplayLibrarySpeedBody = t.Object({
  key: t.String({ minLength: 13 }),
  speed: t.Number({ minimum: 0.25, maximum: 2 }),
});
export type TGameplayLibrarySpeedBody = typeof GameplayLibrarySpeedBody.static;
