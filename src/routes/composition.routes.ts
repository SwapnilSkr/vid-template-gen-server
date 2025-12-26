import { Elysia } from "elysia";
import { IdParams, CreateCompositionBody } from "../types/guards";
import {
  createCompositionController,
  listCompositionsController,
  getCompositionStatusController,
  downloadCompositionController,
  generateCompositionController,
  getGeneratedCompositionController,
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
