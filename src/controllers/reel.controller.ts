import type { Context } from "elysia";
import { file } from "bun";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import {
  createReel,
  getReel,
  listReels,
  listReelsBySeries,
  deleteSeriesPart,
  ensureReelReviewPackage,
  regenerateReelThumbnail,
  regenerateInstagramCaption,
  regenerateInstagramPollSuggestion,
  regenerateThumbnailText,
  regenerateReelOutroCommentPrompt,
  regenerateReelReviewCopy,
  previewReelFrameThumbnail,
  previewReelFrameWithText,
  previewThumbnailSource,
  useReelFrameWithText,
  updateReelReview,
  requestRevoice,
  promoteVoiceVariant,
  listGameplayLibrary,
  useReelFrameAsThumbnail,
  useReelSceneImageAsThumbnail,
  getVoiceSample,
  listImageModels,
  listPricedTtsVoices,
  getReelDefaults,
  listHorrorAudioLibrary,
  listArtStyles,
  listAllYouTubePublishChannels,
  listInstagramChannels,
  updateScene,
  addScene,
  removeScene,
  reorderScenes,
  updateReelSettings,
  updateCaptions,
  resumeFailedReel,
  approvePlan,
  replanReel,
  replanReelSeries,
  moveSeriesBoundary,
  mergePartIntoPrevious,
  updateRedditCard,
  rescanReelUpdates,
  applyReelUpdates,
  restructureSeriesParts,
  getSeriesStructureAdvice,
  chooseSeriesStructure,
  listReelDestinations,
  addReelDestination,
  removeReelDestination,
  updateReelDestinationOutro,
  setReelPrimaryDestination,
  resolveInstagramPublishCaption,
} from "../services";
import { enqueuePublish } from "../queue/queues";
import { resolveRenderedPublishDestination } from "../services/reel-outro.service";
import { TTS_VOICE_CATALOG } from "../config/models";
import { listStylePresets } from "../config/style-presets";
import { listFonts, FONTS_DIR } from "../config/fonts";
import type {
  TIdParams,
  TCreateReelBody,
  TUpdateReelReviewBody,
  TRevoiceReelBody,
  TPublishReelBody,
  TDistributeReelBody,
  TVariantParams,
  TThumbnailFrameBody,
  TThumbnailSceneBody,
  TVoiceSampleQuery,
  TReelDefaultsQuery,
  TSceneIndexParams,
  TUpdateSceneBody,
  TRegenerateSceneBody,
  TAddSceneBody,
  TReorderScenesBody,
  TUpdateReelSettingsBody,
  TUpdateCaptionsBody,
  TUpdateRedditCardBody,
  TRegenerateReelBody,
  TReplanReelBody,
  TReplanReelSeriesBody,
  TMoveBoundaryBody,
  TRescanUpdatesBody,
  TApplyUpdatesBody,
  TRestructurePartsBody,
  TStructureDecisionBody,
  TDestinationInputBody,
  TDestinationParams,
  TUpdateDestinationOutroBody,
  TSetPrimaryDestinationBody,
  TRegenerateOutroCommentPromptBody,
  TCustomThumbnailBody,
  TStageThumbnailDraftBody,
  TStageThumbnailImageBody,
  TThumbnailSourceBody,
  TSeriesParams,
  TDraftAssetParams,
  TSaveShortsCoverBody,
} from "../types/guards";
import { getErrorMessage } from "../types";
import { httpErrorFromUnknown } from "../services/ffmpeg-capability.service";
import {
  createReelEditDraft,
  createSceneEditDraft,
  discardEditDraft,
  getDraftAssetPath,
  saveEditDraft,
  applyCaptionsAndRender,
} from "../services/reel-edit-draft.service";
import {
  discardThumbnailDraft,
  getThumbnailDraftAssetPath,
  saveThumbnailDraft,
  stageThumbnailDraft,
  stageThumbnailDraftImage,
} from "../services/reel-thumbnail-draft.service";
import { clearShortsCover, saveShortsCover } from "../services/reel-shorts-cover.service";

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

interface ListSeriesContext extends Context {
  params: TSeriesParams;
}

interface RevoiceReelContext extends Context {
  params: TIdParams;
  body: TRevoiceReelBody;
}

interface PublishReelContext extends Context {
  params: TIdParams;
  body: TPublishReelBody;
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
      outroChannelId: body.outroChannelId,
      outroInstagramChannelId: body.outroInstagramChannelId,
      outro: body.outro,
      destinations: body.destinations,
      thumbnailMode: body.thumbnailMode,
      imageModel: body.imageModel,
      artStyleId: body.artStyleId,
      motionMode: body.motionMode,
      editEffects: body.editEffects,
      presetId: body.presetId,
      pipelineMode: body.pipelineMode,
      providedScript: body.providedScript,
      horrorReferenceId: body.horrorReferenceId,
      ttsModel: body.ttsModel,
      ttsVoice: body.ttsVoice,
      ttsFormat: body.ttsFormat,
      selectedStoryId: body.selectedStoryId,
      selectedSeedUrl: body.selectedSeedUrl,
      fetchUpdates: body.fetchUpdates,
      manualUpdateUrls: body.manualUpdateUrls,
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
    const mapped = httpErrorFromUnknown(error);
    // Mutations used to return a structured error to the client without any
    // server-side trace, making rejected guards indistinguishable from a UI
    // no-op while diagnosing a live Studio session.
    console.error("Reel mutation rejected", {
      status: mapped.status,
      code: mapped.body.code,
      error: mapped.body.error,
    });
    set.status = mapped.status;
    return mapped.body;
  }
}

/** List reels (most recent first). */
export async function listReelsController({ query }: ListReelsContext) {
  const limit = query.limit ? parseInt(query.limit) : 50;
  const reels = await listReels(limit);
  return { success: true, data: reels };
}

/** List every reel in a series, ordered by part number. */
export async function listReelSeriesController({ params }: ListSeriesContext) {
  const reels = await listReelsBySeries(params.seriesId);
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
      // This is the live worker label (for example, "Narration 3/12").
      // Studio replaces its local reel with this polling response, so omitting
      // it made active runs look like they had no logs or current activity.
      currentStep: reel.currentStep,
      title: reel.title,
      source: reel.storySource,
      genre: reel.genre,
      artStyleId: reel.artStyleId,
      presetId: reel.presetId,
      motionMode: reel.motionMode,
      captionStyle: reel.captionStyle,
      audioPost: reel.audioPost,
      pipelineMode: reel.pipelineMode,
      providedScript: reel.providedScript,
      horrorReferenceId: reel.horrorReferenceId,
      storyBible: reel.storyBible,
      seriesId: reel.seriesId,
      partNumber: reel.partNumber,
      partCount: reel.partCount,
      updatedAt: reel.updatedAt,
      outputUrl: reel.outputUrl,
      bodyVideoUrl: reel.bodyVideoUrl,
      assemblyVideoUrl: reel.assemblyVideoUrl,
      subtitlesUrl: reel.subtitlesUrl,
      titleAudioUrl: reel.titleAudioUrl,
      partOutroAudioUrl: reel.partOutroAudioUrl,
      outroAudioUrl: reel.outroAudioUrl,
      outroAudioSignature: reel.outroAudioSignature,
      hook: reel.hook,
      scenes: reel.scenes,
      redditStory: reel.redditStory,
      horrorReference: reel.horrorReference,
      review: reel.review,
      costUsd: reel.costUsd,
      costBreakdown: reel.costBreakdown,
      error: reel.error,
      captionsBurned: reel.captionsBurned,
      captionBurnError: reel.captionBurnError,
      youtube: reel.youtube,
      // Studio polls this endpoint while publishing. Omitting these fields
      // erased the queued Instagram state on every poll, making the UI look
      // idle even though the worker was processing a Reel.
      instagram: reel.instagram,
      instagramSettings: reel.instagramSettings,
      gameplayKey: reel.gameplayKey,
      horrorAudioKey: reel.horrorAudioKey,
      outroChannelId: reel.outroChannelId,
      outroInstagramChannelId: reel.outroInstagramChannelId,
      outro: reel.outro,
      // Studio replaces its local reel with this polling response. Keep the
      // persisted destinations here so a save/poll cycle cannot make an
      // already-added destination disappear from the panel or picker.
      destinations: reel.destinations,
      skipPartOutro: reel.skipPartOutro,
      skipBrandedOutro: reel.skipBrandedOutro,
      thumbnailMode: reel.thumbnailMode,
      thumbnailHook: reel.thumbnailHook,
      imageModelOverride: reel.imageModelOverride,
      voiceOverride: reel.voiceOverride,
      narrationVoice: reel.narrationVoice,
      voiceVariants: reel.voiceVariants,
      editDraft: reel.editDraft,
      thumbnailDraft: reel.thumbnailDraft,
      shortsCover: reel.shortsCover,
      thumbnailSceneIndex: reel.thumbnailSceneIndex,
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

/** Generate fresh YouTube Shorts title and description without changing any
 * tag, thumbnail, Instagram, or rendered-media state. */
export async function regenerateReelReviewCopyController({ params, set }: GetReelContext) {
  const reel = await getReel(params.id);
  if (!reel) {
    set.status = 404;
    return { success: false, error: "Reel not found" };
  }
  if (reel.status !== "completed") {
    set.status = 400;
    return { success: false, error: `YouTube copy generation requires a completed reel. Current status: ${reel.status}` };
  }
  try {
    return { success: true, data: await regenerateReelReviewCopy(params.id) };
  } catch (error: unknown) {
    set.status = 500;
    return { success: false, error: getErrorMessage(error) };
  }
}

/** Generate fresh platform-specific Instagram copy without changing YouTube
 * review metadata or any rendered media. */
export async function regenerateInstagramCaptionController({ params, set }: GetReelContext) {
  const reel = await getReel(params.id);
  if (!reel) {
    set.status = 404;
    return { success: false, error: "Reel not found" };
  }
  if (reel.status !== "completed") {
    set.status = 400;
    return { success: false, error: `Instagram caption generation requires a completed reel. Current status: ${reel.status}` };
  }
  try {
    return { success: true, data: await regenerateInstagramCaption(params.id) };
  } catch (error: unknown) {
    set.status = 500;
    return { success: false, error: getErrorMessage(error) };
  }
}

/** Generate only the creator-facing native Instagram poll draft. Meta's
 * publishing API never receives this copy or attempts to create a sticker. */
export async function regenerateInstagramPollSuggestionController({ params, set }: GetReelContext) {
  const reel = await getReel(params.id);
  if (!reel) {
    set.status = 404;
    return { success: false, error: "Reel not found" };
  }
  if (reel.status !== "completed") {
    set.status = 400;
    return { success: false, error: `Instagram poll suggestion requires a completed reel. Current status: ${reel.status}` };
  }
  try {
    return { success: true, data: await regenerateInstagramPollSuggestion(params.id) };
  } catch (error: unknown) {
    set.status = 500;
    return { success: false, error: getErrorMessage(error) };
  }
}

/** Generate only the short text hook used by the thumbnail renderer/editor. */
export async function regenerateThumbnailTextController({ params, set }: GetReelContext) {
  const reel = await getReel(params.id);
  if (!reel) {
    set.status = 404;
    return { success: false, error: "Reel not found" };
  }
  if (reel.status !== "completed") {
    set.status = 400;
    return { success: false, error: `Thumbnail hook generation requires a completed reel. Current status: ${reel.status}` };
  }
  try {
    return { success: true, data: await regenerateThumbnailText(params.id) };
  } catch (error: unknown) {
    set.status = 500;
    return { success: false, error: getErrorMessage(error) };
  }
}

/** Generate a new story-and-part-specific question for the branded outro.
 * This is intentionally available before first production, because plan review
 * is where creators should settle end-card copy before paying for TTS. */
export async function regenerateOutroCommentPromptController({
  params,
  body,
  set,
}: RegenerateOutroCommentPromptContext) {
  const reel = await getReel(params.id);
  if (!reel) {
    set.status = 404;
    return { success: false, error: "Reel not found" };
  }
  if (reel.status !== "plan_review" && reel.status !== "completed") {
    set.status = 400;
    return {
      success: false,
      error: `Outro comment prompt generation requires a reviewed or completed reel. Current status: ${reel.status}`,
    };
  }
  try {
    return { success: true, data: await regenerateReelOutroCommentPrompt(params.id, body.scope) };
  } catch (error: unknown) {
    set.status = 500;
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function listYouTubeChannelsController() {
  return { success: true, data: await listAllYouTubePublishChannels() };
}

/** Enqueue (or retry) a YouTube publish job for a completed reel. */
export async function publishReelController({
  params,
  body,
  set,
}: PublishReelContext) {
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

  const channels = body?.channelId ? await listAllYouTubePublishChannels() : [];
  const channel = body?.channelId
    ? channels.find((candidate) => candidate.id === body.channelId)
    : undefined;
  if (body?.channelId && !channel) {
    set.status = 400;
    return {
      success: false,
      error: `Unknown YouTube channel: ${body.channelId}`,
    };
  }
  try {
    resolveRenderedPublishDestination(reel, "youtube", body?.channelId);
  } catch (error) {
    set.status = 409;
    return { success: false, error: getErrorMessage(error) };
  }

  reel.youtube = {
    status: reel.youtube?.status === "uploading" ? "uploading" : "pending",
    videoId: reel.youtube?.videoId,
    url: reel.youtube?.url,
    publishedAt: reel.youtube?.publishedAt,
    thumbnailStatus: reel.review?.thumbnailUrl ? "pending" : "missing",
    channelId: body?.channelId ?? reel.youtube?.channelId,
    channelLabel: channel?.label ?? reel.youtube?.channelLabel,
  };
  await reel.save();
  await enqueuePublish(params.id, "youtube", body?.channelId);
  return {
    success: true,
    data: { youtube: reel.youtube },
    message: "YouTube publish job queued",
  };
}

/** Fan one completed render out to multiple owned social accounts. Each target
 * has its own job/state, so a failure on one handle never blocks the others. */
export async function distributeReelController({ params, body, set }: PublishReelContext & { body: TDistributeReelBody }) {
  const reel = await getReel(params.id);
  if (!reel) { set.status = 404; return { success: false, error: "Reel not found" }; }
  if (reel.status !== "completed") { set.status = 400; return { success: false, error: `Reel not completed. Current status: ${reel.status}` }; }
  const youtubeIds = [...new Set(body.youtubeChannelIds ?? [])];
  const instagramIds = [...new Set(body.instagramChannelIds ?? [])];
  if (!youtubeIds.length && !instagramIds.length) { set.status = 400; return { success: false, error: "Choose at least one distribution account" }; }
  const [youtube, instagram] = await Promise.all([listAllYouTubePublishChannels(), listInstagramChannels()]);
  const unknown = [...youtubeIds.filter((id) => !youtube.some((c) => c.id === id)), ...instagramIds.filter((id) => !instagram.some((c) => c.id === id))];
  if (unknown.length) { set.status = 400; return { success: false, error: `Unknown distribution account(s): ${unknown.join(", ")}` }; }
  const unavailable: string[] = [];
  for (const id of youtubeIds) {
    try { resolveRenderedPublishDestination(reel, "youtube", id); } catch (error) { unavailable.push(`${id}: ${getErrorMessage(error)}`); }
  }
  for (const id of instagramIds) {
    try { resolveRenderedPublishDestination(reel, "instagram", id); } catch (error) { unavailable.push(`${id}: ${getErrorMessage(error)}`); }
  }
  if (unavailable.length) {
    set.status = 409;
    return { success: false, error: `Only ready destination renders can be published. ${unavailable.join(" ")}` };
  }
  if (instagramIds.length) {
    try {
      resolveInstagramPublishCaption(reel);
    } catch (error) {
      set.status = 400;
      return { success: false, error: getErrorMessage(error) };
    }
  }
  const active = instagramIds.filter((id) => {
    const state = reel.instagram.find((publish) => publish.channelId === id)?.status;
    return state === "pending" || state === "uploading";
  });
  if (active.length) {
    set.status = 409;
    return { success: false, error: `These Instagram destinations are already publishing: ${active.join(", ")}. Wait for them to settle before trying again.` };
  }
  const alreadyPublished = instagramIds.filter((id) => reel.instagram.find((publish) => publish.channelId === id)?.status === "published");
  if (alreadyPublished.length && !body.forceRepublish) {
    set.status = 409;
    return { success: false, error: `These Instagram destinations have already published: ${alreadyPublished.join(", ")}. Confirm republish to send another Reel.` };
  }
  reel.instagram = [
    ...reel.instagram.filter((p) => !instagramIds.includes(p.channelId)),
    ...instagramIds.map((id) => {
      const previous = reel.instagram.find((publish) => publish.channelId === id);
      // A processing timeout means Meta accepted the container but did not
      // finish within our wait window. Retain it so the next publish action
      // resumes that container instead of uploading a duplicate Reel.
      const resumeTimedOutContainer =
        previous?.status === "failed" &&
        Boolean(previous.containerId) &&
        previous.error === "Instagram media processing timed out";
      return resumeTimedOutContainer
        ? {
            ...previous,
            status: "pending" as const,
            error: undefined,
            message: "Queued to resume Instagram processing…",
            updatedAt: new Date(),
          }
        : {
            channelId: id,
            channelLabel: instagram.find((c) => c.id === id)?.label,
            status: "pending" as const,
            message: "Queued for Instagram publishing…",
            updatedAt: new Date(),
          };
    }),
  ];
  await reel.save();
  await Promise.all([
    ...youtubeIds.map((id) => enqueuePublish(params.id, "youtube", id)),
    ...instagramIds.map((id) => enqueuePublish(params.id, "instagram", id)),
  ]);
  return { success: true, data: reel, message: `Queued ${youtubeIds.length + instagramIds.length} distribution target(s)` };
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
export async function revoiceReelController({
  params,
  body,
  set,
}: RevoiceReelContext) {
  const reel = await getReel(params.id);
  if (!reel) {
    set.status = 404;
    return { success: false, error: "Reel not found" };
  }
  try {
    const updated = await requestRevoice(params.id, body.variants);
    return {
      success: true,
      data: updated.voiceVariants,
      message: "Revoice queued",
    };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

/** Promote a ready voice variant to become the reel's primary output. */
export async function promoteVoiceVariantController({
  params,
  set,
}: PromoteVoiceVariantContext) {
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
export async function useReelFrameAsThumbnailController({
  params,
  body,
  set,
}: ThumbnailFrameContext) {
  try {
    const review = await useReelFrameAsThumbnail(
      params.id,
      body.atSeconds,
      body.aspectRatio,
    );
    return { success: true, data: review };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

/** Render a local, non-persisted thumbnail frame preview. */
export async function previewReelFrameThumbnailController({
  params,
  body,
  set,
}: ThumbnailFrameContext) {
  try {
    const imageDataUrl = await previewReelFrameThumbnail(
      params.id,
      body.atSeconds,
      body.aspectRatio,
    );
    return { success: true, data: { imageDataUrl } };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

interface ThumbnailSceneContext extends Context {
  params: TIdParams;
  body: TThumbnailSceneBody;
}

/** Use a generated scene still as the thumbnail. */
export async function useReelSceneImageAsThumbnailController({
  params,
  body,
  set,
}: ThumbnailSceneContext) {
  try {
    const review = await useReelSceneImageAsThumbnail(
      params.id,
      body.sceneIndex,
      body.aspectRatio,
    );
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
export async function listArtStylesController({
  query,
}: {
  query: { niche?: string };
}) {
  try {
    return { success: true, data: await listArtStyles(query.niche) };
  } catch (error: unknown) {
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function getReelDefaultsController({
  query,
}: ReelDefaultsContext) {
  return {
    success: true,
    data: getReelDefaults(query.niche, query.tier ?? "cheap"),
  };
}

/** Generate (or return cached) a short preview clip for a catalog voice. */
export async function getVoiceSampleController({
  query,
  set,
}: VoiceSampleContext) {
  const option = TTS_VOICE_CATALOG.find(
    (v) => v.model === query.model && v.voice === query.voice,
  );
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

// ============================================
// Studio editing (co-creation) controllers
// ============================================

interface SceneEditContext extends Context {
  params: TSceneIndexParams;
  body: TUpdateSceneBody;
}
interface SceneRegenContext extends Context {
  params: TSceneIndexParams;
  body: TRegenerateSceneBody;
}
interface SceneIndexContext extends Context {
  params: TSceneIndexParams;
}
interface AddSceneContext extends Context {
  params: TIdParams;
  body: TAddSceneBody;
}
interface ReorderScenesContext extends Context {
  params: TIdParams;
  body: TReorderScenesBody;
}
interface SettingsContext extends Context {
  params: TIdParams;
  body: TUpdateReelSettingsBody;
}
interface CaptionsContext extends Context {
  params: TIdParams;
  body: TUpdateCaptionsBody;
}
interface RedditCardContext extends Context {
  params: TIdParams;
  body: TUpdateRedditCardBody;
}
interface RegenerateReelContext extends Context {
  params: TIdParams;
  body: TRegenerateReelBody;
}
interface ReplanContext extends Context {
  params: TIdParams;
  body: TReplanReelBody;
}
interface ReplanSeriesContext extends Context {
  params: TIdParams;
  body: TReplanReelSeriesBody;
}
interface MoveBoundaryContext extends Context {
  params: TIdParams;
  body: TMoveBoundaryBody;
}
interface RescanUpdatesContext extends Context {
  params: TIdParams;
  body: TRescanUpdatesBody;
}
interface ApplyUpdatesContext extends Context {
  params: TIdParams;
  body: TApplyUpdatesBody;
}
interface RestructurePartsContext extends Context {
  params: TIdParams;
  body: TRestructurePartsBody;
}
interface StructureAdviceContext extends Context {
  params: TIdParams;
}
interface StructureDecisionContext extends Context {
  params: TIdParams;
  body: TStructureDecisionBody;
}
interface AddDestinationContext extends Context {
  params: TIdParams;
  body: TDestinationInputBody;
}
interface DestinationContext extends Context {
  params: TDestinationParams;
}
interface UpdateDestinationOutroContext extends Context {
  params: TDestinationParams;
  body: TUpdateDestinationOutroBody;
}

interface SetPrimaryDestinationContext extends Context {
  params: TIdParams;
  body: TSetPrimaryDestinationBody;
}
interface RegenerateOutroCommentPromptContext extends Context {
  params: TIdParams;
  body: TRegenerateOutroCommentPromptBody;
}
interface DraftAssetContext extends Context {
  params: TDraftAssetParams;
}

/** Shared error wrapper for the edit endpoints (all just mutate + return reel). */
async function runEdit(set: Context["set"], action: () => Promise<unknown>) {
  try {
    return { success: true, data: await action() };
  } catch (error: unknown) {
    const mapped = httpErrorFromUnknown(error);
    set.status = mapped.status;
    return mapped.body;
  }
}

/** Edit one scene's narration / visual prompt / motion. */
export async function updateSceneController({
  params,
  body,
  set,
}: SceneEditContext) {
  return runEdit(set, () =>
    updateScene(params.id, parseInt(params.index, 10), body),
  );
}

/** Regenerate a single scene's image and/or audio (surgical, reuses the rest). */
export async function regenerateSceneController({
  params,
  body,
  set,
}: SceneRegenContext) {
  return runEdit(set, () =>
    createSceneEditDraft(
      params.id,
      parseInt(params.index, 10),
      body.regenerate,
    ),
  );
}

/** Insert a new scene (optionally at a position). */
export async function addSceneController({
  params,
  body,
  set,
}: AddSceneContext) {
  return runEdit(set, () =>
    addScene(params.id, body.narration, body.visualPrompt, body.atIndex),
  );
}

/** Remove a scene by index. */
export async function removeSceneController({
  params,
  set,
}: SceneIndexContext) {
  return runEdit(set, () => removeScene(params.id, parseInt(params.index, 10)));
}

/** Reorder scenes by a permutation of current indices. */
export async function reorderScenesController({
  params,
  body,
  set,
}: ReorderScenesContext) {
  return runEdit(set, () => reorderScenes(params.id, body.order));
}

/** Update reel-level creative settings (art/motion/image model/voice/audio). */
export async function updateReelSettingsController({
  params,
  body,
  set,
}: SettingsContext) {
  return runEdit(set, () => updateReelSettings(params.id, body));
}

/** Update the caption look (manual, non-AI). */
export async function updateCaptionsController({
  params,
  body,
  set,
}: CaptionsContext) {
  return runEdit(set, () => updateCaptions(params.id, body));
}

/** Update Reddit title-card fields (gameplay reels only). */
export async function updateRedditCardController({
  params,
  body,
  set,
}: RedditCardContext) {
  return runEdit(set, () => updateRedditCard(params.id, body));
}

/** Persist caption style, re-render, upload, and delete the superseded output. */
export async function applyCaptionsController({
  params,
  body,
  set,
}: CaptionsContext) {
  return runEdit(set, () => applyCaptionsAndRender(params.id, body));
}

/** Queue a produce run — render-only (reuse assets) or full asset regeneration. */
export async function regenerateReelController({
  params,
  body,
  set,
}: RegenerateReelContext) {
  return runEdit(set, () => createReelEditDraft(params.id, body.mode));
}

/** Resume a failed produce job, reusing any S3 assets already paid for. */
export async function resumeFailedReelController({
  params,
  set,
}: GetReelContext) {
  return runEdit(set, () => resumeFailedReel(params.id));
}

/** Approve a reviewed plan → start producing. */
export async function approvePlanController({ params, set }: GetReelContext) {
  return runEdit(set, () => approvePlan(params.id));
}

/** Discard the plan and re-plan (new story / reference / pasted script). */
export async function replanReelController({
  params,
  body,
  set,
}: ReplanContext) {
  return runEdit(set, () => replanReel(params.id, body));
}

/** Discard every episode's plan in a series and re-plan from one selected story. */
export async function replanReelSeriesController({
  params,
  body,
  set,
}: ReplanSeriesContext) {
  return runEdit(set, () => replanReelSeries(params.id, body));
}

/** Move one spoken line across the seam between this part and the next. */
export async function moveSeriesBoundaryController({
  params,
  body,
  set,
}: MoveBoundaryContext) {
  return runEdit(set, () => moveSeriesBoundary(params.id, body.direction));
}

/** Merge this part's lines into the previous part, then delete this part. */
export async function mergePartController({ params, set }: GetReelContext) {
  return runEdit(set, () => mergePartIntoPrevious(params.id));
}

/** Re-scan the OP's followups/updates; optionally add a manual followup link. */
export async function rescanReelUpdatesController({ params, body, set }: RescanUpdatesContext) {
  return runEdit(set, () => rescanReelUpdates(params.id, { manualUrl: body.manualUrl }));
}

/** Fold the chosen updates into the story and recompute parts (append/recut). */
export async function applyReelUpdatesController({ params, body, set }: ApplyUpdatesContext) {
  return runEdit(set, () => applyReelUpdates(params.id, { includedKeys: body.includedKeys, mode: body.mode }));
}

/** Manually restructure the Reddit series into a chosen number of parts. */
export async function restructureSeriesPartsController({ params, body, set }: RestructurePartsContext) {
  return runEdit(set, () => restructureSeriesParts(params.id, body.parts));
}

/** Read-only recommendation before the user commits to a re-split. */
export async function getSeriesStructureAdviceController({ params, set }: StructureAdviceContext) {
  return runEdit(set, () => getSeriesStructureAdvice(params.id));
}

export async function chooseSeriesStructureController({ params, body, set }: StructureDecisionContext) {
  return runEdit(set, () => chooseSeriesStructure(params.id, body.choice));
}

// ---- Multi-channel destinations ----

/** List a reel's publish destinations (legacy outro fields resolve as one). */
export async function listReelDestinationsController({ params, set }: GetReelContext) {
  return runEdit(set, () => listReelDestinations(params.id));
}

/** Add a channel destination; renders its outro now when already produced. */
export async function addReelDestinationController({ params, body, set }: AddDestinationContext) {
  return runEdit(set, () =>
    addReelDestination(params.id, {
      platform: body.platform,
      channelId: body.channelId,
      outro: body.outro,
    })
  );
}

/** Remove a destination (keeps at least one). */
export async function removeReelDestinationController({ params, set }: DestinationContext) {
  return runEdit(set, () => removeReelDestination(params.id, params.destId));
}

/** Update one destination's outro copy; re-renders that outro when produced. */
export async function updateReelDestinationOutroController({
  params,
  body,
  set,
}: UpdateDestinationOutroContext) {
  return runEdit(set, () => updateReelDestinationOutro(params.id, params.destId, body.outro));
}

/** Promote a channel as primary, keeping or reclaiming the old primary's
 * channel-scoped output according to the explicit user choice. */
export async function setReelPrimaryDestinationController({
  params,
  body,
  set,
}: SetPrimaryDestinationContext) {
  return runEdit(set, () => setReelPrimaryDestination(params.id, body));
}

export async function saveReelEditDraftController({
  params,
  set,
}: GetReelContext) {
  return runEdit(set, () => saveEditDraft(params.id));
}

export async function discardReelEditDraftController({
  params,
  set,
}: GetReelContext) {
  return runEdit(set, () => discardEditDraft(params.id));
}

export async function getReelDraftAssetController({
  params,
  set,
}: DraftAssetContext) {
  try {
    const path = await getDraftAssetPath(params.draftId, params.filename);
    if (params.filename.endsWith(".mp4"))
      set.headers["content-type"] = "video/mp4";
    else if (params.filename.endsWith(".mp3"))
      set.headers["content-type"] = "audio/mpeg";
    else if (params.filename.endsWith(".png"))
      set.headers["content-type"] = "image/png";
    else if (params.filename.endsWith(".ass"))
      set.headers["content-type"] = "text/plain";
    return Bun.file(path);
  } catch (error: unknown) {
    set.status = 404;
    return { success: false, error: getErrorMessage(error) };
  }
}

/** List the style-preset bundles (optionally filtered by niche). */
export async function listStylePresetsController({
  query,
}: {
  query: { niche?: string };
}) {
  return { success: true, data: listStylePresets(query.niche) };
}

/** List the bundled caption/thumbnail fonts. */
export async function listFontsController() {
  return { success: true, data: listFonts() };
}

/** Serve a bundled font file for WYSIWYG thumbnail/caption previews in the client. */
export async function getFontFileController({
  params,
  set,
}: {
  params: { file: string };
  set: Context["set"];
}) {
  const safe = basename(params.file);
  if (safe !== params.file || safe.includes("..")) {
    set.status = 400;
    return { success: false, error: "Invalid font file" };
  }
  const known = listFonts().some((f) => f.file === safe);
  if (!known) {
    set.status = 404;
    return { success: false, error: "Font not found" };
  }
  const path = join(FONTS_DIR, safe);
  if (!existsSync(path)) {
    set.status = 404;
    return { success: false, error: "Font file missing on disk" };
  }
  set.headers["Content-Type"] = "font/ttf";
  set.headers["Cache-Control"] = "public, max-age=86400";
  return file(path);
}

interface CustomThumbnailContext extends Context {
  params: TIdParams;
  body: TCustomThumbnailBody;
}

/** Compose a thumbnail from a video frame + custom overlay text (manual variant). */
export async function customFrameThumbnailController({
  params,
  body,
  set,
}: CustomThumbnailContext) {
  try {
    const review = await useReelFrameWithText(params.id, body);
    return { success: true, data: review };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

/** Render a local, non-persisted thumbnail text-overlay preview. */
export async function previewCustomFrameThumbnailController({
  params,
  body,
  set,
}: CustomThumbnailContext) {
  try {
    const imageDataUrl = await previewReelFrameWithText(params.id, body);
    return { success: true, data: { imageDataUrl } };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

// ============================================
// Thumbnail Studio draft controllers
// ============================================

interface ThumbnailSourceContext extends Context {
  params: TIdParams;
  body: TThumbnailSourceBody;
}

/** Render an aspect-corrected background source (frame / scene still / saved
 *  thumbnail) as a data URL for the client-side editor canvas. */
export async function getThumbnailSourceController({
  params,
  body,
  set,
}: ThumbnailSourceContext) {
  try {
    const imageDataUrl = await previewThumbnailSource(params.id, body);
    return { success: true, data: { imageDataUrl } };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

interface StageThumbnailImageContext extends Context {
  params: TIdParams;
  body: TStageThumbnailImageBody;
}

interface SaveShortsCoverContext extends Context {
  params: TIdParams;
  body: TSaveShortsCoverBody;
}

export async function saveShortsCoverController({ params, body, set }: SaveShortsCoverContext) {
  try {
    return { success: true, data: await saveShortsCover(params.id, body) };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function clearShortsCoverController({ params, set }: GetReelContext) {
  try {
    return { success: true, data: await clearShortsCover(params.id) };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

/** Stage a client-rendered thumbnail PNG locally (no S3 upload). */
export async function stageThumbnailDraftImageController({
  params,
  body,
  set,
}: StageThumbnailImageContext) {
  try {
    const reel = await stageThumbnailDraftImage(params.id, body);
    return { success: true, data: reel };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

interface StageThumbnailDraftContext extends Context {
  params: TIdParams;
  body: TStageThumbnailDraftBody;
}

/** Compose and stage a thumbnail locally (no S3 upload). */
export async function stageThumbnailDraftController({
  params,
  body,
  set,
}: StageThumbnailDraftContext) {
  try {
    const reel = await stageThumbnailDraft(params.id, body);
    return { success: true, data: reel };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

/** Upload the staged thumbnail draft to S3 and clean up the local files. */
export async function saveThumbnailDraftController({
  params,
  set,
}: GetReelContext) {
  try {
    const reel = await saveThumbnailDraft(params.id);
    return { success: true, data: reel };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

/** Discard the staged thumbnail draft (local files only). */
export async function discardThumbnailDraftController({
  params,
  set,
}: GetReelContext) {
  try {
    const reel = await discardThumbnailDraft(params.id);
    return { success: true, data: reel };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

/** Serve a locally staged thumbnail draft image. */
export async function getThumbnailDraftAssetController({
  params,
  set,
}: DraftAssetContext) {
  try {
    const path = await getThumbnailDraftAssetPath(
      params.draftId,
      params.filename,
    );
    set.headers["content-type"] = "image/png";
    return Bun.file(path);
  } catch (error: unknown) {
    set.status = 404;
    return { success: false, error: getErrorMessage(error) };
  }
}

/** Delete a reel record. Series-aware: deleting a part renumbers its siblings
 *  so a series never lingers with a stale "Part N of M" count. */
export async function deleteReelController({ params, set }: GetReelContext) {
  try {
    const result = await deleteSeriesPart(params.id);
    if (!result) {
      set.status = 404;
      return { success: false, error: "Reel not found" };
    }
    return { success: true, message: "Reel deleted", data: result };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

/** Delete one part of a series and renumber the survivors. */
export async function deleteSeriesPartController({
  params,
  set,
}: GetReelContext) {
  try {
    const result = await deleteSeriesPart(params.id);
    if (!result) {
      set.status = 404;
      return { success: false, error: "Reel not found" };
    }
    return { success: true, data: result };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}
