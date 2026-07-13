import { getErrorMessage } from "../types";
import { cleanupLocalProcessing } from "./local-cleanup.service";
import { reconcileS3Assets } from "./s3-reconciliation.service";
import { cleanupGameplayDownloadCache } from "./gameplay-cache.service";
import { recordOperationLog } from "./operation-log.service";

// ============================================
// In-process hygiene scheduler — the same pattern as the story top-up
// scheduler: cheap periodic checks, no extra infra. Keeps both stores lean
// without waiting for someone to remember the maintenance endpoints:
//
//  • local: crashed render scratch + Mongo-orphaned draft dirs
//  • S3: objects under the generated-output folders no document references
//    (reconcileS3Assets already carries a 2h age margin so it can never race
//    an in-flight render)
//
// For multi-instance deployments point HYGIENE_SWEEP_ENABLED=false at all but
// one process (or run scripts/reconcile-s3.ts on external cron).
// ============================================

let started = false;

const DEFAULT_INTERVAL_HOURS = 12;

export function startHygieneScheduler(): void {
  if (process.env.HYGIENE_SWEEP_ENABLED === "false") {
    console.log("⏸️  Hygiene sweep scheduler disabled (HYGIENE_SWEEP_ENABLED=false)");
    return;
  }
  if (started) return;
  started = true;

  const intervalMs =
    Math.max(Number(process.env.HYGIENE_SWEEP_INTERVAL_HOURS) || DEFAULT_INTERVAL_HOURS, 1) *
    60 *
    60 *
    1000;

  const run = async () => {
    try {
      const local = await cleanupLocalProcessing(false);
      const gameplay = await cleanupGameplayDownloadCache(false);
      const s3 = await reconcileS3Assets(false);
      if (local.deleted > 0 || gameplay.deleted > 0 || s3.deleted.length > 0) {
        console.log(
          `🧹 Hygiene sweep: local ${local.deleted} entries (${Math.round(local.bytesDeleted / 1024 / 1024)} MB), ` +
            `gameplay cache ${gameplay.deleted} clips (${Math.round(gameplay.bytesDeleted / 1024 / 1024)} MB), ` +
            `S3 ${s3.deleted.length} orphaned object(s) deleted`
        );
      }
    } catch (error: unknown) {
      console.error("Hygiene sweep failed:", getErrorMessage(error));
      recordOperationLog({
        scope: "system",
        level: "error",
        event: "scheduler.hygiene_sweep_failed",
        message: "Storage hygiene scheduler failed",
        error,
      });
    }
  };

  console.log(`🧹 Hygiene sweep scheduler started (every ${Math.round(intervalMs / 3_600_000)}h)`);
  // First pass shortly after boot (startup already did a local sweep; this
  // adds the S3 side once the DB connection is warm), then on the interval.
  setTimeout(run, 30_000);
  setInterval(run, intervalMs);
}
