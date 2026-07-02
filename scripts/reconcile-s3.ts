// Sweep S3 for reel/composition assets that no current document references —
// the safety net for the class of orphan a cascading delete can never catch
// (uploaded, then a crash/stall happened before the URL was saved to Mongo).
// Safe by default: dry-run unless --apply is passed. Anything uploaded in
// the last 2 hours is always skipped (might belong to an in-flight render).
//
// Usage:
//   bun scripts/reconcile-s3.ts          # dry run — report only
//   bun scripts/reconcile-s3.ts --apply  # actually delete orphans
//
// Intended to run on a schedule (cron) alongside the trend-scout scripts —
// same "external cron, one process writes" reasoning as the rest of this repo.
import { connectDatabase, disconnectDatabase } from "../src/db/connection";
import { reconcileS3Assets } from "../src/services/s3-reconciliation.service";

const apply = process.argv.includes("--apply");

await connectDatabase();

console.log(`🧹 S3 reconciliation (${apply ? "APPLY" : "dry run"})...`);
const result = await reconcileS3Assets(!apply);

console.log(`\nScanned: ${result.scanned}`);
console.log(`Orphaned: ${result.orphaned.length}`);
for (const key of result.orphaned) console.log(`  - ${key}`);
console.log(`Deleted: ${result.deleted.length}`);
console.log(`Skipped (too recent): ${result.skippedRecent}`);
if (result.errors.length) {
  console.log(`Errors: ${result.errors.length}`);
  for (const e of result.errors) console.log(`  - ${e.key}: ${e.error}`);
}

if (!apply && result.orphaned.length) {
  console.log(`\nRe-run with --apply to delete these ${result.orphaned.length} orphan(s).`);
}

await disconnectDatabase();
process.exit(0);
