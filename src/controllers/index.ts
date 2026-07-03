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
} from "./reel.controller";

// Trend controllers
export {
  listTrendsController,
  getTrendSummaryController,
  triggerTrendScoutController,
} from "./trend.controller";

// Maintenance controllers
export { reconcileS3Controller, purgeFailedReelsController } from "./maintenance.controller";

// Voice controllers
export { listVoicesController } from "./voice.controller";

// Audio Test controllers
export {
  runAudioTestController,
  runCustomAudioTestController,
  listTestFilesController,
  cleanupTestFilesController,
} from "./audio.controller";
