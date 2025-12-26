import ffmpeg from "fluent-ffmpeg";
import { join } from "node:path";
import { config } from "../config";
import type {
  TemplateMetadata,
  CharacterPosition,
  AudioSegment,
  VideoSegment,
} from "../types";
import { ensureDir, generateFilename } from "../utils";

// Configure FFmpeg paths if provided
if (config.ffmpegPath) {
  ffmpeg.setFfmpegPath(config.ffmpegPath);
}
if (config.ffprobePath) {
  ffmpeg.setFfprobePath(config.ffprobePath);
}

/**
 * Get video metadata using ffprobe
 */
export async function getVideoMetadata(
  filePath: string
): Promise<TemplateMetadata> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(new Error(`Failed to probe video: ${err.message}`));
        return;
      }

      const videoStream = metadata.streams.find(
        (s) => s.codec_type === "video"
      );
      if (!videoStream) {
        reject(new Error("No video stream found"));
        return;
      }

      // Parse frame rate
      let frameRate = 30;
      if (videoStream.r_frame_rate) {
        const [num, den] = videoStream.r_frame_rate.split("/").map(Number);
        frameRate = den ? num / den : num;
      }

      resolve({
        duration: metadata.format.duration || 0,
        width: videoStream.width || 1920,
        height: videoStream.height || 1080,
        frameRate,
        codec: videoStream.codec_name || "unknown",
        bitrate: metadata.format.bit_rate
          ? parseInt(String(metadata.format.bit_rate))
          : 0,
      });
    });
  });
}

/**
 * Calculate overlay position for FFmpeg filter
 */
function calculateOverlayPosition(
  position: CharacterPosition,
  videoWidth: number,
  videoHeight: number,
  imageWidth: number,
  imageHeight: number
): string {
  const scaledWidth = imageWidth * position.scale;
  const scaledHeight = imageHeight * position.scale;

  // Convert percentage to pixels
  let x = (position.x / 100) * videoWidth;
  let y = (position.y / 100) * videoHeight;

  // Adjust for anchor point
  switch (position.anchor) {
    case "center":
      x -= scaledWidth / 2;
      y -= scaledHeight / 2;
      break;
    case "top-right":
      x -= scaledWidth;
      break;
    case "bottom-left":
      y -= scaledHeight;
      break;
    case "bottom-right":
      x -= scaledWidth;
      y -= scaledHeight;
      break;
    // top-left is default, no adjustment needed
  }

  return `${Math.round(x)}:${Math.round(y)}`;
}

/**
 * Overlay a single image on video for a time range
 */
export async function overlayImage(
  videoPath: string,
  imagePath: string,
  position: CharacterPosition,
  startTime: number,
  endTime: number,
  outputPath?: string
): Promise<string> {
  await ensureDir(config.processingPath);

  const output =
    outputPath ||
    join(config.processingPath, generateFilename("overlay", "mp4"));

  // Get video dimensions
  const videoMeta = await getVideoMetadata(videoPath);

  // Get image dimensions (approximate, will be scaled)
  const imageWidth = 400; // assume standard character image
  const imageHeight = 400;

  const overlayPos = calculateOverlayPosition(
    position,
    videoMeta.width,
    videoMeta.height,
    imageWidth,
    imageHeight
  );

  return new Promise((resolve, reject) => {
    const scaledWidth = Math.round(imageWidth * position.scale);
    const scaledHeight = Math.round(imageHeight * position.scale);

    ffmpeg(videoPath)
      .input(imagePath)
      .complexFilter([
        // Scale the overlay image
        `[1:v]scale=${scaledWidth}:${scaledHeight}[scaled]`,
        // Apply overlay with timing
        `[0:v][scaled]overlay=${overlayPos}:enable='between(t,${startTime},${endTime})'[out]`,
      ])
      .outputOptions(["-map", "[out]", "-map", "0:a?"])
      .output(output)
      .on("end", () => {
        console.log(`🖼️  Overlay applied: ${startTime}s - ${endTime}s`);
        resolve(output);
      })
      .on("error", (err) => {
        reject(new Error(`Overlay failed: ${err.message}`));
      })
      .run();
  });
}

/**
 * Apply multiple character overlays to a video
 */
export async function applyCharacterOverlays(
  videoPath: string,
  segments: VideoSegment[],
  outputPath?: string
): Promise<string> {
  if (segments.length === 0) {
    return videoPath;
  }

  await ensureDir(config.processingPath);
  const output =
    outputPath ||
    join(config.processingPath, generateFilename("characters", "mp4"));

  const videoMeta = await getVideoMetadata(videoPath);
  const imageSize = 400;

  return new Promise((resolve, reject) => {
    let command = ffmpeg(videoPath);

    // Add all overlay images as inputs
    for (const segment of segments) {
      command = command.input(segment.imagePath);
    }

    // Build complex filter for all overlays
    const filters: string[] = [];
    let currentOutput = "0:v";

    segments.forEach((segment, index) => {
      const inputIndex = index + 1;
      const scaledSize = Math.round(imageSize * segment.position.scale);
      const overlayPos = calculateOverlayPosition(
        segment.position,
        videoMeta.width,
        videoMeta.height,
        imageSize,
        imageSize
      );

      const scaledLabel = `scaled${index}`;
      const outputLabel = index === segments.length - 1 ? "out" : `v${index}`;

      filters.push(
        `[${inputIndex}:v]scale=${scaledSize}:${scaledSize}[${scaledLabel}]`
      );
      filters.push(
        `[${currentOutput}][${scaledLabel}]overlay=${overlayPos}:enable='between(t,${segment.startTime},${segment.endTime})'[${outputLabel}]`
      );

      currentOutput = outputLabel;
    });

    command
      .complexFilter(filters)
      .outputOptions(["-map", "[out]", "-map", "0:a?", "-c:a", "copy"])
      .output(output)
      .on("end", () => {
        console.log(`🎬 Applied ${segments.length} character overlays`);
        resolve(output);
      })
      .on("error", (err) => {
        reject(new Error(`Character overlay failed: ${err.message}`));
      })
      .run();
  });
}

/**
 * Merge multiple audio tracks onto a video at specific timestamps
 */
export async function mergeAudioTracks(
  videoPath: string,
  audioSegments: AudioSegment[],
  outputPath?: string
): Promise<string> {
  if (audioSegments.length === 0) {
    return videoPath;
  }

  await ensureDir(config.processingPath);
  const output =
    outputPath ||
    join(config.processingPath, generateFilename("merged", "mp4"));

  return new Promise((resolve, reject) => {
    let command = ffmpeg(videoPath);

    // Add all audio files as inputs
    for (const segment of audioSegments) {
      command = command.input(segment.audioPath);
    }

    // Build complex filter for audio mixing
    const filters: string[] = [];
    const audioInputs: string[] = [];

    // Add original audio (if exists) with reduced volume
    audioInputs.push("[0:a]volume=0.3[orig]");

    audioSegments.forEach((segment, index) => {
      const inputIndex = index + 1;
      const label = `a${index}`;
      // Delay audio to start at the right time
      filters.push(
        `[${inputIndex}:a]adelay=${Math.round(
          segment.startTime * 1000
        )}|${Math.round(segment.startTime * 1000)}[${label}]`
      );
      audioInputs.push(`[${label}]`);
    });

    // Mix all audio tracks
    const mixInputs = `[orig]${audioInputs.slice(1).join("")}`;
    const mixFilter = `${mixInputs}amix=inputs=${
      audioSegments.length + 1
    }:duration=longest[aout]`;

    filters.push(...audioInputs);
    filters.push(mixFilter);

    command
      .complexFilter(filters.join(";"))
      .outputOptions(["-map", "0:v", "-map", "[aout]", "-c:v", "copy"])
      .output(output)
      .on("end", () => {
        console.log(`🔊 Merged ${audioSegments.length} audio tracks`);
        resolve(output);
      })
      .on("error", (err) => {
        reject(new Error(`Audio merge failed: ${err.message}`));
      })
      .run();
  });
}

/**
 * Finalize video with proper encoding settings
 */
export async function finalizeVideo(
  inputPath: string,
  outputPath: string,
  settings?: { quality?: "low" | "medium" | "high" }
): Promise<string> {
  await ensureDir(config.processingPath);

  const crf =
    settings?.quality === "high" ? 18 : settings?.quality === "low" ? 28 : 23;

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        "-c:v",
        "libx264",
        "-crf",
        String(crf),
        "-preset",
        "medium",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
      ])
      .output(outputPath)
      .on("end", () => {
        console.log(`✅ Video finalized: ${outputPath}`);
        resolve(outputPath);
      })
      .on("error", (err) => {
        reject(new Error(`Finalization failed: ${err.message}`));
      })
      .run();
  });
}

/**
 * Extract a thumbnail from video
 */
export async function extractThumbnail(
  videoPath: string,
  outputPath: string,
  timestamp: number = 1
): Promise<string> {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .screenshots({
        timestamps: [timestamp],
        filename: outputPath.split("/").pop() || "thumbnail.jpg",
        folder: outputPath.split("/").slice(0, -1).join("/"),
        size: "320x180",
      })
      .on("end", () => resolve(outputPath))
      .on("error", (err) =>
        reject(new Error(`Thumbnail extraction failed: ${err.message}`))
      );
  });
}

/**
 * Add subtitles to video (burn in)
 */
export async function addSubtitlesToVideo(
  videoPath: string,
  srtContent: string,
  outputPath?: string
): Promise<string> {
  await ensureDir(config.processingPath);
  const output =
    outputPath ||
    join(config.processingPath, generateFilename("subtitled", "mp4"));

  // Write SRT to temp file
  const srtPath = join(config.processingPath, `temp_${Date.now()}.srt`);
  const { writeFile, unlink } = await import("node:fs/promises");
  await writeFile(srtPath, srtContent, "utf-8");

  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .outputOptions([
        "-vf",
        `subtitles='${srtPath.replace(
          /'/g,
          "\\'"
        )}':force_style='FontSize=24,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,Outline=2,Alignment=2'`,
      ])
      .output(output)
      .on("end", async () => {
        await unlink(srtPath).catch(() => {});
        console.log(`📝 Subtitles added to video`);
        resolve(output);
      })
      .on("error", async (err) => {
        await unlink(srtPath).catch(() => {});
        reject(new Error(`Subtitle burn failed: ${err.message}`));
      })
      .run();
  });
}
