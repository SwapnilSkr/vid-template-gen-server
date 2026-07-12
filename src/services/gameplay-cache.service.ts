import { readdir, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { ensureDir } from "../utils";

// Permanent ingested library clips stay in gameplayDir/. Disposable S3
// downloads live here so retention can never delete intentional assets.
export function gameplayDownloadCacheDir(): string {
  return join(config.gameplayDir, "cache");
}

export async function touchGameplayCacheFile(path: string): Promise<void> {
  const now = new Date();
  await utimes(path, now, now).catch(() => {});
}

export interface GameplayCacheCleanupResult {
  scanned: number;
  deleted: number;
  bytesBefore: number;
  bytesDeleted: number;
  bytesAfter: number;
  maxBytes: number;
  maxAgeDays: number;
  protectedRecent: number;
  dryRun: boolean;
  paths: string[];
}

const DEFAULT_MAX_GB = 5;
const DEFAULT_MAX_AGE_DAYS = 14;
const DEFAULT_PROTECT_HOURS = 2;

function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Age + size bounded LRU sweep for disposable downloads only. Recently used
 * files are protected even if the cap is temporarily exceeded, preventing a
 * hygiene run from racing an active FFmpeg render. */
export async function cleanupGameplayDownloadCache(dryRun = false): Promise<GameplayCacheCleanupResult> {
  const root = gameplayDownloadCacheDir();
  await ensureDir(root);
  const maxBytes = positiveEnv("GAMEPLAY_CACHE_MAX_GB", DEFAULT_MAX_GB) * 1024 ** 3;
  const maxAgeDays = positiveEnv("GAMEPLAY_CACHE_MAX_AGE_DAYS", DEFAULT_MAX_AGE_DAYS);
  const protectHours = positiveEnv("GAMEPLAY_CACHE_PROTECT_HOURS", DEFAULT_PROTECT_HOURS);
  const now = Date.now();
  const ageCutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  const protectCutoff = now - protectHours * 60 * 60 * 1000;
  const names = await readdir(root).catch(() => []);
  const entries = await Promise.all(names.map(async (name) => {
    const path = join(root, name);
    const info = await stat(path).catch(() => null);
    return info?.isFile()
      ? { path, name, size: info.size, usedAt: info.mtimeMs }
      : undefined;
  }));
  const present = entries.filter((file): file is { path: string; name: string; size: number; usedAt: number } => Boolean(file));
  const files = present.filter((file) => /\.(mp4|mov|webm)$/i.test(file.name));
  const abandonedParts = present.filter((file) => file.name.endsWith(".part") && file.usedAt < protectCutoff);

  const bytesBefore = present.reduce((sum, file) => sum + file.size, 0);
  const targets = new Map<string, { path: string; size: number; usedAt: number }>();
  for (const file of abandonedParts) targets.set(file.path, file);
  for (const file of files) {
    if (file.usedAt < ageCutoff && file.usedAt < protectCutoff) targets.set(file.path, file);
  }

  let retainedBytes = bytesBefore - [...targets.values()].reduce((sum, file) => sum + file.size, 0);
  if (retainedBytes > maxBytes) {
    const lru = files
      .filter((file) => !targets.has(file.path) && file.usedAt < protectCutoff)
      .sort((a, b) => a.usedAt - b.usedAt);
    for (const file of lru) {
      if (retainedBytes <= maxBytes) break;
      targets.set(file.path, file);
      retainedBytes -= file.size;
    }
  }

  let bytesDeleted = 0;
  let deleted = 0;
  if (!dryRun) {
    for (const file of targets.values()) {
      await rm(file.path, { force: true });
      bytesDeleted += file.size;
      deleted++;
    }
  }
  const plannedBytes = [...targets.values()].reduce((sum, file) => sum + file.size, 0);
  return {
    scanned: present.length,
    deleted: dryRun ? 0 : deleted,
    bytesBefore,
    bytesDeleted: dryRun ? 0 : bytesDeleted,
    bytesAfter: bytesBefore - (dryRun ? plannedBytes : bytesDeleted),
    maxBytes,
    maxAgeDays,
    protectedRecent: present.filter((file) => file.usedAt >= protectCutoff).length,
    dryRun,
    paths: [...targets.keys()],
  };
}
