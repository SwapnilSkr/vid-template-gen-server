import { Elysia } from "elysia";
import { ReelDefaultsQuery, VoiceSampleQuery } from "../types/guards";
import {
  listGameplayController,
  listTtsVoicesController,
  getVoiceSampleController,
  listImageModelsController,
  listHorrorAudioController,
  getReelDefaultsController,
} from "../controllers";

// ============================================
// Reference-data routes for the create/revoice UI: the gameplay clip pool
// (S3 gameplay/ prefix) and the curated cross-model TTS voice catalog.
// ============================================

export const metaRoutes = new Elysia({ prefix: "/api" })
  .get("/gameplay", listGameplayController)
  .get("/horror-audio", listHorrorAudioController)
  .get("/image-models", listImageModelsController)
  .get("/reel-defaults", getReelDefaultsController, { query: ReelDefaultsQuery })
  .get("/tts-voices", listTtsVoicesController)
  .get("/tts-voices/sample", getVoiceSampleController, { query: VoiceSampleQuery });
