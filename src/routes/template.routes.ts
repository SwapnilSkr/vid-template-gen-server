import { Elysia } from "elysia";
import { fileUpload } from "../middlewares";
import {
  IdParams,
  CreateTemplateBody,
  UpdateTemplateBody,
  TemplateCharactersBody,
} from "../types/guards";
import {
  createTemplateController,
  listTemplatesController,
  getTemplateController,
  updateTemplateController,
  addCharactersToTemplateController,
  removeCharactersFromTemplateController,
  deleteTemplateController,
} from "../controllers";

// ============================================
// Upload Middleware Configuration
// ============================================

const videoUploadMiddleware = fileUpload([
  { field: "video", type: "video", folder: "templates", required: false },
]);

// ============================================
// Template Routes
// ============================================

export const templateRoutes = new Elysia({ prefix: "/api/templates" })
  // Upload a new template
  .guard(
    {
      body: CreateTemplateBody,
    },
    (app) => app.use(videoUploadMiddleware).post("/", createTemplateController)
  )

  // List all templates
  .get("/", listTemplatesController)

  // Get template by ID
  .get("/:id", getTemplateController, {
    params: IdParams,
  })

  // Update template
  .guard(
    {
      params: IdParams,
      body: UpdateTemplateBody,
    },
    (app) =>
      app.use(videoUploadMiddleware).put("/:id", updateTemplateController)
  )

  // Add characters to template
  .post("/:id/characters", addCharactersToTemplateController, {
    params: IdParams,
    body: TemplateCharactersBody,
  })

  // Remove characters from template
  .delete("/:id/characters", removeCharactersFromTemplateController, {
    params: IdParams,
    body: TemplateCharactersBody,
  })

  // Delete template
  .delete("/:id", deleteTemplateController, {
    params: IdParams,
  });
