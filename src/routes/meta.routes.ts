import { Elysia } from "elysia";
import {
  GameplayLibraryDeleteBody,
  GameplayLibraryRenameBody,
  GameplayLibrarySpeedBody,
  GameplayLibraryTrimBody,
  ReelDefaultsQuery,
  VoiceSampleQuery,
} from "../types/guards";
import {
  listGameplayController,
  listTtsVoicesController,
  getVoiceSampleController,
  listImageModelsController,
  listHorrorAudioController,
  listArtStylesController,
  getReelDefaultsController,
  listStylePresetsController,
  listFontsController,
  getFontFileController,
  deleteGameplayLibraryController,
  renameGameplayLibraryController,
  trimGameplayLibraryController,
  speedGameplayLibraryController,
} from "../controllers";
import { checkFfmpegCapability } from "../services/ffmpeg-capability.service";

// ============================================
// Reference-data routes for the create/revoice UI: the gameplay clip pool
// (S3 gameplay/ prefix) and the curated cross-model TTS voice catalog.
// ============================================

export const metaRoutes = new Elysia({ prefix: "/api" })
  .get("/gameplay", listGameplayController)
  .delete("/gameplay", deleteGameplayLibraryController, { body: GameplayLibraryDeleteBody })
  .patch("/gameplay", renameGameplayLibraryController, { body: GameplayLibraryRenameBody })
  .post("/gameplay/trim", trimGameplayLibraryController, { body: GameplayLibraryTrimBody })
  .post("/gameplay/speed", speedGameplayLibraryController, { body: GameplayLibrarySpeedBody })
  .get("/horror-audio", listHorrorAudioController)
  .get("/art-styles", listArtStylesController)
  .get("/style-presets", listStylePresetsController)
  .get("/fonts", listFontsController)
  .get("/fonts/:file", getFontFileController)
  .get("/image-models", listImageModelsController)
  .get("/reel-defaults", getReelDefaultsController, { query: ReelDefaultsQuery })
  .get("/tts-voices", listTtsVoicesController)
  .get("/tts-voices/sample", getVoiceSampleController, { query: VoiceSampleQuery })
  .get("/ffmpeg", () => {
    const capability = checkFfmpegCapability({ fresh: true });
    return {
      success: capability.ok,
      data: capability,
      error: capability.ok ? undefined : capability.message,
      code: capability.code,
    };
  });
