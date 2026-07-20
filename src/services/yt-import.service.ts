import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import ffmpeg from "fluent-ffmpeg";
import { config } from "../config";
import { YtImport, type IGameplayMixSource, type IYtImport, type IYtImportCaptionCue } from "../models";
import { changeVideoSpeed, getVideoMetadata, trimVideo } from "./ffmpeg.service";
import { getYoutubeVideoMetadata } from "./youtube-search.service";
import { ingestGameplayMixSources, ingestGameplaySource } from "./gameplay-ingest.service";
import { assertGameplaySpeed } from "./gameplay-library.service";
import {
  cdnUrlFor,
  deleteKey,
  listKeys,
  uploadFileAtKey,
} from "./s3.service";
import { cleanupFiles, ensureDir, fileExists } from "../utils";

const YT_DLP_BIN = resolve(import.meta.dir, "../../bin/yt-dlp");
const YT_IMPORTS_DIR = join(config.storagePath, "yt-imports");
const S3_ROOT = "yt-imports";

if (config.ffmpegPath) ffmpeg.setFfmpegPath(config.ffmpegPath);
if (config.ffprobePath) ffmpeg.setFfprobePath(config.ffprobePath);

export interface CreateYtImportInput {
  videoId: string;
  storage: "local" | "s3";
  downloadCaptions?: boolean;
  extractFrames?: boolean;
  frameRangeStartSec?: number;
  frameRangeEndSec?: number;
  asGameplay?: boolean;
  sourceTrimStartSec?: number;
  sourceTrimEndSec?: number;
  gameplaySpeed?: number;
}

export interface CreateGameplayMixInput {
  sources: IGameplayMixSource[];
  title?: string;
}

export interface FrameExtractRange {
  startSec: number;
  endSec: number;
}

/** Normalize and validate a frame extraction window against video duration. */
export function normalizeFrameRange(
  startSec: number | undefined,
  endSec: number | undefined,
  durationSec?: number
): FrameExtractRange {
  const start = Math.max(0, startSec ?? 0);
  const maxEnd = durationSec && durationSec > 0 ? durationSec : undefined;
  let end = endSec ?? maxEnd ?? start + 1;
  if (maxEnd != null) end = Math.min(end, maxEnd);
  if (end <= start) end = maxEnd != null ? Math.min(start + 0.04, maxEnd) : start + 1;
  if (end <= start) {
    throw new Error("Frame range end must be after start");
  }
  return { startSec: start, endSec: end };
}

function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function buildAssetId(videoId: string, title: string): string {
  const slug = slugifyTitle(title) || "video";
  return `${videoId}_${slug}`;
}

function assetPaths(assetId: string) {
  const baseKey = `${S3_ROOT}/${assetId}`;
  return {
    localDir: join(YT_IMPORTS_DIR, assetId),
    s3Prefix: `${baseKey}/`,
    videoFile: "video.mp4",
    audioFile: "audio.m4a",
    captionsFile: "captions.en.vtt",
    framesDir: "frames",
    framePattern: "frame_%06d.jpg",
  };
}

export function frameFileName(frameIndex: number): string {
  return `frame_${String(frameIndex).padStart(6, "0")}.jpg`;
}

/** Resolve S3 prefix even when not stored on older docs (API strips it from responses). */
export function s3PrefixFor(doc: Pick<IYtImport, "assetId" | "s3Prefix">): string {
  return doc.s3Prefix ?? `${S3_ROOT}/${doc.assetId}/`;
}

/** Resolve local asset directory for listing/deletion. */
export function localDirFor(doc: Pick<IYtImport, "assetId" | "localDir">): string {
  return doc.localDir ?? join(YT_IMPORTS_DIR, doc.assetId);
}

export interface YtImportFrameDelivery {
  mode: "api" | "cdn";
  /** CDN base through `frames/` — append frame_000001.jpg. Only set for S3. */
  cdnFramesPrefix?: string;
}

export interface YtImportDetailPayload {
  frameIndices: number[];
  frameIndicesTotal: number;
  frameDelivery: YtImportFrameDelivery;
  framesExtracted: boolean;
  frameCount: number;
}

function runCommand(bin: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(bin, args);
    let stderr = "";
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${bin} exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

async function downloadVideo(videoId: string, outPath: string, videoOnly = false): Promise<void> {
  await ensureDir(join(outPath, ".."));
  await runCommand(YT_DLP_BIN, [
    "-f",
    videoOnly
      ? "bv*[height<=1080][ext=mp4]/bv*[height<=1080]/b[height<=1080][ext=mp4]/b"
      : "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b",
    "--merge-output-format",
    "mp4",
    "-o",
    outPath,
    "--no-playlist",
    `https://www.youtube.com/watch?v=${videoId}`,
  ]);
}

async function downloadCaptionsFile(videoId: string, outDir: string): Promise<string | undefined> {
  await ensureDir(outDir);
  try {
    await runCommand(YT_DLP_BIN, [
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs",
      "en.*,en",
      "--convert-subs",
      "vtt",
      "--skip-download",
      "-o",
      join(outDir, "captions"),
      "--no-playlist",
      `https://www.youtube.com/watch?v=${videoId}`,
    ]);
  } catch {
    return undefined;
  }

  const files = await readdir(outDir);
  const vtt = files.find((f) => f.endsWith(".vtt"));
  if (!vtt) return undefined;

  const src = join(outDir, vtt);
  const dest = join(outDir, assetPaths("x").captionsFile);
  if (src !== dest) {
    const content = await readFile(src, "utf-8");
    await Bun.write(dest, content);
    if (vtt !== assetPaths("x").captionsFile) await rm(src, { force: true });
  }
  return dest;
}

export function parseVtt(content: string): IYtImportCaptionCue[] {
  const cues: IYtImportCaptionCue[] = [];
  const blocks = content.replace(/\r\n/g, "\n").split("\n\n");
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 2) continue;
    const timingLine = lines.find((l) => l.includes("-->"));
    if (!timingLine) continue;
    const [startRaw, endRaw] = timingLine.split("-->").map((s) => s.trim());
    const startSec = vttTimestampToSec(startRaw);
    const endSec = vttTimestampToSec(endRaw.split(" ")[0]);
    const text = lines
      .slice(lines.indexOf(timingLine) + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (text) cues.push({ startSec, endSec, text });
  }
  return cues;
}

function vttTimestampToSec(raw: string): number {
  const parts = raw.trim().split(":");
  if (parts.length === 3) {
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
  }
  if (parts.length === 2) {
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return parseFloat(raw) || 0;
}

async function extractAudioTrack(videoPath: string, audioPath: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    ffmpeg(videoPath)
      .noVideo()
      .audioCodec("copy")
      .output(audioPath)
      .on("end", () => resolvePromise())
      .on("error", (err) => reject(new Error(`Audio extract failed: ${err.message}`)))
      .run();
  });
}

async function extractFramesInRange(
  videoPath: string,
  framesDir: string,
  range: FrameExtractRange,
  onProgress?: (pct: number) => void
): Promise<{ frameCount: number; fps: number }> {
  await ensureDir(framesDir);
  const meta = await getVideoMetadata(videoPath);
  const fps = meta.frameRate || 30;
  const duration = meta.duration ?? range.endSec;
  const normalized = normalizeFrameRange(range.startSec, range.endSec, duration);
  const clipDuration = normalized.endSec - normalized.startSec;
  const startFrameIndex = Math.round(normalized.startSec * fps);

  await new Promise<void>((resolvePromise, reject) => {
    ffmpeg(videoPath)
      .setStartTime(normalized.startSec)
      .setDuration(clipDuration)
      .outputOptions(["-vsync", "0", "-q:v", "2", "-start_number", String(startFrameIndex)])
      .output(join(framesDir, assetPaths("x").framePattern))
      .on("progress", (p) => {
        if (p.percent != null && onProgress) onProgress(Math.min(99, p.percent));
      })
      .on("end", () => resolvePromise())
      .on("error", (err) => reject(new Error(`Frame extraction failed: ${err.message}`)))
      .run();
  });

  const files = (await readdir(framesDir)).filter((f) => f.endsWith(".jpg"));
  return { frameCount: files.length, fps };
}

async function clearExistingFrames(doc: IYtImport): Promise<void> {
  const paths = assetPaths(doc.assetId);
  if (doc.storage === "local" && doc.localDir) {
    await rm(join(doc.localDir, paths.framesDir), { recursive: true, force: true }).catch(() => {});
  }
  if (doc.storage === "local" && !doc.localDir) {
    await rm(join(localDirFor(doc), paths.framesDir), { recursive: true, force: true }).catch(() => {});
  }
  if (doc.storage === "s3" && doc.s3Prefix) {
    const keys = await listKeys(`${doc.s3Prefix}${paths.framesDir}/`);
    await Promise.all(keys.map((key) => deleteKey(key)));
  }
  if (doc.storage === "s3" && !doc.s3Prefix) {
    const keys = await listKeys(`${s3PrefixFor(doc)}${paths.framesDir}/`);
    await Promise.all(keys.map((key) => deleteKey(key)));
  }
}

async function updateImport(
  id: string,
  patch: Partial<IYtImport> & { progress?: number }
): Promise<void> {
  // Mongoose omits `undefined` fields in ordinary updates. Treat an explicit
  // `error: undefined` as an instruction to clear an error left by a retry.
  if (Object.prototype.hasOwnProperty.call(patch, "error") && patch.error === undefined) {
    const { error: _error, ...set } = patch;
    await YtImport.findByIdAndUpdate(id, { $set: set, $unset: { error: 1 } });
    return;
  }
  await YtImport.findByIdAndUpdate(id, patch);
}

export async function createYtImport(input: CreateYtImportInput): Promise<IYtImport> {
  const meta = await getYoutubeVideoMetadata(input.videoId);
  const asGameplay = input.asGameplay === true;
  if (asGameplay && input.sourceTrimEndSec != null && input.sourceTrimEndSec <= (input.sourceTrimStartSec ?? 0)) {
    throw new Error("Gameplay clip end must be after its start");
  }
  const gameplaySpeed = asGameplay
    ? assertGameplaySpeed(input.gameplaySpeed ?? 1)
    : undefined;
  // Keep reference and gameplay imports separate: one video can be used for
  // frame/caption research and also become a disposable gameplay source.
  const trimIdentity = asGameplay && (input.sourceTrimStartSec || input.sourceTrimEndSec != null)
    ? `_clip_${Math.round((input.sourceTrimStartSec ?? 0) * 10)}_${input.sourceTrimEndSec == null ? "end" : Math.round(input.sourceTrimEndSec * 10)}`
    : "";
  const speedIdentity =
    asGameplay && gameplaySpeed && gameplaySpeed !== 1
      ? `_spd_${String(gameplaySpeed).replace(".", "p")}`
      : "";
  const assetId = `${buildAssetId(meta.videoId, meta.title)}${asGameplay ? `_gameplay${trimIdentity}${speedIdentity}` : ""}`;

  const existing = await YtImport.findOne({ assetId });
  if (existing && existing.status !== "failed") {
    return existing;
  }

  const paths = assetPaths(assetId);
  const frameRange =
    input.extractFrames && (input.frameRangeStartSec != null || input.frameRangeEndSec != null)
      ? normalizeFrameRange(
          input.frameRangeStartSec,
          input.frameRangeEndSec,
          meta.durationSec
        )
      : undefined;

  const doc = await YtImport.findOneAndUpdate(
    { assetId },
    {
      assetId,
      youtubeVideoId: meta.videoId,
      sourceUrl: `https://www.youtube.com/watch?v=${meta.videoId}`,
      title: meta.title,
      channelTitle: meta.channelTitle,
      thumbnailUrl: meta.thumbnailUrl,
      durationSec: meta.durationSec,
      storage: input.storage,
      purpose: asGameplay ? "gameplay" : "reference",
      // Gameplay is an opaque background; captions, frames and source audio
      // are needless storage and processing.
      downloadCaptions: asGameplay ? false : input.downloadCaptions ?? true,
      extractFrames: asGameplay ? false : input.extractFrames ?? false,
      frameRangeStartSec: input.extractFrames ? frameRange?.startSec ?? 0 : undefined,
      frameRangeEndSec: input.extractFrames
        ? frameRange?.endSec ?? meta.durationSec
        : undefined,
      status: "pending",
      progress: 0,
      error: undefined,
      localDir: input.storage === "local" ? paths.localDir : undefined,
      s3Prefix: input.storage === "s3" ? paths.s3Prefix : undefined,
      frameCount: 0,
      framesExtracted: false,
      gameplayClipKeys: asGameplay ? [] : undefined,
      sourceTrimStartSec: asGameplay && input.sourceTrimStartSec && input.sourceTrimStartSec > 0 ? input.sourceTrimStartSec : undefined,
      sourceTrimEndSec: asGameplay ? input.sourceTrimEndSec : undefined,
      gameplaySpeed: asGameplay ? gameplaySpeed : undefined,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return doc!;
}

/** Queue a gameplay-only mix. Source videos are downloaded into a temporary
 * processing folder, normalised/muted/concatenated, then discarded. */
export async function createGameplayMix(input: CreateGameplayMixInput): Promise<IYtImport> {
  const sources: IGameplayMixSource[] = input.sources.map((source) => ({
    videoId: source.videoId.trim(),
    startSec: source.startSec && source.startSec > 0 ? source.startSec : undefined,
    endSec: source.endSec,
  }));
  if (sources.length < 2) throw new Error("Choose at least two YouTube videos for a gameplay mix");
  if (sources.length > 8) throw new Error("A gameplay mix can contain at most eight YouTube videos");
  for (const source of sources) {
    if (!source.videoId) throw new Error("Every gameplay mix source needs a YouTube video id");
    if (source.endSec != null && source.endSec <= (source.startSec ?? 0)) {
      throw new Error("Each gameplay clip's end must be after its start");
    }
  }
  const videoIds = sources.map((source) => source.videoId);
  const assetId = `gameplay_mix_${randomUUID().replace(/-/g, "").slice(0, 14)}`;
  const title = input.title?.trim() || `Gameplay mix · ${videoIds.length} YouTube videos`;
  const doc = await YtImport.create({
    assetId,
    youtubeVideoId: videoIds[0],
    sourceVideoIds: videoIds,
    gameplayMixSources: sources,
    sourceUrl: `https://www.youtube.com/watch?v=${videoIds[0]}`,
    title,
    channelTitle: "YouTube gameplay mix",
    storage: "s3",
    purpose: "gameplay_mix",
    downloadCaptions: false,
    extractFrames: false,
    status: "pending",
    progress: 0,
    frameCount: 0,
    framesExtracted: false,
    gameplayClipKeys: [],
  });
  return doc;
}

export async function processYtImport(importId: string): Promise<void> {
  const doc = await YtImport.findById(importId);
  if (!doc) throw new Error(`YtImport not found: ${importId}`);

  const paths = assetPaths(doc.assetId);
  const workDir =
    doc.storage === "local" ? paths.localDir : join(config.processingPath, `yt_${doc.assetId}`);

  try {
    await updateImport(importId, { status: "downloading", progress: 5, error: undefined });
    await ensureDir(workDir);

    if (doc.purpose === "gameplay_mix") {
      const sources: IGameplayMixSource[] = doc.gameplayMixSources?.length
        ? doc.gameplayMixSources
        : (doc.sourceVideoIds?.length ? doc.sourceVideoIds : [doc.youtubeVideoId]).map((videoId) => ({ videoId }));
      if (sources.length < 2) throw new Error("Gameplay mix has fewer than two source videos");
      const sourcePaths: string[] = [];
      for (let index = 0; index < sources.length; index++) {
        const source = sources[index]!;
        const sourcePath = join(workDir, `source_${String(index).padStart(2, "0")}.mp4`);
        await downloadVideo(source.videoId, sourcePath, true);
        if (source.startSec || source.endSec != null) {
          const clippedPath = join(workDir, `source_${String(index).padStart(2, "0")}_trimmed.mp4`);
          await trimVideo(sourcePath, {
            trimStart: source.startSec ?? 0,
            keepDuration: source.endSec != null
              ? source.endSec - (source.startSec ?? 0)
              : undefined,
          }, clippedPath);
          await rm(sourcePath, { force: true });
          sourcePaths.push(clippedPath);
        } else {
          sourcePaths.push(sourcePath);
        }
        await updateImport(importId, { progress: 5 + Math.round(((index + 1) / sources.length) * 40) });
      }
      await updateImport(importId, { status: "uploading", progress: 50 });
      const clips = await ingestGameplayMixSources(sourcePaths, doc.assetId);
      await rm(workDir, { recursive: true, force: true });
      await updateImport(importId, {
        status: "completed", progress: 100, gameplayClipKeys: clips.map((clip) => clip.key),
        localDir: undefined, s3Prefix: undefined,
      });
      return;
    }

    const videoPath = join(workDir, paths.videoFile);
    await downloadVideo(doc.youtubeVideoId, videoPath, doc.purpose === "gameplay");
    await updateImport(importId, { progress: 35 });

    if (doc.purpose === "gameplay") {
      const trimmedPath = (doc.sourceTrimStartSec || doc.sourceTrimEndSec != null)
        ? join(workDir, "gameplay_trimmed.mp4")
        : undefined;
      if (trimmedPath) {
        await trimVideo(videoPath, {
          trimStart: doc.sourceTrimStartSec ?? 0,
          keepDuration: doc.sourceTrimEndSec != null
            ? doc.sourceTrimEndSec - (doc.sourceTrimStartSec ?? 0)
            : undefined,
        }, trimmedPath);
        await rm(videoPath, { force: true });
      }
      let gameplaySource = trimmedPath ?? videoPath;
      const speed = doc.gameplaySpeed != null ? assertGameplaySpeed(doc.gameplaySpeed) : 1;
      if (speed !== 1) {
        const spedPath = join(workDir, "gameplay_sped.mp4");
        await changeVideoSpeed(gameplaySource, speed, spedPath, { removeAudio: true, fps: 30 });
        if (gameplaySource !== videoPath) await rm(gameplaySource, { force: true }).catch(() => {});
        gameplaySource = spedPath;
      }
      const videoMeta = await getVideoMetadata(gameplaySource);
      await updateImport(importId, { status: "uploading", progress: 45 });
      const clips = await ingestGameplaySource(gameplaySource, doc.assetId);
      // Discard the raw YT download + any intermediate trim/speed files. Only
      // the muted 9:16 segments under gameplay/ remain in S3.
      await rm(workDir, { recursive: true, force: true });
      await updateImport(importId, {
        status: "completed",
        progress: 100,
        fps: videoMeta.frameRate,
        gameplayClipKeys: clips.map((clip) => clip.key),
        localDir: undefined,
        s3Prefix: undefined,
      });
      return;
    }

    let captionsPath: string | undefined;
    let captions: IYtImportCaptionCue[] = [];
    if (doc.downloadCaptions) {
      captionsPath = await downloadCaptionsFile(doc.youtubeVideoId, workDir);
      if (captionsPath && (await fileExists(captionsPath))) {
        captions = parseVtt(await readFile(captionsPath, "utf-8"));
      }
    }
    await updateImport(importId, { progress: 50 });

    const audioPath = join(workDir, paths.audioFile);
    await extractAudioTrack(videoPath, audioPath);
    await updateImport(importId, { progress: 60 });

    const videoMeta = await getVideoMetadata(videoPath);

    if (doc.storage === "s3") {
      await updateImport(importId, { status: "uploading", progress: 65 });

      const videoKey = `${paths.s3Prefix}${paths.videoFile}`;
      const audioKey = `${paths.s3Prefix}${paths.audioFile}`;
      await uploadFileAtKey(videoPath, videoKey, "video/mp4");
      await uploadFileAtKey(audioPath, audioKey, "audio/mp4");

      let captionsUrl: string | undefined;
      if (captionsPath && (await fileExists(captionsPath))) {
        const captionsKey = `${paths.s3Prefix}${paths.captionsFile}`;
        captionsUrl = await uploadFileAtKey(captionsPath, captionsKey, "text/vtt");
      }

      await rm(workDir, { recursive: true, force: true });

      await updateImport(importId, {
        status: doc.extractFrames ? "extracting_frames" : "completed",
        progress: doc.extractFrames ? 70 : 100,
        videoUrl: cdnUrlFor(videoKey),
        audioUrl: cdnUrlFor(audioKey),
        captionsUrl,
        captions,
        fps: videoMeta.frameRate,
        localDir: undefined,
      });

      if (doc.extractFrames) {
        await extractFramesForImport(importId);
      }
      return;
    }

    let captionsUrl: string | undefined;
    if (captionsPath && (await fileExists(captionsPath))) {
      captionsUrl = `/api/yt-imports/${importId}/captions`;
    }

    await updateImport(importId, {
      status: doc.extractFrames ? "extracting_frames" : "completed",
      progress: doc.extractFrames ? 70 : 100,
      videoUrl: `/api/yt-imports/${importId}/video`,
      audioUrl: `/api/yt-imports/${importId}/audio`,
      captionsUrl,
      captions,
      fps: videoMeta.frameRate,
      localDir: workDir,
    });

    if (doc.extractFrames) {
      await extractFramesForImport(importId);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await updateImport(importId, { status: "failed", error: message });
    if (doc.storage === "s3") {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}

export async function extractFramesForImport(
  importId: string,
  rangeOverride?: FrameExtractRange
): Promise<void> {
  const doc = await YtImport.findById(importId);
  if (!doc) throw new Error(`YtImport not found: ${importId}`);

  const paths = assetPaths(doc.assetId);
  const range = normalizeFrameRange(
    rangeOverride?.startSec ?? doc.frameRangeStartSec,
    rangeOverride?.endSec ?? doc.frameRangeEndSec,
    doc.durationSec
  );

  await clearExistingFrames(doc);
  await updateImport(importId, {
    status: "extracting_frames",
    progress: 75,
    framesExtracted: false,
    frameCount: 0,
    frameRangeStartSec: range.startSec,
    frameRangeEndSec: range.endSec,
  });

  let videoPath: string;
  let framesDir: string;
  let tempDir: string | undefined;

  if (doc.storage === "local") {
    videoPath = join(localDirFor(doc), paths.videoFile);
    framesDir = join(localDirFor(doc), paths.framesDir);
  } else {
    tempDir = join(config.processingPath, `yt_frames_${doc.assetId}`);
    await ensureDir(tempDir);
    videoPath = join(tempDir, paths.videoFile);
    framesDir = join(tempDir, paths.framesDir);

    const videoKey = `${s3PrefixFor(doc)}${paths.videoFile}`;
    const res = await fetch(cdnUrlFor(videoKey));
    if (!res.ok) throw new Error("Failed to fetch video from S3 for frame extraction");
    await Bun.write(videoPath, await res.arrayBuffer());
  }

  const { frameCount: extractedCount, fps } = await extractFramesInRange(
    videoPath,
    framesDir,
    range,
    (pct) => {
      void updateImport(importId, { progress: 75 + Math.round(pct * 0.24) });
    }
  );

  let finalFrameCount = extractedCount;

  if (doc.storage === "s3") {
    const frameFiles = (await readdir(framesDir)).filter((f) => f.endsWith(".jpg")).sort();
    if (frameFiles.length === 0) {
      throw new Error("Frame extraction produced no files");
    }
    let uploaded = 0;
    for (const file of frameFiles) {
      const key = `${s3PrefixFor(doc)}${paths.framesDir}/${file}`;
      await uploadFileAtKey(join(framesDir, file), key, "image/jpeg");
      uploaded++;
      if (uploaded % 50 === 0) {
        await updateImport(importId, {
          progress: 75 + Math.round((uploaded / frameFiles.length) * 24),
        });
      }
    }
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});

    const verifyKeys = await listKeys(`${s3PrefixFor(doc)}${paths.framesDir}/`);
    if (verifyKeys.length === 0) {
      throw new Error("S3 frame upload verification failed — no objects found");
    }
    finalFrameCount = verifyKeys.length;
  } else {
    const localFrames = (await readdir(framesDir)).filter((f) => f.endsWith(".jpg"));
    if (localFrames.length === 0) {
      throw new Error("Frame extraction produced no files");
    }
    finalFrameCount = localFrames.length;
  }

  await updateImport(importId, {
    status: "completed",
    progress: 100,
    frameCount: finalFrameCount,
    fps,
    framesExtracted: true,
  });
}

export async function listYtImports(limit = 50): Promise<IYtImport[]> {
  return YtImport.find().sort({ createdAt: -1 }).limit(limit).lean();
}

export async function getYtImport(id: string): Promise<IYtImport | null> {
  return YtImport.findById(id).lean();
}

export function captionAtTime(
  captions: IYtImportCaptionCue[] | undefined,
  timestampSec: number
): IYtImportCaptionCue | undefined {
  if (!captions?.length) return undefined;
  return captions.find((c) => timestampSec >= c.startSec && timestampSec <= c.endSec);
}

export async function getLocalAssetPath(
  doc: IYtImport,
  kind: "video" | "audio" | "captions" | "frame",
  frameIndex?: number
): Promise<string | null> {
  if (doc.storage !== "local") return null;
  const paths = assetPaths(doc.assetId);
  const base = localDirFor(doc);
  switch (kind) {
    case "video":
      return join(base, paths.videoFile);
    case "audio":
      return join(base, paths.audioFile);
    case "captions":
      return join(base, paths.captionsFile);
    case "frame": {
      if (frameIndex == null) return null;
      return join(base, paths.framesDir, frameFileName(frameIndex));
    }
  }
}

export function frameUrlFor(doc: IYtImport, frameIndex: number): string {
  const id = String(doc._id);
  return frameUrlForImport(doc, id, frameIndex);
}

function frameUrlForImport(doc: IYtImport, importId: string, frameIndex: number): string {
  if (doc.storage === "local") {
    return `/api/yt-imports/${importId}/frames/${frameIndex}`;
  }
  const paths = assetPaths(doc.assetId);
  return cdnUrlFor(`${s3PrefixFor(doc)}${paths.framesDir}/${frameFileName(frameIndex)}`);
}

export async function listFrameIndices(doc: IYtImport): Promise<number[]> {
  const paths = assetPaths(doc.assetId);
  if (doc.storage === "local") {
    const dir = join(localDirFor(doc), paths.framesDir);
    try {
      const files = await readdir(dir);
      return files
        .filter((f) => f.startsWith("frame_") && f.endsWith(".jpg"))
        .map((f) => parseInt(f.replace("frame_", "").replace(".jpg", ""), 10))
        .filter((n) => !Number.isNaN(n))
        .sort((a, b) => a - b);
    } catch {
      return [];
    }
  }
  if (doc.storage === "s3") {
    const prefix = `${s3PrefixFor(doc)}${paths.framesDir}/`;
    const keys = await listKeys(prefix);
    return keys
      .map((k) => {
        const name = k.split("/").pop() ?? "";
        const match = name.match(/^frame_(\d+)\.jpg$/);
        return match ? parseInt(match[1], 10) : NaN;
      })
      .filter((n) => !Number.isNaN(n))
      .sort((a, b) => a - b);
  }
  return [];
}

export function frameDeliveryFor(doc: IYtImport): YtImportFrameDelivery {
  if (doc.storage === "s3") {
    const prefix = s3PrefixFor(doc);
    return {
      mode: "cdn",
      cdnFramesPrefix: cdnUrlFor(`${prefix}${assetPaths(doc.assetId).framesDir}/`),
    };
  }
  return { mode: "api" };
}

/** Probe storage (local or S3), reconcile Mongo flags, return frame listing for API. */
export async function resolveImportFrameAssets(
  doc: IYtImport,
  importId: string
): Promise<YtImportDetailPayload> {
  const shouldProbe =
    doc.videoUrl != null &&
    (doc.framesExtracted ||
      doc.frameCount > 0 ||
      doc.extractFrames ||
      doc.status === "extracting_frames");

  let indices: number[] = [];
  if (shouldProbe) {
    indices = await listFrameIndices(doc);
  }

  if (indices.length > 0 && (!doc.framesExtracted || doc.frameCount !== indices.length)) {
    await YtImport.findByIdAndUpdate(importId, {
      framesExtracted: true,
      frameCount: indices.length,
    });
    doc.framesExtracted = true;
    doc.frameCount = indices.length;
  }

  return {
    frameIndices: indices.slice(0, 500),
    frameIndicesTotal: indices.length,
    frameDelivery: frameDeliveryFor(doc),
    framesExtracted: doc.framesExtracted || indices.length > 0,
    frameCount: indices.length > 0 ? indices.length : doc.frameCount,
  };
}

export async function extractAudioClip(
  doc: IYtImport,
  atSec: number,
  durationSec = 3
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const paths = assetPaths(doc.assetId);
  const outPath = join(config.processingPath, `clip_${doc.assetId}_${Math.round(atSec * 1000)}.m4a`);
  await ensureDir(config.processingPath);

  let sourceVideo: string;
  let cleanupSource: string[] = [];

  if (doc.storage === "local") {
    sourceVideo = join(localDirFor(doc), paths.videoFile);
  } else {
    const tempVideo = join(config.processingPath, `clip_src_${doc.assetId}.mp4`);
    const res = await fetch(doc.videoUrl!);
    if (!res.ok) throw new Error("Failed to fetch source video for audio clip");
    await Bun.write(tempVideo, await res.arrayBuffer());
    sourceVideo = tempVideo;
    cleanupSource = [tempVideo];
  }

  await new Promise<void>((resolvePromise, reject) => {
    ffmpeg(sourceVideo)
      .setStartTime(Math.max(0, atSec))
      .setDuration(durationSec)
      .noVideo()
      .audioCodec("copy")
      .output(outPath)
      .on("end", () => resolvePromise())
      .on("error", (err) => reject(new Error(`Audio clip failed: ${err.message}`)))
      .run();
  });

  return {
    path: outPath,
    cleanup: async () => {
      await cleanupFiles([outPath, ...cleanupSource]);
    },
  };
}

export async function deleteYtImport(id: string): Promise<void> {
  const doc = await YtImport.findById(id);
  if (!doc) return;

  if (doc.storage === "local" && doc.localDir) {
    await rm(doc.localDir, { recursive: true, force: true });
  }

  if (doc.storage === "s3" && doc.s3Prefix) {
    const keys = await listKeys(doc.s3Prefix);
    await Promise.all(keys.map((key) => deleteKey(key)));
  }

  await YtImport.findByIdAndDelete(id);
}

export function createAssetReadStream(filePath: string) {
  return createReadStream(filePath);
}

export async function getAssetStat(filePath: string) {
  return stat(filePath);
}

export async function ensureYtImportsStorage(): Promise<void> {
  await ensureDir(YT_IMPORTS_DIR);
}
