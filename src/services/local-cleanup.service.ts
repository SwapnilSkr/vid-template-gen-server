import { readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config } from "../config";

export interface LocalCleanupResult {
  scanned: number;
  deleted: number;
  bytesDeleted: number;
  kept: number;
  dryRun: boolean;
  olderThanHours: number;
  paths: string[];
}

const DEFAULT_OLDER_THAN_HOURS = 24;

function insideProcessing(path: string): boolean {
  const root = resolve(config.processingPath);
  return resolve(path).startsWith(root);
}

async function collectOldEntries(root: string, cutoffMs: number): Promise<{ path: string; bytes: number }[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const old: { path: string; bytes: number }[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (!insideProcessing(path)) continue;
    const info = await stat(path).catch(() => null);
    if (!info || info.mtimeMs > cutoffMs) continue;
    if (entry.isDirectory()) {
      old.push({ path, bytes: 0 });
      continue;
    }
    if (entry.isFile()) old.push({ path, bytes: info.size });
  }
  return old;
}

/** Remove old local render scratch files. S3 assets are handled separately by
 *  s3-reconcile; this only touches the local processing directory. */
export async function cleanupLocalProcessing(
  dryRun = true,
  olderThanHours = DEFAULT_OLDER_THAN_HOURS
): Promise<LocalCleanupResult> {
  const cutoffMs = Date.now() - olderThanHours * 60 * 60 * 1000;
  const oldEntries = await collectOldEntries(config.processingPath, cutoffMs);
  const result: LocalCleanupResult = {
    scanned: oldEntries.length,
    deleted: 0,
    bytesDeleted: 0,
    kept: 0,
    dryRun,
    olderThanHours,
    paths: oldEntries.map((entry) => entry.path),
  };
  if (dryRun) return result;
  for (const entry of oldEntries) {
    await rm(entry.path, { recursive: true, force: true });
    result.deleted++;
    result.bytesDeleted += entry.bytes;
  }
  return result;
}

export async function cleanupLocalProcessingOnStartup(): Promise<void> {
  if (process.env.LOCAL_PROCESSING_SWEEP_ON_STARTUP === "false") return;
  const olderThanHours = Number(process.env.LOCAL_PROCESSING_SWEEP_HOURS || DEFAULT_OLDER_THAN_HOURS);
  const result = await cleanupLocalProcessing(false, olderThanHours);
  if (result.deleted > 0) {
    console.log(
      `🧹 Local processing cleanup: deleted ${result.deleted} old entries (${Math.round(result.bytesDeleted / 1024 / 1024)} MB)`
    );
  }
}
