import { Elysia } from "elysia";
import {
  IdParams,
  SeriesParams,
  CreateReelBody,
  UpdateReelReviewBody,
  RevoiceReelBody,
  VariantParams,
  ThumbnailFrameBody,
  ThumbnailSceneBody,
  CustomThumbnailBody,
  StageThumbnailDraftBody,
  StageThumbnailImageBody,
  ThumbnailSourceBody,
  PublishReelBody,
  DistributeReelBody,
  SceneIndexParams,
  UpdateSceneBody,
  RegenerateSceneBody,
  AddSceneBody,
  ReorderScenesBody,
  UpdateReelSettingsBody,
  UpdateCaptionsBody,
  UpdateRedditCardBody,
  RegenerateReelBody,
  ReplanReelBody,
  ReplanReelSeriesBody,
  MoveBoundaryBody,
  RescanUpdatesBody,
  ApplyUpdatesBody,
  RestructurePartsBody,
  StructureDecisionBody,
  DestinationInputBody,
  DestinationParams,
  UpdateDestinationOutroBody,
  DraftAssetParams,
  SaveShortsCoverBody,
} from "../types/guards";
import {
  createReelController,
  listReelsController,
  listReelSeriesController,
  getReelStatusController,
  downloadReelController,
  deleteReelController,
  deleteSeriesPartController,
  publishReelController,
  distributeReelController,
  getReelReviewController,
  updateReelReviewController,
  regenerateReelThumbnailController,
  regenerateReelReviewCopyController,
  regenerateInstagramCaptionController,
  revoiceReelController,
  promoteVoiceVariantController,
  previewReelFrameThumbnailController,
  useReelFrameAsThumbnailController,
  useReelSceneImageAsThumbnailController,
  previewCustomFrameThumbnailController,
  customFrameThumbnailController,
  listYouTubeChannelsController,
  updateSceneController,
  regenerateSceneController,
  addSceneController,
  removeSceneController,
  reorderScenesController,
  updateReelSettingsController,
  updateCaptionsController,
  updateRedditCardController,
  applyCaptionsController,
  regenerateReelController,
  resumeFailedReelController,
  approvePlanController,
  replanReelController,
  replanReelSeriesController,
  moveSeriesBoundaryController,
  mergePartController,
  rescanReelUpdatesController,
  applyReelUpdatesController,
  restructureSeriesPartsController,
  getSeriesStructureAdviceController,
  chooseSeriesStructureController,
  listReelDestinationsController,
  addReelDestinationController,
  removeReelDestinationController,
  updateReelDestinationOutroController,
  saveReelEditDraftController,
  discardReelEditDraftController,
  getReelDraftAssetController,
  getThumbnailSourceController,
  stageThumbnailDraftController,
  stageThumbnailDraftImageController,
  saveThumbnailDraftController,
  discardThumbnailDraftController,
  getThumbnailDraftAssetController,
  saveShortsCoverController,
  clearShortsCoverController,
} from "../controllers";

// ============================================
// Reel Routes (scene-graph pipeline: Reddit/AITA, dark history, etc.)
// ============================================

export const reelRoutes = new Elysia({ prefix: "/api/reels" })
  // Create a new reel (one-command generation, async)
  .post("/", createReelController, {
    body: CreateReelBody,
  })

  // List all reels
  .get("/", listReelsController)

  // List configured YouTube publish targets. Refresh tokens are never returned.
  .get("/youtube/channels", listYouTubeChannelsController)

  // List every reel in a multipart series
  .get("/series/:seriesId", listReelSeriesController, {
    params: SeriesParams,
  })

  // Local staged edit assets. These are not S3 objects and are removed when
  // the user saves/discards the pending draft or local cleanup sweeps them.
  .get("/drafts/:draftId/assets/:filename", getReelDraftAssetController, {
    params: DraftAssetParams,
  })

  // Locally staged Thumbnail Studio drafts — same lifecycle discipline: not
  // S3 objects, removed on save/discard/restage or when the reel is deleted.
  .get("/thumb-drafts/:draftId/assets/:filename", getThumbnailDraftAssetController, {
    params: DraftAssetParams,
  })

  // Get reel status/progress
  .get("/:id/status", getReelStatusController, {
    params: IdParams,
  })

  // Download completed reel
  .get("/:id/download", downloadReelController, {
    params: IdParams,
  })

  // Review package for title, description, tags, thumbnail, and visibility notes
  .get("/:id/review", getReelReviewController, {
    params: IdParams,
  })

  .put("/:id/review", updateReelReviewController, {
    params: IdParams,
    body: UpdateReelReviewBody,
  })

  .post("/:id/review/thumbnail", regenerateReelThumbnailController, {
    params: IdParams,
    body: UpdateReelReviewBody,
  })

  .post("/:id/review/copy", regenerateReelReviewCopyController, {
    params: IdParams,
  })

  .post("/:id/instagram-caption", regenerateInstagramCaptionController, {
    params: IdParams,
  })

  // Use a specific frame of the rendered video as the thumbnail
  .post("/:id/review/thumbnail/frame/preview", previewReelFrameThumbnailController, {
    params: IdParams,
    body: ThumbnailFrameBody,
  })

  .post("/:id/review/thumbnail/frame", useReelFrameAsThumbnailController, {
    params: IdParams,
    body: ThumbnailFrameBody,
  })

  // Use a generated scene still as the thumbnail source (no burned captions)
  .post("/:id/review/thumbnail/scene", useReelSceneImageAsThumbnailController, {
    params: IdParams,
    body: ThumbnailSceneBody,
  })

  // Compose a thumbnail from a frame + custom overlay caption text (manual)
  .post("/:id/review/thumbnail/custom/preview", previewCustomFrameThumbnailController, {
    params: IdParams,
    body: CustomThumbnailBody,
  })

  .post("/:id/review/thumbnail/custom", customFrameThumbnailController, {
    params: IdParams,
    body: CustomThumbnailBody,
  })

  // Aspect-corrected background source for the client-side editor canvas
  // (video frame, scene still, or the saved thumbnail — as a data URL).
  .post("/:id/thumbnail-source", getThumbnailSourceController, {
    params: IdParams,
    body: ThumbnailSourceBody,
  })

  // Thumbnail Studio: stage a composed thumbnail locally, then save (upload to
  // S3 + delete the superseded object) or discard (wipe local files).
  .post("/:id/thumbnail-draft", stageThumbnailDraftController, {
    params: IdParams,
    body: StageThumbnailDraftBody,
  })

  // Stage a client-rendered canvas export (WYSIWYG PNG + editor state)
  .post("/:id/thumbnail-draft/image", stageThumbnailDraftImageController, {
    params: IdParams,
    body: StageThumbnailImageBody,
  })

  .post("/:id/thumbnail-draft/save", saveThumbnailDraftController, {
    params: IdParams,
  })

  .post("/:id/thumbnail-draft/discard", discardThumbnailDraftController, {
    params: IdParams,
  })

  // Vertical artwork embedded in the actual Short. Saving is deterministic;
  // applying it uses the existing composite-only render path (zero AI calls).
  .put("/:id/shorts-cover", saveShortsCoverController, {
    params: IdParams,
    body: SaveShortsCoverBody,
  })
  .delete("/:id/shorts-cover", clearShortsCoverController, { params: IdParams })

  // Request re-narrated voice variants (different TTS model/voice, same story + gameplay clip)
  .post("/:id/revoice", revoiceReelController, {
    params: IdParams,
    body: RevoiceReelBody,
  })

  // Promote a ready voice variant to be the reel's primary output
  .post("/:id/revoice/:variantId/promote", promoteVoiceVariantController, {
    params: VariantParams,
  })

  // Delete a reel
  .delete("/:id", deleteReelController, {
    params: IdParams,
  })

  // Delete one part of a series and renumber the remaining parts
  .delete("/:id/part", deleteSeriesPartController, {
    params: IdParams,
  })

  // Publish (or retry publishing) a completed reel to YouTube
  .post("/:id/publish", publishReelController, {
    params: IdParams,
    body: PublishReelBody,
  })
  .post("/:id/distribute", distributeReelController, { params: IdParams, body: DistributeReelBody })

  // ---- Studio editing (co-creation) ----
  // Approve a reviewed plan → start producing
  .post("/:id/approve-plan", approvePlanController, { params: IdParams })

  // Resume a failed produce job (reuse S3 assets, re-run render→upload)
  .post("/:id/resume", resumeFailedReelController, { params: IdParams })

  // Discard the plan and re-plan (new story / reference / pasted script)
  .post("/:id/replan", replanReelController, { params: IdParams, body: ReplanReelBody })

  // Re-plan every episode in a Reddit series from one selected story
  .post("/:id/replan-series", replanReelSeriesController, {
    params: IdParams,
    body: ReplanReelSeriesBody,
  })

  // Move a spoken line across the seam between this part and the next
  .post("/:id/move-boundary", moveSeriesBoundaryController, {
    params: IdParams,
    body: MoveBoundaryBody,
  })

  // Merge this part's lines into the previous part, then delete this part
  .post("/:id/merge-into-previous", mergePartController, {
    params: IdParams,
  })

  // Re-scan the OP's followups/updates (optionally add a manual followup link)
  .post("/:id/updates/rescan", rescanReelUpdatesController, {
    params: IdParams,
    body: RescanUpdatesBody,
  })

  // Fold the chosen updates into the story and recompute parts (append/recut)
  .put("/:id/updates", applyReelUpdatesController, {
    params: IdParams,
    body: ApplyUpdatesBody,
  })

  // Manually restructure the series into N parts (split/add/rebalance)
  .post("/:id/restructure-parts", restructureSeriesPartsController, {
    params: IdParams,
    body: RestructurePartsBody,
  })

  // Read-only duration/cliffhanger recommendation for the assembled story
  .get("/:id/structure-advice", getSeriesStructureAdviceController, {
    params: IdParams,
  })
  .post("/:id/structure-decision", chooseSeriesStructureController, {
    params: IdParams,
    body: StructureDecisionBody,
  })

  // Multi-channel destinations
  .get("/:id/destinations", listReelDestinationsController, { params: IdParams })
  .post("/:id/destinations", addReelDestinationController, {
    params: IdParams,
    body: DestinationInputBody,
  })
  .delete("/:id/destinations/:destId", removeReelDestinationController, {
    params: DestinationParams,
  })
  .put("/:id/destinations/:destId/outro", updateReelDestinationOutroController, {
    params: DestinationParams,
    body: UpdateDestinationOutroBody,
  })

  // Reorder scenes (2-segment path — declared before the :index routes)
  .post("/:id/scenes/reorder", reorderScenesController, {
    params: IdParams,
    body: ReorderScenesBody,
  })

  // Regenerate a single scene's image and/or audio
  .post("/:id/scenes/:index/regenerate", regenerateSceneController, {
    params: SceneIndexParams,
    body: RegenerateSceneBody,
  })

  // Edit one scene (narration / visual prompt / motion)
  .patch("/:id/scenes/:index", updateSceneController, {
    params: SceneIndexParams,
    body: UpdateSceneBody,
  })

  // Remove a scene
  .delete("/:id/scenes/:index", removeSceneController, { params: SceneIndexParams })

  // Add a scene
  .post("/:id/scenes", addSceneController, { params: IdParams, body: AddSceneBody })

  // Reel-level creative settings (art/motion/image model/voice/audio post)
  .put("/:id/settings", updateReelSettingsController, {
    params: IdParams,
    body: UpdateReelSettingsBody,
  })

  // Caption look (manual, non-AI)
  .put("/:id/captions", updateCaptionsController, {
    params: IdParams,
    body: UpdateCaptionsBody,
  })

  // Reddit title card (gameplay reels)
  .put("/:id/reddit-card", updateRedditCardController, {
    params: IdParams,
    body: UpdateRedditCardBody,
  })

  // Re-render with new caption style, upload, and delete superseded output.
  .post("/:id/captions/apply", applyCaptionsController, {
    params: IdParams,
    body: UpdateCaptionsBody,
  })

  // Queue a produce run — render-only (reuse assets) or full asset regen
  .post("/:id/regenerate", regenerateReelController, {
    params: IdParams,
    body: RegenerateReelBody,
  })

  // Commit or discard the currently staged local editor draft.
  .post("/:id/edit-draft/save", saveReelEditDraftController, { params: IdParams })
  .post("/:id/edit-draft/discard", discardReelEditDraftController, { params: IdParams });
