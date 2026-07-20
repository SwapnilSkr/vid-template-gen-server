// Character controllers
export {
  createCharacterController,
  listCharactersController,
  getCharacterController,
  updateCharacterController,
  deleteCharacterController,
} from "./character.controller";

// Template controllers
export {
  createTemplateController,
  listTemplatesController,
  getTemplateController,
  updateTemplateController,
  addCharactersToTemplateController,
  removeCharactersFromTemplateController,
  deleteTemplateController,
} from "./template.controller";

// Composition controllers
export {
  createCompositionController,
  listCompositionsController,
  getCompositionStatusController,
  downloadCompositionController,
  generateCompositionController,
  getGeneratedCompositionController,
  regenerateCompositionController,
} from "./composition.controller";

// Reel controllers
export {
  createReelController,
  listReelsController,
  listReelSeriesController,
  getReelStatusController,
  downloadReelController,
  trimFinishedReelVideoController,
  deleteReelController,
  deleteSeriesPartController,
  publishReelController,
  distributeReelController,
  getReelReviewController,
  updateReelReviewController,
  regenerateReelThumbnailController,
  regenerateReelReviewCopyController,
  regenerateInstagramCaptionController,
  regenerateInstagramPollSuggestionController,
  regenerateCrossPostCopyController,
  regenerateThumbnailTextController,
  regenerateOutroCommentPromptController,
  revoiceReelController,
  promoteVoiceVariantController,
  listGameplayController,
  listHorrorAudioController,
  listArtStylesController,
  listImageModelsController,
  getReelDefaultsController,
  listTtsVoicesController,
  previewReelFrameThumbnailController,
  useReelFrameAsThumbnailController,
  useReelSceneImageAsThumbnailController,
  getVoiceSampleController,
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
  retryReelOutroController,
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
  setReelPrimaryDestinationController,
  saveReelEditDraftController,
  discardReelEditDraftController,
  getReelDraftAssetController,
  listStylePresetsController,
  listFontsController,
  getFontFileController,
  previewCustomFrameThumbnailController,
  customFrameThumbnailController,
  getThumbnailSourceController,
  stageThumbnailDraftController,
  stageThumbnailDraftImageController,
  saveThumbnailDraftController,
  discardThumbnailDraftController,
  getThumbnailDraftAssetController,
  saveShortsCoverController,
  clearShortsCoverController,
} from "./reel.controller";

// Trend controllers
export {
  listTrendsController,
  getTrendSummaryController,
  getTrendInsightController,
  triggerTrendScoutController,
  listHorrorReferencesController,
  triggerHorrorReferenceScoutController,
} from "./trend.controller";

export {
  getOwnedAnalyticsOverviewController,
  syncOwnedAnalyticsController,
} from "./owned-analytics.controller";

export {
  searchYoutubeController,
  listYtImportsController,
  getYtImportController,
  createYtImportController,
  createGameplayMixController,
  extractFramesController,
  captionAtController,
  deleteYtImportController,
  streamVideoController,
  streamAudioController,
  streamCaptionsController,
  streamFrameController,
  streamAudioClipController,
} from "./yt-import.controller";

export {
  deleteGameplayLibraryController,
  renameGameplayLibraryController,
  trimGameplayLibraryController,
  speedGameplayLibraryController,
} from "./gameplay-library.controller";

// Maintenance controllers
export {
  reconcileS3Controller,
  cleanupLocalProcessingController,
  cleanupGameplayCacheController,
  purgeFailedReelsController,
} from "./maintenance.controller";

// Voice controllers
export { listVoicesController } from "./voice.controller";

// YouTube channel controllers
export {
  listYouTubePublishChannelsController,
  startYouTubeConnectController,
  completeYouTubeConnectController,
  deleteYouTubeChannelController,
  updateYouTubeChannelController,
  postYouTubeFirstCommentController,
  listYouTubeCommentsController,
  replyYouTubeCommentController,
} from "./youtube.controller";
export {
  listInstagramChannelsController,
  startInstagramConnectController,
  completeInstagramConnectController,
  deleteInstagramChannelController,
  updateInstagramChannelController,
  postInstagramFirstCommentController,
  listInstagramCommentsController,
  replyInstagramCommentController,
} from "./instagram.controller";
export {
  listFacebookPagesController,
  startFacebookConnectController,
  completeFacebookConnectController,
  deleteFacebookPageController,
  updateFacebookPageController,
  facebookUninstallController,
  facebookDataDeletionController,
  facebookDataDeletionStatusController,
  publishFacebookController,
  postFacebookFirstCommentController,
} from "./facebook.controller";
export {
  listThreadsChannelsController,
  startThreadsConnectController,
  completeThreadsConnectController,
  deleteThreadsChannelController,
  updateThreadsChannelController,
  postThreadsFirstReplyController,
  threadsUninstallController,
  threadsDataDeletionController,
  threadsDataDeletionStatusController,
  publishThreadsController,
} from "./threads.controller";

export {
  listOperationLogsController,
  deleteOperationLogController,
  deleteOperationLogsController,
  deleteAllOperationLogsController,
} from "./operation-log.controller";

// Story browse/select controllers
export {
  listStoryCandidatesController,
  listStoryBankController,
  listStoryGenresController,
  resolveStoryController,
} from "./story.controller";

// Audio Test controllers
export {
  runAudioTestController,
  runCustomAudioTestController,
  listTestFilesController,
  cleanupTestFilesController,
} from "./audio.controller";
