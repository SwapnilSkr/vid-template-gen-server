import { readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config } from "../config";
import { Reel } from "../models";

// ============================================
// Local processing hygiene. Two very different kinds of content live under
// storage/processing/:
//
//  1. Render scratch — loose ffmpeg/OpenRouter temp files. Callers clean these
//     on success AND failure; anything left behind means a crash, so an age
//     sweep is correct.
//  2. Staged drafts — edit-drafts/<reelId>/<draftId>/ and
//     thumb-drafts/<reelId>/<draftId>/. These are DELIBERATELY long-lived
//     (a draft persists until saved/discarded), so age alone must never
//     delete them. They are reconciled against Mongo instead: a draft dir is
//     garbage only if no reel document references its draftId.
// ============================================

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
const DRAFT_ROOTS = ["edit-drafts", "thumb-drafts"] as const;
// Never reap a draft dir younger than this — it may be mid-stage, its doc
// save still in flight.
const DRAFT_ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

function insideProcessing(path: string): boolean {
  const root = resolve(config.processingPath);
  return resolve(path).startsWith(root);
}

async function treeSize(path: string): Promise<number> {
  const info = await stat(path).catch(() => null);
  if (!info) return 0;
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return 0;
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) total += await treeSize(join(path, entry.name));
  return total;
}

/** Loose render-scratch files/dirs at the top of processing/ (drafts excluded). */
async function collectOldScratch(cutoffMs: number): Promise<{ path: string; bytes: number }[]> {
  const root = config.processingPath;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const old: { path: string; bytes: number }[] = [];
  for (const entry of entries) {
    if ((DRAFT_ROOTS as readonly string[]).includes(entry.name)) continue;
    const path = join(root, entry.name);
    if (!insideProcessing(path)) continue;
    const info = await stat(path).catch(() => null);
    if (!info || info.mtimeMs > cutoffMs) continue;
    old.push({ path, bytes: await treeSize(path) });
  }
  return old;
}

/** Draft dirs whose draftId no reel references (crashed stage, doc deleted
 *  out-of-band), plus empty <reelId> parents left after normal cleanup. */
async function collectOrphanedDraftDirs(): Promise<{ path: string; bytes: number }[]> {
  const liveDraftIds = new Set<string>();
  const reels = await Reel.find(
    { $or: [{ "editDraft.id": { $exists: true } }, { "thumbnailDraft.id": { $exists: true } }] },
    { "editDraft.id": 1, "thumbnailDraft.id": 1 }
  );
  for (const reel of reels) {
    if (reel.editDraft?.id) liveDraftIds.add(reel.editDraft.id);
    if (reel.thumbnailDraft?.id) liveDraftIds.add(reel.thumbnailDraft.id);
  }

  const cutoffMs = Date.now() - DRAFT_ORPHAN_MIN_AGE_MS;
  const orphans: { path: string; bytes: number }[] = [];

  for (const rootName of DRAFT_ROOTS) {
    const root = join(config.processingPath, rootName);
    const reelDirs = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const reelDir of reelDirs) {
      if (!reelDir.isDirectory()) continue;
      const reelPath = join(root, reelDir.name);
      const draftDirs = await readdir(reelPath, { withFileTypes: true }).catch(() => []);
      let liveChildren = 0;
      for (const draftDir of draftDirs) {
        const draftPath = join(reelPath, draftDir.name);
        if (draftDir.isDirectory() && liveDraftIds.has(draftDir.name)) {
          liveChildren++;
          continue;
        }
        const info = await stat(draftPath).catch(() => null);
        if (!info || info.mtimeMs > cutoffMs) {
          liveChildren++; // too fresh to judge — keep this pass
          continue;
        }
        orphans.push({ path: draftPath, bytes: await treeSize(draftPath) });
      }
      // Empty (or fully-orphaned) reelId parent — reap the shell too.
      if (draftDirs.length === 0 || liveChildren === 0) {
        const info = await stat(reelPath).catch(() => null);
        if (info && info.mtimeMs <= cutoffMs && draftDirs.length === 0) {
          orphans.push({ path: reelPath, bytes: 0 });
        }
      }
    }
  }

  return orphans;
}

/** Remove crashed render scratch (by age) and unreferenced draft dirs (by
 *  Mongo reconciliation). Live staged drafts are never touched, regardless of
 *  age — they persist until saved or discarded. */
export async function cleanupLocalProcessing(
  dryRun = true,
  olderThanHours = DEFAULT_OLDER_THAN_HOURS
): Promise<LocalCleanupResult> {
  const cutoffMs = Date.now() - olderThanHours * 60 * 60 * 1000;
  const scratch = await collectOldScratch(cutoffMs);
  const draftOrphans = await collectOrphanedDraftDirs();
  const targets = [...scratch, ...draftOrphans];

  const result: LocalCleanupResult = {
    scanned: targets.length,
    deleted: 0,
    bytesDeleted: 0,
    kept: 0,
    dryRun,
    olderThanHours,
    paths: targets.map((entry) => entry.path),
  };
  if (dryRun) return result;
  for (const entry of targets) {
    if (!insideProcessing(entry.path)) continue;
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
