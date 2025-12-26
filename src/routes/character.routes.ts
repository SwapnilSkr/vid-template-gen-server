import { Elysia } from "elysia";
import { fileUpload } from "../middlewares";
import {
  IdParams,
  CreateCharacterBody,
  UpdateCharacterBody,
} from "../types/guards";
import {
  createCharacterController,
  listCharactersController,
  getCharacterController,
  updateCharacterController,
  deleteCharacterController,
} from "../controllers";

// ============================================
// Upload Middleware Configuration
// ============================================

const imageUploadMiddleware = fileUpload([
  { field: "image", type: "image", folder: "characters", required: false },
]);

// ============================================
// Character Routes
// ============================================

export const characterRoutes = new Elysia({ prefix: "/api/characters" })
  // Create a new character
  .guard(
    {
      body: CreateCharacterBody,
    },
    (app) => app.use(imageUploadMiddleware).post("/", createCharacterController)
  )

  // List all characters
  .get("/", listCharactersController)

  // Get character by ID or name
  .get("/:id", getCharacterController, {
    params: IdParams,
  })

  // Update character
  .guard(
    {
      params: IdParams,
      body: UpdateCharacterBody,
    },
    (app) =>
      app.use(imageUploadMiddleware).put("/:id", updateCharacterController)
  )

  // Delete character
  .delete("/:id", deleteCharacterController, {
    params: IdParams,
  });
