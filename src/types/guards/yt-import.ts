import { t } from "elysia";

export const SearchYoutubeQuery = t.Object({
  q: t.String({ minLength: 1 }),
  maxResults: t.Optional(t.String()),
});

export type TSearchYoutubeQuery = typeof SearchYoutubeQuery.static;

export const CreateYtImportBody = t.Object({
  videoId: t.String({ minLength: 6 }),
  storage: t.Union([t.Literal("local"), t.Literal("s3")]),
  downloadCaptions: t.Optional(t.Boolean()),
  extractFrames: t.Optional(t.Boolean()),
  frameRangeStartSec: t.Optional(t.Number({ minimum: 0 })),
  frameRangeEndSec: t.Optional(t.Number({ minimum: 0 })),
});

export type TCreateYtImportBody = typeof CreateYtImportBody.static;

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
