import { Elysia, t } from "elysia";
import { reconcileS3Controller, purgeFailedReelsController } from "../controllers";

// ============================================
// Cleanup/reconciliation routes — on-demand triggers for the same logic the
// cron scripts run (scripts/reconcile-s3.ts). Dry-run by default for the
// sweep so a stray click can't silently delete anything.
// ============================================

export const maintenanceRoutes = new Elysia({ prefix: "/api/maintenance" })
  .get("/s3-reconcile", reconcileS3Controller, {
    query: t.Object({ apply: t.Optional(t.String()) }),
  })
  .post("/reels/purge-failed", purgeFailedReelsController);
