import { Elysia, t } from "elysia";
import {
  createTemplate,
  getTemplate,
  listTemplates,
  deleteTemplate,
  addCharactersToTemplate,
  removeCharactersFromTemplate,
} from "../services";

export const templateRoutes = new Elysia({ prefix: "/api/templates" })
  // Upload a new template
  .post(
    "/",
    async ({ body }) => {
      const { video, name, description } = body;

      if (!video) {
        return { success: false, error: "No video file provided" };
      }

      try {
        const buffer = Buffer.from(await video.arrayBuffer());
        const template = await createTemplate(
          buffer,
          video.name,
          name,
          description || ""
        );

        return { success: true, data: template };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    },
    {
      body: t.Object({
        video: t.File(),
        name: t.String(),
        description: t.Optional(t.String()),
      }),
    }
  )

  // List all templates
  .get("/", async () => {
    const templates = await listTemplates();
    return { success: true, data: templates };
  })

  // Get template by ID
  .get(
    "/:id",
    async ({ params }) => {
      const template = await getTemplate(params.id);
      if (!template) {
        return { success: false, error: "Template not found" };
      }
      return { success: true, data: template };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
    }
  )

  // Add characters to template
  .post(
    "/:id/characters",
    async ({ params, body }) => {
      try {
        const template = await addCharactersToTemplate(
          params.id,
          body.characterIds
        );
        if (!template) {
          return { success: false, error: "Template not found" };
        }
        return { success: true, data: template };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({ characterIds: t.Array(t.String()) }),
    }
  )

  // Remove characters from template
  .delete(
    "/:id/characters",
    async ({ params, body }) => {
      try {
        const template = await removeCharactersFromTemplate(
          params.id,
          body.characterIds
        );
        if (!template) {
          return { success: false, error: "Template not found" };
        }
        return { success: true, data: template };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({ characterIds: t.Array(t.String()) }),
    }
  )

  // Delete template
  .delete(
    "/:id",
    async ({ params }) => {
      const deleted = await deleteTemplate(params.id);
      if (!deleted) {
        return { success: false, error: "Template not found" };
      }
      return { success: true, data: { deleted: true } };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
    }
  );
