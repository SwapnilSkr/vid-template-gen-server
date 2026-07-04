import type { Context } from "elysia";
import { getErrorMessage } from "../types";
import type {
  TAudioClipQuery,
  TCaptionAtQuery,
  TCreateYtImportBody,
  TExtractFramesBody,
  TListYtImportsQuery,
  TSearchYoutubeQuery,
  TYtImportFrameParams,
} from "../types/guards";
import type { TIdParams } from "../types/guards/common";
import { searchYoutubeVideos } from "../services/youtube-search.service";
import {
  captionAtTime,
  createYtImport,
  deleteYtImport,
  extractAudioClip,
  getLocalAssetPath,
  getYtImport,
  listFrameIndices,
  listYtImports,
  normalizeFrameRange,
} from "../services/yt-import.service";
import { YtImport } from "../models";
import { enqueueYtImport, enqueueYtImportFrames } from "../queue/queues";
import { fileExists } from "../utils";

interface SearchContext extends Context {
  query: TSearchYoutubeQuery;
}

interface CreateContext extends Context {
  body: TCreateYtImportBody;
}

interface IdContext extends Context {
  params: TIdParams;
}

interface FrameContext extends Context {
  params: TYtImportFrameParams;
}

interface CaptionContext extends Context {
  params: TIdParams;
  query: TCaptionAtQuery;
}

interface AudioClipContext extends Context {
  params: TIdParams;
  query: TAudioClipQuery;
}

interface ListContext extends Context {
  query: TListYtImportsQuery;
}

interface ExtractFramesContext extends Context {
  params: TIdParams;
  body: TExtractFramesBody;
}

import type { IYtImport } from "../models";

function serializeImport(doc: IYtImport | null) {
  if (!doc) return null;
  const plain = typeof (doc as { toObject?: () => Record<string, unknown> }).toObject === "function"
    ? (doc as { toObject: () => Record<string, unknown> }).toObject()
    : { ...doc };
  const { localDir: _localDir, s3Prefix: _s3Prefix, ...rest } = plain as Record<string, unknown>;
  return rest;
}

export async function searchYoutubeController({ query, set }: SearchContext) {
  try {
    const maxResults = query.maxResults ? parseInt(query.maxResults, 10) : 12;
    const results = await searchYoutubeVideos(query.q, maxResults);
    return { success: true, data: results };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function listYtImportsController({ query }: ListContext) {
  const limit = query.limit ? parseInt(query.limit, 10) : 50;
  const imports = await listYtImports(limit);
  return { success: true, data: imports.map((doc) => serializeImport(doc)) };
}

export async function getYtImportController({ params, set }: IdContext) {
  const doc = await getYtImport(params.id);
  if (!doc) {
    set.status = 404;
    return { success: false, error: "Import not found" };
  }
  const frames = doc.framesExtracted ? await listFrameIndices(doc) : [];
  return {
    success: true,
    data: {
      ...serializeImport(doc),
      frameIndices: frames.slice(0, 500),
      frameIndicesTotal: frames.length,
    },
  };
}

export async function createYtImportController({ body, set }: CreateContext) {
  try {
    const doc = await createYtImport(body);
    if (doc.status === "pending") {
      await enqueueYtImport(String(doc._id));
    }
    return {
      success: true,
      data: serializeImport(doc),
      message: doc.status === "pending" ? "Download queued" : "Import already exists",
    };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function extractFramesController({ params, body, set }: ExtractFramesContext) {
  try {
    const doc = await getYtImport(params.id);
    if (!doc) {
      set.status = 404;
      return { success: false, error: "Import not found" };
    }
    if (!doc.videoUrl) {
      set.status = 400;
      return { success: false, error: "Video must be downloaded before extracting frames" };
    }
    if (["pending", "downloading", "uploading"].includes(doc.status)) {
      set.status = 400;
      return { success: false, error: `Import is still ${doc.status}` };
    }
    if (doc.status === "extracting_frames") {
      set.status = 400;
      return { success: false, error: "Frame extraction already in progress" };
    }

    const range = normalizeFrameRange(body.startSec, body.endSec, doc.durationSec);
    await YtImport.findByIdAndUpdate(params.id, {
      status: "extracting_frames",
      progress: 75,
      framesExtracted: false,
      frameCount: 0,
      frameRangeStartSec: range.startSec,
      frameRangeEndSec: range.endSec,
    });
    await enqueueYtImportFrames(params.id);
    return {
      success: true,
      data: { queued: true, range },
      message: `Frame extraction queued (${range.startSec}s–${range.endSec}s)`,
    };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function captionAtController({ params, query, set }: CaptionContext) {
  const doc = await getYtImport(params.id);
  if (!doc) {
    set.status = 404;
    return { success: false, error: "Import not found" };
  }
  const atSec = parseFloat(query.at);
  if (Number.isNaN(atSec)) {
    set.status = 400;
    return { success: false, error: "Invalid timestamp" };
  }
  const cue = captionAtTime(doc.captions, atSec);
  const fps = doc.fps ?? 30;
  const frameIndex = Math.max(0, Math.round(atSec * fps));
  return {
    success: true,
    data: {
      timestampSec: atSec,
      frameIndex,
      caption: cue ?? null,
    },
  };
}

export async function deleteYtImportController({ params, set }: IdContext) {
  try {
    await deleteYtImport(params.id);
    return { success: true, data: { deleted: true } };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

async function streamLocalAsset(
  doc: NonNullable<Awaited<ReturnType<typeof getYtImport>>>,
  kind: "video" | "audio" | "captions" | "frame",
  set: Context["set"],
  frameIndex?: number
) {
  const path = await getLocalAssetPath(doc, kind, frameIndex);
  if (!path || !(await fileExists(path))) {
    set.status = 404;
    return { success: false, error: "Asset not found" };
  }

  const contentTypes: Record<string, string> = {
    video: "video/mp4",
    audio: "audio/mp4",
    captions: "text/vtt",
    frame: "image/jpeg",
  };

  set.headers["content-type"] = contentTypes[kind];
  return Bun.file(path);
}

export async function streamVideoController({ params, set }: IdContext) {
  const doc = await getYtImport(params.id);
  if (!doc?.videoUrl) {
    set.status = 404;
    return { success: false, error: "Video not found" };
  }
  if (doc.storage === "s3") {
    set.redirect = doc.videoUrl;
    return;
  }
  return streamLocalAsset(doc, "video", set);
}

export async function streamAudioController({ params, set }: IdContext) {
  const doc = await getYtImport(params.id);
  if (!doc?.audioUrl) {
    set.status = 404;
    return { success: false, error: "Audio not found" };
  }
  if (doc.storage === "s3") {
    set.redirect = doc.audioUrl;
    return;
  }
  return streamLocalAsset(doc, "audio", set);
}

export async function streamCaptionsController({ params, set }: IdContext) {
  const doc = await getYtImport(params.id);
  if (!doc) {
    set.status = 404;
    return { success: false, error: "Import not found" };
  }
  if (doc.storage === "s3" && doc.captionsUrl) {
    set.redirect = doc.captionsUrl;
    return;
  }
  return streamLocalAsset(doc, "captions", set);
}

export async function streamFrameController({ params, set }: FrameContext) {
  const doc = await getYtImport(params.id);
  if (!doc) {
    set.status = 404;
    return { success: false, error: "Import not found" };
  }
  const frameIndex = parseInt(params.frameIndex, 10);
  if (Number.isNaN(frameIndex)) {
    set.status = 400;
    return { success: false, error: "Invalid frame index" };
  }
  if (doc.storage === "s3") {
    if (!doc.s3Prefix) {
      set.status = 404;
      return { success: false, error: "Frame not found" };
    }
    const file = `frame_${String(frameIndex).padStart(6, "0")}.jpg`;
    const { cdnUrlFor } = await import("../services/s3.service");
    set.redirect = cdnUrlFor(`${doc.s3Prefix}frames/${file}`);
    return;
  }
  return streamLocalAsset(doc, "frame", set, frameIndex);
}

export async function streamAudioClipController({ params, query, set }: AudioClipContext) {
  const doc = await getYtImport(params.id);
  if (!doc) {
    set.status = 404;
    return { success: false, error: "Import not found" };
  }
  const atSec = parseFloat(query.at);
  const durationSec = query.duration ? parseFloat(query.duration) : 3;
  if (Number.isNaN(atSec)) {
    set.status = 400;
    return { success: false, error: "Invalid timestamp" };
  }
  try {
    const { path, cleanup } = await extractAudioClip(doc, atSec, durationSec);
    set.headers["content-type"] = "audio/mp4";
    const file = Bun.file(path);
    queueMicrotask(() => {
      void cleanup();
    });
    return file;
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}
