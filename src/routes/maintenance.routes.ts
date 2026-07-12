import { Elysia, t } from "elysia";
import { cleanupGameplayCacheController, cleanupLocalProcessingController, reconcileS3Controller, purgeFailedReelsController } from "../controllers";
import { runCaptionSmokeController } from "../controllers/caption-smoke.controller";

// ============================================
// Cleanup/reconciliation routes — on-demand triggers for the same logic the
// cron scripts run (scripts/reconcile-s3.ts). Dry-run by default for the
// sweep so a stray click can't silently delete anything.
// ============================================

export const maintenanceRoutes = new Elysia({ prefix: "/api/maintenance" })
  .get("/s3-reconcile", reconcileS3Controller, {
    query: t.Object({ apply: t.Optional(t.String()) }),
  })
  .get("/local-processing-cleanup", cleanupLocalProcessingController, {
    query: t.Object({
      apply: t.Optional(t.String()),
      olderThanHours: t.Optional(t.String()),
    }),
  })
  .get("/gameplay-cache-cleanup", cleanupGameplayCacheController, {
    query: t.Object({ apply: t.Optional(t.String()) }),
  })
  .post("/reels/purge-failed", purgeFailedReelsController)
  .get("/caption-smoke", runCaptionSmokeController, {
    query: t.Object({ keepOutput: t.Optional(t.String()) }),
    detail: {
      summary: "Caption burn smoke test",
      description:
        "Burns ASS captions onto a blue test clip (including a one-space path) " +
        "and verifies white text pixels appear. Use from Studio or curl to " +
        "validate ffmpeg/libass/fonts on this device.",
      tags: ["Maintenance", "Captions"],
    },
  });
