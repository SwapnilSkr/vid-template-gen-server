import { Elysia, t } from "elysia";
import {
  createComposition,
  getComposition,
  listCompositions,
} from "../services";

export const compositionRoutes = new Elysia({ prefix: "/api/compositions" })
  // Create a new composition (one-command generation)
  .post(
    "/",
    async ({ body }) => {
      try {
        const job = await createComposition(
          body.templateId,
          body.plot,
          body.title
        );
        return {
          success: true,
          data: job,
          message: "Composition started! Check status for progress.",
        };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    },
    {
      body: t.Object({
        templateId: t.String(),
        plot: t.String(),
        title: t.Optional(t.String()),
      }),
    }
  )

  // List all compositions
  .get("/", async ({ query }) => {
    const limit = query.limit ? parseInt(query.limit) : 50;
    const compositions = await listCompositions(limit);
    return { success: true, data: compositions };
  })

  // Get composition status
  .get(
    "/:id/status",
    async ({ params }) => {
      const composition = await getComposition(params.id);
      if (!composition) {
        return { success: false, error: "Composition not found" };
      }
      return {
        success: true,
        data: {
          id: composition._id,
          status: composition.status,
          progress: composition.progress,
          title: composition.title,
          script: composition.generatedScript,
          outputUrl: composition.outputUrl,
          error: composition.error,
        },
      };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
    }
  )

  // Download completed composition
  .get(
    "/:id/download",
    async ({ params, set }) => {
      const composition = await getComposition(params.id);
      if (!composition) {
        set.status = 404;
        return { success: false, error: "Composition not found" };
      }

      if (composition.status !== "completed") {
        set.status = 400;
        return {
          success: false,
          error: `Composition not completed. Current status: ${composition.status}`,
          progress: composition.progress,
        };
      }

      if (!composition.outputUrl) {
        set.status = 404;
        return { success: false, error: "Output not available" };
      }

      // Return S3 URL for download
      return {
        success: true,
        data: {
          downloadUrl: composition.outputUrl,
          subtitlesUrl: composition.subtitlesUrl,
        },
      };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
    }
  );

// Alias for simpler one-command generation
export const generateRoutes = new Elysia({ prefix: "/api/generate" })
  .post(
    "/",
    async ({ body }) => {
      try {
        const job = await createComposition(
          body.templateId,
          body.plot,
          body.title
        );
        return {
          success: true,
          data: {
            id: job._id,
            status: job.status,
            message: "AI is generating the script...",
          },
        };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    },
    {
      body: t.Object({
        templateId: t.String(),
        plot: t.String(),
        title: t.Optional(t.String()),
      }),
    }
  )
  .get(
    "/:id",
    async ({ params }) => {
      const composition = await getComposition(params.id);
      if (!composition) {
        return { success: false, error: "Not found" };
      }
      return {
        success: true,
        data: {
          id: composition._id,
          status: composition.status,
          progress: composition.progress,
          title: composition.title,
          script: composition.generatedScript,
          outputUrl: composition.outputUrl,
          subtitlesUrl: composition.subtitlesUrl,
          error: composition.error,
        },
      };
    },
    {
      params: t.Object({ id: t.String() }),
    }
  );
