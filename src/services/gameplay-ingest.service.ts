import ffmpeg from "fluent-ffmpeg";
import { readdir, mkdir, copyFile, readFile, rm } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { config } from "../config";
import { ensureDir } from "../utils";
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
export async function ingestGameplaySource(sourcePath: string): Promise<IngestedClip[]> {
  await ensureDir(config.gameplayDir);
  const base = basename(sourcePath, extname(sourcePath)).replace(/[^a-zA-Z0-9_-]/g, "_");
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
