import { copyFile, readFile, rename, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { config } from "../config";
import { Reel } from "../models";
import { gameplayDownloadCacheDir } from "./gameplay-cache.service";
import { cdnUrlFor, copyKey, deleteKey, downloadFromUrl, keyExists, listKeysWithMeta, uploadToS3 } from "./s3.service";
import { changeVideoSpeed, getVideoMetadata, trimVideo } from "./ffmpeg.service";
import { ensureDir } from "../utils";

const VIDEO_EXT = /\.(mp4|mov|webm)$/i;

/** Allowed library / import playback rates for muted gameplay backgrounds. */
export const GAMEPLAY_SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2] as const;
export type GameplaySpeedOption = (typeof GAMEPLAY_SPEED_OPTIONS)[number];

export function assertGameplaySpeed(speed: number): GameplaySpeedOption {
  const match = GAMEPLAY_SPEED_OPTIONS.find((option) => Math.abs(option - speed) < 1e-9);
  if (!match) {
    throw new Error(`Gameplay speed must be one of: ${GAMEPLAY_SPEED_OPTIONS.join("x, ")}x`);
  }
  return match;
}

function speedFilenameToken(speed: number): string {
  return String(speed).replace(".", "p");
}

export interface GameplayLibraryClip {
  key: string;
  url: string;
  filename: string;
  sizeBytes?: number;
  lastModified?: Date;
  reelReferenceCount: number;
}

function assertGameplayKey(key: string): void {
  if (!key.startsWith("gameplay/") || key.includes("..") || !VIDEO_EXT.test(key)) {
    throw new Error("That is not a valid gameplay-library video key");
  }
}

function safeFilename(name: string, previousKey: string): string {
  const stem = name
    .trim()
    .replace(/\.(mp4|mov|webm)$/i, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  if (!stem) throw new Error("Choose a name using letters, numbers, hyphens, or underscores");
  return `${stem}${extname(previousKey).toLowerCase() || ".mp4"}`;
}

async function referenceCount(key: string): Promise<number> {
  return Reel.countDocuments({ gameplayKey: key });
}

/** The shared source of truth for picker and library-management UIs. */
export async function listGameplayLibraryWithMeta(): Promise<GameplayLibraryClip[]> {
  const objects = (await listKeysWithMeta("gameplay/"))
    .filter((object) => VIDEO_EXT.test(object.key))
    .sort((a, b) => (b.lastModified?.getTime() ?? 0) - (a.lastModified?.getTime() ?? 0));
  const references = await Promise.all(objects.map((object) => referenceCount(object.key)));
  return objects.map((object, index) => ({
    key: object.key,
    url: cdnUrlFor(object.key),
    filename: basename(object.key),
    sizeBytes: object.sizeBytes,
    lastModified: object.lastModified,
    reelReferenceCount: references[index],
  }));
}

/** Delete an unused library source. We intentionally block a deletion that
 * would make an already-created reel impossible to rerender. */
export async function deleteGameplayLibraryClip(
  key: string,
  force = false,
): Promise<{ key: string; affectedReelIds: string[] }> {
  assertGameplayKey(key);
  const affected = await Reel.find({ gameplayKey: key }).select("_id").lean();
  if (affected.length > 0 && !force) {
    throw new Error(`This gameplay clip is used by ${affected.length} reel${affected.length === 1 ? "" : "s"}. Confirm force deletion to remove it anyway.`);
  }
  await deleteKey(key);
  const file = basename(key);
  await Promise.all([
    rm(join(config.gameplayDir, file), { force: true }),
    rm(join(gameplayDownloadCacheDir(), file), { force: true }),
  ]);
  if (affected.length) {
    await Reel.updateMany(
      { _id: { $in: affected.map((reel) => reel._id) } },
      { $set: { gameplayAssetMissing: true } },
    );
  }
  return { key, affectedReelIds: affected.map((reel) => reel._id.toString()) };
}

/** Rename one unused clip atomically enough for S3: copy first, remove source
 * second, then keep both local render caches in step. */
export async function renameGameplayLibraryClip(key: string, name: string): Promise<GameplayLibraryClip> {
  assertGameplayKey(key);
  const references = await referenceCount(key);
  if (references > 0) {
    throw new Error(`This gameplay clip is used by ${references} reel${references === 1 ? "" : "s"}. Rename it only after changing those reels.`);
  }
  const targetKey = `gameplay/${safeFilename(name, key)}`;
  if (targetKey === key) {
    const clip = (await listGameplayLibraryWithMeta()).find((candidate) => candidate.key === key);
    if (!clip) throw new Error("Gameplay clip no longer exists");
    return clip;
  }
  if (await keyExists(targetKey)) throw new Error("A gameplay clip already has that name");

  await copyKey(key, targetKey);
  await deleteKey(key);

  const oldFile = basename(key);
  const newFile = basename(targetKey);
  await Promise.all([
    rename(join(config.gameplayDir, oldFile), join(config.gameplayDir, newFile)).catch(() => {}),
    rename(join(gameplayDownloadCacheDir(), oldFile), join(gameplayDownloadCacheDir(), newFile)).catch(() => {}),
  ]);

  const listed = await listGameplayLibraryWithMeta();
  const renamed = listed.find((clip) => clip.key === targetKey);
  if (!renamed) throw new Error("S3 did not return the renamed gameplay clip");
  return renamed;
}

/** Trim an existing reusable gameplay asset, update every reel that selected
 * it, then reclaim the source clip. Finished reel outputs are unaffected. */
export async function trimGameplayLibraryClip(
  key: string,
  startSec: number,
  endSec: number,
): Promise<GameplayLibraryClip> {
  assertGameplayKey(key);
  if (endSec <= startSec) throw new Error("Gameplay out must be later than gameplay in");
  const workDir = join(config.processingPath, `gameplay_trim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const sourcePath = join(workDir, "source.mp4");
  const trimmedPath = join(workDir, "trimmed.mp4");
  let targetKey: string | undefined;
  let committed = false;
  try {
    await ensureDir(workDir);
    await Bun.write(sourcePath, await downloadFromUrl(cdnUrlFor(key)));
    const metadata = await getVideoMetadata(sourcePath);
    const duration = Number(metadata.duration);
    if (!Number.isFinite(duration) || startSec >= duration) throw new Error("Gameplay in is outside this clip");
    const effectiveEnd = Math.min(endSec, duration);
    if (effectiveEnd <= startSec) throw new Error("Gameplay out must be later than gameplay in");
    await trimVideo(sourcePath, { trimStart: startSec, keepDuration: effectiveEnd - startSec, removeAudio: true }, trimmedPath);

    const stem = basename(key, extname(key)).replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = `${stem}_trim_${Date.now()}.mp4`;
    targetKey = `gameplay/${filename}`;
    await uploadToS3(await readFile(trimmedPath), "gameplay", filename, "video/mp4");
    await ensureDir(config.gameplayDir);
    await copyFile(trimmedPath, join(config.gameplayDir, filename));

    await Reel.updateMany({ gameplayKey: key }, { $set: { gameplayKey: targetKey, gameplayAssetMissing: false } });
    committed = true;
    await deleteKey(key);
    const oldFile = basename(key);
    await Promise.all([
      rm(join(config.gameplayDir, oldFile), { force: true }),
      rm(join(gameplayDownloadCacheDir(), oldFile), { force: true }),
    ]);
    const trimmed = (await listGameplayLibraryWithMeta()).find((clip) => clip.key === targetKey);
    if (!trimmed) throw new Error("Trim succeeded but the new gameplay clip was not found in S3");
    return trimmed;
  } catch (error) {
    if (targetKey && !committed) await deleteKey(targetKey).catch(() => {});
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Re-time a library clip (e.g. 0.25x / 2x), retarget every reel that selected
 * it, then delete the previous S3 object + local/cache copies. */
export async function speedGameplayLibraryClip(
  key: string,
  speedInput: number,
): Promise<GameplayLibraryClip> {
  assertGameplayKey(key);
  const speed = assertGameplaySpeed(speedInput);
  if (speed === 1) {
    const clip = (await listGameplayLibraryWithMeta()).find((candidate) => candidate.key === key);
    if (!clip) throw new Error("Gameplay clip no longer exists");
    return clip;
  }

  const workDir = join(
    config.processingPath,
    `gameplay_speed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  );
  const sourcePath = join(workDir, "source.mp4");
  const spedPath = join(workDir, "sped.mp4");
  let targetKey: string | undefined;
  let committed = false;
  try {
    await ensureDir(workDir);
    await Bun.write(sourcePath, await downloadFromUrl(cdnUrlFor(key)));
    await changeVideoSpeed(sourcePath, speed, spedPath, { removeAudio: true, fps: 30 });

    const stem = basename(key, extname(key))
      .replace(/_(\d+p?\d*)x(_\d+)?$/i, "")
      .replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = `${stem}_${speedFilenameToken(speed)}x_${Date.now()}.mp4`;
    targetKey = `gameplay/${filename}`;
    await uploadToS3(await readFile(spedPath), "gameplay", filename, "video/mp4");
    await ensureDir(config.gameplayDir);
    await copyFile(spedPath, join(config.gameplayDir, filename));

    await Reel.updateMany(
      { gameplayKey: key },
      { $set: { gameplayKey: targetKey, gameplayAssetMissing: false } }
    );
    committed = true;
    await deleteKey(key);
    const oldFile = basename(key);
    await Promise.all([
      rm(join(config.gameplayDir, oldFile), { force: true }),
      rm(join(gameplayDownloadCacheDir(), oldFile), { force: true }),
    ]);

    const sped = (await listGameplayLibraryWithMeta()).find((clip) => clip.key === targetKey);
    if (!sped) throw new Error("Speed change succeeded but the new gameplay clip was not found in S3");
    return sped;
  } catch (error) {
    if (targetKey && !committed) await deleteKey(targetKey).catch(() => {});
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
