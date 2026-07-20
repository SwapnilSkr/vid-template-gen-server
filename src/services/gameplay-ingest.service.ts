import ffmpeg from "fluent-ffmpeg";
import { spawn } from "node:child_process";
import { readdir, mkdir, copyFile, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { config } from "../config";
import { concatDemuxerEntry, ensureDir } from "../utils";
import { uploadToS3, cdnUrlFor } from "./s3.service";

// ============================================
// Gameplay ingestion — turn a raw gameplay video (any resolution, with audio)
// into clean, loopable 9:16 background segments: cropped to 1080x1920, audio
// stripped, normalised to 30fps, split into ~75s chunks. Each segment is
// uploaded to s3://<bucket>/gameplay/ (served via CloudFront) AND cached
// locally in config.gameplayDir for fast render-time looping.
//
// NOTE: source your clips from license-clear providers (Pexels/Pixabay/Mixkit/
// archive.org CC0) or footage you own. Copyrighted game footage (Subway
// Surfers, Minecraft) is NOT license-clear.
// ============================================

const W = 1080;
const H = 1920;
const FPS = 30;
const SEGMENT_SECONDS = 75;

export interface IngestedClip {
  key: string; // s3 key, e.g. gameplay/parkour_000.mp4
  url: string; // CloudFront (or S3) delivery URL
  localPath: string; // cached copy for render-time looping
}

/**
 * Process one raw source video into clean 9:16 no-audio loop segments,
 * upload each to S3/gameplay, and cache locally.
 */
export async function ingestGameplaySource(sourcePath: string, nameHint?: string): Promise<IngestedClip[]> {
  await ensureDir(config.gameplayDir);
  const base = (nameHint || basename(sourcePath, extname(sourcePath))).replace(/[^a-zA-Z0-9_-]/g, "_");
  const workDir = join(config.processingPath, `gp_${base}_${Date.now()}`);
  await mkdir(workDir, { recursive: true });

  try {
    await segmentClean(sourcePath, join(workDir, `${base}_%03d.mp4`));

    const segments = (await readdir(workDir))
      .filter((f) => f.endsWith(".mp4"))
      .sort();
    if (!segments.length) throw new Error("ffmpeg produced no segments");

    const out: IngestedClip[] = [];
    for (const seg of segments) {
      const segPath = join(workDir, seg);
      const key = `gameplay/${seg}`;

      // upload to S3 (served via CloudFront)
      const buffer = await readFile(segPath);
      await uploadToS3(buffer, "gameplay", seg, "video/mp4");

      // cache locally for render-time looping
      const localPath = join(config.gameplayDir, seg);
      await copyFile(segPath, localPath);

      out.push({ key, url: cdnUrlFor(key), localPath });
      console.log(`🎮 Ingested gameplay: ${key}`);
    }
    return out;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Make one independent gameplay asset from several source videos. Sources are
 * individually normalised first, then concatenated before the final 75-second
 * segmentation. No source video or audio is retained in S3. */
export async function ingestGameplayMixSources(sourcePaths: string[], nameHint: string): Promise<IngestedClip[]> {
  if (sourcePaths.length < 2) throw new Error("Choose at least two YouTube videos for a gameplay mix");
  const base = nameHint.replace(/[^a-zA-Z0-9_-]/g, "_");
  const workDir = join(config.processingPath, `gp_mix_${base}_${Date.now()}`);
  await mkdir(workDir, { recursive: true });
  try {
    const normalised: string[] = [];
    for (let index = 0; index < sourcePaths.length; index++) {
      const output = join(workDir, `source_${String(index).padStart(2, "0")}.mp4`);
      await normalizeGameplaySource(sourcePaths[index], output);
      normalised.push(output);
    }
    const listPath = join(workDir, "sources.txt");
    await writeFile(listPath, normalised.map(concatDemuxerEntry).join("\n"));
    const mixedPath = join(workDir, `${base}.mp4`);
    await concatNormalisedSources(listPath, mixedPath);
    const mixedSize = await stat(mixedPath).then((file) => file.size).catch(() => 0);
    if (!mixedSize) throw new Error("Gameplay mix concatenation produced no combined video");
    // Await here: returning the promise directly would run this function's
    // finally block immediately and delete mixedPath while FFmpeg is still
    // reading it in ingestGameplaySource().
    return await ingestGameplaySource(mixedPath, base);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Ingest every video in a directory. */
export async function ingestGameplayDir(dir: string): Promise<IngestedClip[]> {
  const files = (await readdir(dir)).filter((f) => /\.(mp4|mov|webm|mkv)$/i.test(f));
  const all: IngestedClip[] = [];
  for (const f of files) all.push(...(await ingestGameplaySource(join(dir, f))));
  return all;
}

/** ffmpeg: crop to 9:16, strip audio, 30fps, split into ~75s segments. */
function segmentClean(source: string, outPattern: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(source)
      .outputOptions([
        "-an", // strip audio
        "-vf",
        `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS}`,
        "-c:v", "libx264",
        "-preset", "ultrafast", // backgrounds don't need max compression; ingest fast
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-g", String(FPS * 2), // keyframe every 2s → clean segment cuts
        "-f", "segment",
        "-segment_time", String(SEGMENT_SECONDS),
        "-reset_timestamps", "1",
      ])
      .output(outPattern)
      .on("end", () => resolve())
      .on("error", (err) => reject(new Error(`Gameplay processing failed: ${err.message}`)))
      .run();
  });
}

function normalizeGameplaySource(source: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(source)
      .outputOptions([
        "-an",
        "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS}`,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-pix_fmt", "yuv420p", "-g", String(FPS * 2),
      ])
      .output(output)
      .on("end", () => resolve())
      .on("error", (err) => reject(new Error(`Gameplay mix normalisation failed: ${err.message}`)))
      .run();
  });
}

function concatNormalisedSources(listPath: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.ffmpegPath, [
      "-y", "-f", "concat", "-safe", "0", "-i", listPath,
      "-map", "0:v:0", "-c:v", "copy", "-an", output,
    ]);
    let stderr = "";
    proc.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.on("error", (error) => reject(new Error(`Gameplay mix concatenation could not start: ${error.message}`)));
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Gameplay mix concatenation failed (ffmpeg ${code}): ${stderr.slice(-800)}`));
    });
  });
}
