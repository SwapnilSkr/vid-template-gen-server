import { Elysia, t } from "elysia";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createComposition, getJob, listJobs } from "../services";
import { fileExists } from "../utils";

export const compositionRoutes = new Elysia({ prefix: "/api/compositions" })
  // Create a new composition
  .post(
    "/",
    async ({ body }) => {
      try {
        const job = await createComposition(body as any);
        return { success: true, data: job };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    },
    {
      body: t.Object({
        templateId: t.String(),
        title: t.String(),
        dialogue: t.Array(
          t.Object({
            characterId: t.String(),
            text: t.String(),
            startTime: t.Number(),
            duration: t.Optional(t.Number()),
            position: t.Optional(
              t.Object({
                x: t.Number(),
                y: t.Number(),
                scale: t.Number(),
                anchor: t.String(),
              })
            ),
          })
        ),
        outputSettings: t.Optional(
          t.Object({
            resolution: t.Optional(
              t.Union([t.Literal("720p"), t.Literal("1080p"), t.Literal("4k")])
            ),
            format: t.Optional(t.Union([t.Literal("mp4"), t.Literal("webm")])),
            quality: t.Optional(
              t.Union([
                t.Literal("low"),
                t.Literal("medium"),
                t.Literal("high"),
              ])
            ),
          })
        ),
      }),
    }
  )

  // List all composition jobs
  .get("/", ({ query }) => {
    const limit = query.limit ? parseInt(query.limit) : 50;
    const jobs = listJobs(limit);
    return { success: true, data: jobs };
  })

  // Get composition status
  .get(
    "/:id/status",
    ({ params }) => {
      const job = getJob(params.id);
      if (!job) {
        return { success: false, error: "Job not found" };
      }
      return { success: true, data: job };
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
      const job = getJob(params.id);
      if (!job) {
        set.status = 404;
        return { success: false, error: "Job not found" };
      }

      if (job.status !== "completed") {
        set.status = 400;
        return {
          success: false,
          error: `Job not completed. Current status: ${job.status}`,
          progress: job.progress,
        };
      }

      if (!job.outputPath || !(await fileExists(job.outputPath))) {
        set.status = 404;
        return { success: false, error: "Output file not found" };
      }

      const stats = await stat(job.outputPath);
      const filename = job.outputPath.split("/").pop() || "output.mp4";

      set.headers["Content-Type"] = "video/mp4";
      set.headers["Content-Disposition"] = `attachment; filename="${filename}"`;
      set.headers["Content-Length"] = String(stats.size);

      return new Response(Bun.file(job.outputPath));
    },
    {
      params: t.Object({
        id: t.String(),
      }),
    }
  );
