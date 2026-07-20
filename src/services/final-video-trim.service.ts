import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { Reel, type IReel } from "../models";
import { concatDemuxerEntry, ensureDir } from "../utils";
import { getVideoMetadata, trimVideo } from "./ffmpeg.service";
import { deleteS3Urls, downloadFromUrl, uploadVideo } from "./s3.service";

export interface FinalVideoRemoveRange {
  startSec: number;
  endSec: number;
}

function normalizeRemovedRanges(
  ranges: FinalVideoRemoveRange[],
  duration: number,
): FinalVideoRemoveRange[] {
  const sorted = ranges
    .map((range) => ({
      startSec: Math.max(0, range.startSec),
      endSec: Math.min(duration, range.endSec),
    }))
    .filter((range) => Number.isFinite(range.startSec) && Number.isFinite(range.endSec) && range.endSec > range.startSec)
    .sort((a, b) => a.startSec - b.startSec);
  if (!sorted.length) throw new Error("Choose at least one valid range to remove");

  const merged: FinalVideoRemoveRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.startSec <= previous.endSec) previous.endSec = Math.max(previous.endSec, range.endSec);
    else merged.push(range);
  }
  if (merged[0]?.startSec === 0 && merged[0]?.endSec >= duration) {
    throw new Error("The cuts would remove the entire video");
  }
  return merged;
}

function keptRanges(removed: FinalVideoRemoveRange[], duration: number): FinalVideoRemoveRange[] {
  const kept: FinalVideoRemoveRange[] = [];
  let cursor = 0;
  for (const cut of removed) {
    if (cut.startSec > cursor) kept.push({ startSec: cursor, endSec: cut.startSec });
    cursor = Math.max(cursor, cut.endSec);
  }
  if (cursor < duration) kept.push({ startSec: cursor, endSec: duration });
  return kept.filter((range) => range.endSec - range.startSec >= 0.04);
}

function concatVideoFiles(listPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpegPath, [
      "-y", "-f", "concat", "-safe", "0", "-i", listPath,
      "-map", "0:v:0", "-map", "0:a?", "-c", "copy", "-movflags", "+faststart", outputPath,
    ]);
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => reject(new Error(`Could not start final-video editor: ${error.message}`)));
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`Final-video concat failed (ffmpeg ${code}): ${stderr.slice(-800)}`)));
  });
}

/** Apply arbitrary cut-out ranges to the primary finished render. It never
 * alters raw story/narration caches or existing social posts. The old finished
 * S3 object is deleted only after the replacement is uploaded and Mongo points
 * at it, so an interrupted edit cannot strand the Studio without a video. */
export async function trimFinishedReelVideo(
  reelId: string,
  requestedRanges: FinalVideoRemoveRange[],
): Promise<IReel> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  if (reel.status !== "completed" || !reel.outputUrl) throw new Error("Finish the reel before trimming its video");

  const oldOutputUrl = reel.outputUrl;
  const workDir = join(config.processingPath, `final_trim_${reelId}_${randomUUID().slice(0, 8)}`);
  const sourcePath = join(workDir, "source.mp4");
  const finalPath = join(workDir, "edited.mp4");
  let replacementUrl: string | undefined;
  let committed = false;
  try {
    await ensureDir(config.processingPath);
    await mkdir(workDir, { recursive: true });
    await writeFile(sourcePath, await downloadFromUrl(oldOutputUrl));
    const metadata = await getVideoMetadata(sourcePath);
    const duration = Number(metadata.duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("Could not read the finished video's duration");
    const removedRanges = normalizeRemovedRanges(requestedRanges, duration);
    const keep = keptRanges(removedRanges, duration);
    if (!keep.length) throw new Error("The cuts would leave no playable video");

    const segmentPaths: string[] = [];
    for (let index = 0; index < keep.length; index++) {
      const segmentPath = join(workDir, `keep_${String(index).padStart(2, "0")}.mp4`);
      await trimVideo(sourcePath, {
        trimStart: keep[index].startSec,
        keepDuration: keep[index].endSec - keep[index].startSec,
      }, segmentPath);
      segmentPaths.push(segmentPath);
    }
    if (segmentPaths.length === 1) {
      await copyFile(segmentPaths[0], finalPath);
    } else {
      const listPath = join(workDir, "kept-segments.txt");
      await writeFile(listPath, segmentPaths.map(concatDemuxerEntry).join("\n"));
      await concatVideoFiles(listPath, finalPath);
    }

    replacementUrl = await uploadVideo(await readFile(finalPath), "reels", `${reelId}_trimmed.mp4`);
    reel.outputUrl = replacementUrl;
    reel.finalVideoTrim = { sourceOutputUrl: oldOutputUrl, removedRanges, appliedAt: new Date() };
    await reel.save();
    committed = true;
    await deleteS3Urls([oldOutputUrl]);
    return reel;
  } catch (error) {
    // Upload can succeed just before Mongo does not. Reclaim that unreferenced
    // replacement instead of accumulating orphan MP4s on retry.
    if (replacementUrl && !committed) await deleteS3Urls([replacementUrl]);
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
