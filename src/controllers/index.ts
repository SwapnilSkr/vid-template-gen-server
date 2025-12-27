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
} from "./composition.controller";

// Voice controllers
export { listVoicesController } from "./voice.controller";

// Audio Test controllers
export {
  runAudioTestController,
  runCustomAudioTestController,
  listTestFilesController,
  cleanupTestFilesController,
} from "./audio.controller";
