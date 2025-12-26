import { Elysia } from "elysia";
import { listVoicesController } from "../controllers";

// ============================================
// Voice Routes
// ============================================

export const voiceRoutes = new Elysia({ prefix: "/api/voices" })
  // List all available voices from ElevenLabs
  .get("/", listVoicesController);
