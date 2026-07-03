import type { Context } from "elysia";
import {
  createReel,
  getReel,
  listReels,
  deleteReel,
  ensureReelReviewPackage,
  regenerateReelThumbnail,
  updateReelReview,
  requestRevoice,
  promoteVoiceVariant,
  listGameplayLibrary,
  useReelFrameAsThumbnail,
  getVoiceSample,
  listImageModels,
  listPricedTtsVoices,
  getReelDefaults,
  listHorrorAudioLibrary,
  listArtStyles,
} from "../services";
import { enqueuePublish } from "../queue/queues";
import { TTS_VOICE_CATALOG } from "../config/models";
import type {
  TIdParams,
  TCreateReelBody,
  TUpdateReelReviewBody,
  TRevoiceReelBody,
  TVariantParams,
  TThumbnailFrameBody,
  TVoiceSampleQuery,
  TReelDefaultsQuery,
} from "../types/guards";
import { getErrorMessage } from "../types";

// ============================================
// Type Definitions for Controller Context
// ============================================

interface CreateReelContext extends Context {
  body: TCreateReelBody;
}

interface GetReelContext extends Context {
  params: TIdParams;
}

interface UpdateReelReviewContext extends Context {
  params: TIdParams;
  body: TUpdateReelReviewBody;
}

interface ListReelsContext extends Context {
  query: { limit?: string };
}

interface RevoiceReelContext extends Context {
  params: TIdParams;
  body: TRevoiceReelBody;
}

interface VoiceSampleContext extends Context {
  query: TVoiceSampleQuery;
}

interface ReelDefaultsContext extends Context {
  query: TReelDefaultsQuery;
}

interface PromoteVoiceVariantContext extends Context {
  params: TVariantParams;
}

interface ThumbnailFrameContext extends Context {
  params: TIdParams;
  body: TThumbnailFrameBody;
}

// ============================================
// Controller Functions
// ============================================

/** Create a new reel (start async generation). */
export async function createReelController({ body, set }: CreateReelContext) {
  try {
    const reel = await createReel({
      niche: body.niche,
      genre: body.genre,
      topic: body.topic ?? "auto",
      tier: body.tier,
      source: body.source,
      parts: body.parts,
      gameplayKey: body.gameplayKey,
      horrorAudioKey: body.horrorAudioKey,
      imageModel: body.imageModel,
      artStyleId: body.artStyleId,
      motionMode: body.motionMode,
      ttsModel: body.ttsModel,
      ttsVoice: body.ttsVoice,
      ttsFormat: body.ttsFormat,
    });
    const primary = reel.reel;
    return {
      success: true,
      data: {
        id: primary._id,
        niche: primary.niche,
        status: primary.status,
        source: primary.storySource,
        genre: primary.genre,
        seriesId: reel.seriesId,
        parts: reel.reels.map((r) => ({
          id: r._id,
          title: r.title,
          partNumber: r.partNumber,
          partCount: r.partCount,
          status: r.status,
        })),
      },
      message: "Reel generation started! Check status for progress.",
    };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

/** List reels (most recent first). */
export async function listReelsController({ query }: ListReelsContext) {
  const limit = query.limit ? parseInt(query.limit) : 50;
  const reels = await listReels(limit);
  return { success: true, data: reels };
}

/** Get reel status/progress. */
export async function getReelStatusController({ params, set }: GetReelContext) {
  const reel = await getReel(params.id);
  if (!reel) {
    set.status = 404;
    return { success: false, error: "Reel not found" };
  }
  return {
    success: true,
    data: {
      id: reel._id,
      niche: reel.niche,
      topic: reel.topic,
      strategy: reel.strategy,
      status: reel.status,
      progress: reel.progress,
      title: reel.title,
      source: reel.storySource,
      genre: reel.genre,
      artStyleId: reel.artStyleId,
      motionMode: reel.motionMode,
      storyBible: reel.storyBible,
      seriesId: reel.seriesId,
      partNumber: reel.partNumber,
      partCount: reel.partCount,
      outputUrl: reel.outputUrl,
      subtitlesUrl: reel.subtitlesUrl,
      hook: reel.hook,
      scenes: reel.scenes,
      redditStory: reel.redditStory,
      review: reel.review,
      costUsd: reel.costUsd,
      costBreakdown: reel.costBreakdown,
      error: reel.error,
      youtube: reel.youtube,
      gameplayKey: reel.gameplayKey,
      horrorAudioKey: reel.horrorAudioKey,
      imageModelOverride: reel.imageModelOverride,
      voiceOverride: reel.voiceOverride,
      voiceVariants: reel.voiceVariants,
    },
  };
}

/** Get or lazily create the review package for a completed reel. */
export async function getReelReviewController({ params, set }: GetReelContext) {
  const reel = await getReel(params.id);
  if (!reel) {
    set.status = 404;
    return { success: false, error: "Reel not found" };
  }
  if (reel.status !== "completed") {
    set.status = 400;
    return {
      success: false,
      error: `Reel not completed. Current status: ${reel.status}`,
    };
  }

  const review = await ensureReelReviewPackage(params.id);
  return { success: true, data: review };
}

/** Update title/description/tags/thumbnail review details before publishing. */
export async function updateReelReviewController({
  params,
  body,
  set,
}: UpdateReelReviewContext) {
  const reel = await getReel(params.id);
  if (!reel) {
    set.status = 404;
    return { success: false, error: "Reel not found" };
  }
  if (reel.status !== "completed") {
    set.status = 400;
    return {
      success: false,
      error: `Reel not completed. Current status: ${reel.status}`,
    };
  }

  const review = await updateReelReview(params.id, body);
  return { success: true, data: review };
}

/** Regenerate the reviewed thumbnail from the current title/concept. */
export async function regenerateReelThumbnailController({
  params,
  body,
  set,
}: UpdateReelReviewContext) {
  const reel = await getReel(params.id);
  if (!reel) {
    set.status = 404;
    return { success: false, error: "Reel not found" };
  }
  if (reel.status !== "completed") {
    set.status = 400;
    return {
      success: false,
      error: `Reel not completed. Current status: ${reel.status}`,
    };
  }

  const review = await regenerateReelThumbnail(params.id, body);
  return { success: true, data: review };
}

/** Enqueue (or retry) a YouTube publish job for a completed reel. */
export async function publishReelController({ params, set }: GetReelContext) {
  const reel = await getReel(params.id);
  if (!reel) {
    set.status = 404;
    return { success: false, error: "Reel not found" };
  }
  if (reel.status !== "completed") {
    set.status = 400;
    return {
      success: false,
      error: `Reel not completed. Current status: ${reel.status}`,
    };
  }

  reel.youtube = {
    status: reel.youtube?.status === "uploading" ? "uploading" : "pending",
    videoId: reel.youtube?.videoId,
    url: reel.youtube?.url,
    publishedAt: reel.youtube?.publishedAt,
  };
  await reel.save();
  await enqueuePublish(params.id, "youtube");
  return {
    success: true,
    data: { youtube: reel.youtube },
    message: "YouTube publish job queued",
  };
}

/** Download completed reel (returns the S3/CDN URL). */
export async function downloadReelController({ params, set }: GetReelContext) {
  const reel = await getReel(params.id);
  if (!reel) {
    set.status = 404;
    return { success: false, error: "Reel not found" };
  }

  if (reel.status !== "completed") {
    set.status = 400;
    return {
      success: false,
      error: `Reel not completed. Current status: ${reel.status}`,
      progress: reel.progress,
    };
  }

  if (!reel.outputUrl) {
    set.status = 404;
    return { success: false, error: "Output not available" };
  }

  return {
    success: true,
    data: {
      downloadUrl: reel.outputUrl,
      subtitlesUrl: reel.subtitlesUrl,
    },
  };
}

/** Request 1-5 re-narrated voice variants of a completed gameplay reel. */
export async function revoiceReelController({ params, body, set }: RevoiceReelContext) {
  const reel = await getReel(params.id);
  if (!reel) {
    set.status = 404;
    return { success: false, error: "Reel not found" };
  }
  try {
    const updated = await requestRevoice(params.id, body.variants);
    return { success: true, data: updated.voiceVariants, message: "Revoice queued" };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

/** Promote a ready voice variant to become the reel's primary output. */
export async function promoteVoiceVariantController({ params, set }: PromoteVoiceVariantContext) {
  try {
    const reel = await promoteVoiceVariant(params.id, params.variantId);
    return {
      success: true,
      data: { outputUrl: reel.outputUrl, voiceVariants: reel.voiceVariants },
    };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

/** Use a specific frame of the rendered video as the thumbnail. */
export async function useReelFrameAsThumbnailController({ params, body, set }: ThumbnailFrameContext) {
  try {
    const review = await useReelFrameAsThumbnail(params.id, body.atSeconds);
    return { success: true, data: review };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

/** List the gameplay clip pool (S3 `gameplay/` prefix) for the create-reel picker. */
export async function listGameplayController() {
  try {
    const clips = await listGameplayLibrary();
    return { success: true, data: clips };
  } catch (error: unknown) {
    return { success: false, error: getErrorMessage(error) };
  }
}

/** List the curated cross-model TTS voice catalog for the revoice picker. */
export async function listTtsVoicesController() {
  return { success: true, data: listPricedTtsVoices() };
}

export async function listImageModelsController() {
  try {
    return { success: true, data: await listImageModels() };
  } catch (error: unknown) {
    return { success: false, error: getErrorMessage(error) };
  }
}

/** List global CC0/Public Domain horror beds/stingers stored in S3. */
export async function listHorrorAudioController() {
  try {
    return { success: true, data: await listHorrorAudioLibrary() };
  } catch (error: unknown) {
    return { success: false, error: getErrorMessage(error) };
  }
}

/** List reference-art styles (registry ∪ S3 manifest), optionally by niche. */
export async function listArtStylesController({ query }: { query: { niche?: string } }) {
  try {
    return { success: true, data: await listArtStyles(query.niche) };
  } catch (error: unknown) {
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function getReelDefaultsController({ query }: ReelDefaultsContext) {
  return { success: true, data: getReelDefaults(query.niche, query.tier ?? "cheap") };
}

/** Generate (or return cached) a short preview clip for a catalog voice. */
export async function getVoiceSampleController({ query, set }: VoiceSampleContext) {
  const option = TTS_VOICE_CATALOG.find((v) => v.model === query.model && v.voice === query.voice);
  if (!option) {
    set.status = 404;
    return { success: false, error: "Unknown voice — not in the catalog" };
  }
  try {
    const url = await getVoiceSample(option.model, option.voice, option.format);
    return { success: true, data: { url } };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

/** Delete a reel record. */
export async function deleteReelController({ params, set }: GetReelContext) {
  try {
    const deleted = await deleteReel(params.id);
    if (!deleted) {
      set.status = 404;
      return { success: false, error: "Reel not found" };
    }
    return { success: true, message: "Reel deleted" };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}
