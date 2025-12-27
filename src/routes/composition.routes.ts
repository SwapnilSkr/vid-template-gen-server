import { Elysia } from "elysia";
import {
  IdParams,
  CreateCompositionBody,
  RegenerateCompositionBody,
} from "../types/guards";
import {
  createCompositionController,
  listCompositionsController,
  getCompositionStatusController,
  downloadCompositionController,
  generateCompositionController,
  getGeneratedCompositionController,
  regenerateCompositionController,
} from "../controllers";

// ============================================
// Composition Routes
// ============================================

export const compositionRoutes = new Elysia({ prefix: "/api/compositions" })
  // Create a new composition (one-command generation)
  .post("/", createCompositionController, {
    body: CreateCompositionBody,
  })

  // List all compositions
  .get("/", listCompositionsController)

  // Get composition status
  .get("/:id/status", getCompositionStatusController, {
    params: IdParams,
  })

  // Download completed composition
  .get("/:id/download", downloadCompositionController, {
    params: IdParams,
  })

  // Regenerate composition with existing audio (saves ElevenLabs costs)
  .post("/:id/regenerate", regenerateCompositionController, {
    params: IdParams,
    body: RegenerateCompositionBody,
  });

// ============================================
// Generate Routes (Alias for simpler one-command generation)
// ============================================

export const generateRoutes = new Elysia({ prefix: "/api/generate" })
  .post("/", generateCompositionController, {
    body: CreateCompositionBody,
  })
  .get("/:id", getGeneratedCompositionController, {
    params: IdParams,
  });
