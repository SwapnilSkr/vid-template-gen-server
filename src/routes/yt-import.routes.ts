import { Elysia } from "elysia";
import { IdParams } from "../types/guards";
import {
  AudioClipQuery,
  CaptionAtQuery,
  CreateYtImportBody,
  CreateGameplayMixBody,
  ExtractFramesBody,
  ListYtImportsQuery,
  SearchYoutubeQuery,
  YtImportFrameParams,
} from "../types/guards/yt-import";
import {
  captionAtController,
  createYtImportController,
  createGameplayMixController,
  deleteYtImportController,
  extractFramesController,
  getYtImportController,
  listYtImportsController,
  searchYoutubeController,
  streamAudioClipController,
  streamAudioController,
  streamCaptionsController,
  streamFrameController,
  streamVideoController,
} from "../controllers/yt-import.controller";

export const ytImportRoutes = new Elysia({ prefix: "/api/yt-imports" })
  .get("/search", searchYoutubeController, { query: SearchYoutubeQuery })
  .get("/", listYtImportsController, { query: ListYtImportsQuery })
  .post("/", createYtImportController, { body: CreateYtImportBody })
  .post("/gameplay-mix", createGameplayMixController, { body: CreateGameplayMixBody })
  .get("/:id", getYtImportController, { params: IdParams })
  .delete("/:id", deleteYtImportController, { params: IdParams })
  .post("/:id/extract-frames", extractFramesController, {
    params: IdParams,
    body: ExtractFramesBody,
  })
  .get("/:id/caption-at", captionAtController, { params: IdParams, query: CaptionAtQuery })
  .get("/:id/video", streamVideoController, { params: IdParams })
  .get("/:id/audio", streamAudioController, { params: IdParams })
  .get("/:id/captions", streamCaptionsController, { params: IdParams })
  .get("/:id/audio-clip", streamAudioClipController, { params: IdParams, query: AudioClipQuery })
  .get("/:id/frames/:frameIndex", streamFrameController, { params: YtImportFrameParams });
