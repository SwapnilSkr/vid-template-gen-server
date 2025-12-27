import { Elysia } from "elysia";
import { localFileSave } from "../middlewares";
import {
  IdParams,
  CreateTemplateBody,
  UpdateTemplateBody,
  TemplateCharactersBody,
  TemplateQuery,
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
// Local File Middleware Configuration
// ============================================

const localVideoMiddleware = localFileSave([
  { field: "video", prefix: "template", required: false },
]);

// ============================================
// Template Routes
// ============================================

export const templateRoutes = new Elysia({ prefix: "/api/templates" })
  // Upload a new template
  .guard(
    {
      body: CreateTemplateBody,
      query: TemplateQuery,
    },
    (app) => app.use(localVideoMiddleware).post("/", createTemplateController)
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
      query: TemplateQuery,
    },
    (app) => app.use(localVideoMiddleware).put("/:id", updateTemplateController)
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
