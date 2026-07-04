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
  getReelStatusController,
  downloadReelController,
  deleteReelController,
  publishReelController,
  getReelReviewController,
  updateReelReviewController,
  regenerateReelThumbnailController,
  revoiceReelController,
  promoteVoiceVariantController,
  listGameplayController,
  listHorrorAudioController,
  listArtStylesController,
  listImageModelsController,
  getReelDefaultsController,
  listTtsVoicesController,
  useReelFrameAsThumbnailController,
  getVoiceSampleController,
  listYouTubeChannelsController,
} from "./reel.controller";

// Trend controllers
export {
  listTrendsController,
  getTrendSummaryController,
  triggerTrendScoutController,
  listHorrorReferencesController,
  triggerHorrorReferenceScoutController,
} from "./trend.controller";

export {
  searchYoutubeController,
  listYtImportsController,
  getYtImportController,
  createYtImportController,
  extractFramesController,
  captionAtController,
  deleteYtImportController,
  streamVideoController,
  streamAudioController,
  streamCaptionsController,
  streamFrameController,
  streamAudioClipController,
} from "./yt-import.controller";

// Maintenance controllers
export { reconcileS3Controller, purgeFailedReelsController } from "./maintenance.controller";

// Voice controllers
export { listVoicesController } from "./voice.controller";

// YouTube channel controllers
export {
  listYouTubePublishChannelsController,
  startYouTubeConnectController,
  completeYouTubeConnectController,
  deleteYouTubeChannelController,
} from "./youtube.controller";

// Audio Test controllers
export {
  runAudioTestController,
  runCustomAudioTestController,
  listTestFilesController,
  cleanupTestFilesController,
} from "./audio.controller";
