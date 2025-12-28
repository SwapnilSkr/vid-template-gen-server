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
        duration: metadata.format.duration || null,
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
 * Check if a video/audio file has an audio stream
 */
async function hasAudioStream(filePath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(new Error(`Failed to probe file: ${err.message}`));
        return;
      }
      const audioStream = metadata.streams.find(
        (s) => s.codec_type === "audio"
      );
      resolve(!!audioStream);
    });
  });
}

/**
 * Merge multiple audio tracks onto a video at specific timestamps
 * Handles videos with or without existing audio tracks
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

  // Check if source video has audio
  const videoHasAudio = await hasAudioStream(videoPath);
  console.log(`📹 Source video has audio: ${videoHasAudio}`);

  return new Promise((resolve, reject) => {
    let command = ffmpeg(videoPath);

    // Add all audio files as inputs
    for (const segment of audioSegments) {
      command = command.input(segment.audioPath);
    }

    // Build complex filter for audio mixing
    const filters: string[] = [];
    const mixLabels: string[] = [];

    if (videoHasAudio) {
      // If video has audio, reduce its volume and include it in the mix
      filters.push("[0:a]volume=0.3[orig]");
      mixLabels.push("[orig]");
    }

    audioSegments.forEach((segment, index) => {
      const inputIndex = index + 1;
      const label = `a${index}`;
      // Delay audio to start at the right time (adelay takes milliseconds)
      const delayMs = Math.round(segment.startTime * 1000);
      filters.push(`[${inputIndex}:a]adelay=${delayMs}|${delayMs}[${label}]`);
      mixLabels.push(`[${label}]`);
    });

    // Calculate number of audio inputs for amix
    const numAudioInputs = videoHasAudio
      ? audioSegments.length + 1
      : audioSegments.length;

    // Mix all audio tracks
    const mixFilter = `${mixLabels.join(
      ""
    )}amix=inputs=${numAudioInputs}:duration=longest[aout]`;
    filters.push(mixFilter);

    // Log the filter for debugging
    const filterString = filters.join(";");
    console.log(`🎛️  FFmpeg audio filter: ${filterString}`);

    command
      .complexFilter(filterString)
      .outputOptions(["-map", "0:v", "-map", "[aout]", "-c:v", "copy"])
      .output(output)
      .on("start", (_commandLine) => {
        console.log(`🚀 FFmpeg audio merge command started`);
      })
      .on("end", () => {
        console.log(`🔊 Merged ${audioSegments.length} audio tracks`);
        resolve(output);
      })
      .on("error", (err, _stdout, stderr) => {
        console.error("FFmpeg audio merge stderr:", stderr);
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
  timestamp = 1
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
 * @param position - Subtitle position: 'top', 'center', or 'bottom' (default: 'bottom')
 */
export async function addSubtitlesToVideo(
  videoPath: string,
  srtContent: string,
  outputPath?: string,
  position: "top" | "center" | "bottom" = "bottom"
): Promise<string> {
  await ensureDir(config.processingPath);
  const output =
    outputPath ||
    join(config.processingPath, generateFilename("subtitled", "mp4"));

  console.log(`🔤 addSubtitlesToVideo received position: "${position}"`);

  // ASS Alignment values (numpad-style):
  // 7 8 9 (top row)
  // 4 5 6 (middle row)
  // 1 2 3 (bottom row)
  const styleConfig = {
    top: { alignment: 8, marginV: 20 },
    center: { alignment: 5, marginV: 0 },
    bottom: { alignment: 2, marginV: 30 },
  };
  const { alignment, marginV } = styleConfig[position];
  console.log(
    `🔤 Using alignment=${alignment}, marginV=${marginV} for position="${position}"`
  );

  // Convert SRT to ASS format with proper styling
  const assContent = convertSrtToAss(srtContent, alignment, marginV);

  // Write ASS to temp file
  const assPath = join(config.processingPath, `temp_${Date.now()}.ass`);
  const { writeFile, unlink } = await import("node:fs/promises");
  await writeFile(assPath, assContent, "utf-8");

  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .outputOptions(["-vf", `ass='${assPath.replace(/'/g, "\\'")}'`])
      .output(output)
      .on("end", async () => {
        await unlink(assPath).catch(() => {});
        console.log(
          `📝 Subtitles added to video (position: ${position}, alignment: ${alignment})`
        );
        resolve(output);
      })
      .on("error", async (err) => {
        await unlink(assPath).catch(() => {});
        reject(new Error(`Subtitle burn failed: ${err.message}`));
      })
      .run();
  });
}

/**
 * Convert SRT content to ASS format with proper styling
 */
function convertSrtToAss(
  srtContent: string,
  alignment: number,
  marginV: number
): string {
  // ASS header with style definition
  const header = `[Script Info]
Title: Generated Subtitles
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,3,1,${alignment},10,10,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  // Parse SRT and convert to ASS dialogue lines
  const dialogueLines: string[] = [];
  const blocks = srtContent.trim().split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.length < 3) continue;

    // Parse timestamp line (format: 00:00:00,000 --> 00:00:00,000)
    const timestampMatch = lines[1].match(
      /(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/
    );
    if (!timestampMatch) continue;

    // Convert to ASS time format (H:MM:SS.cc)
    const startTime = `${parseInt(timestampMatch[1])}:${timestampMatch[2]}:${
      timestampMatch[3]
    }.${timestampMatch[4].slice(0, 2)}`;
    const endTime = `${parseInt(timestampMatch[5])}:${timestampMatch[6]}:${
      timestampMatch[7]
    }.${timestampMatch[8].slice(0, 2)}`;

    // Get text (may span multiple lines)
    const text = lines.slice(2).join("\\N");

    dialogueLines.push(
      `Dialogue: 0,${startTime},${endTime},Default,,0,0,0,,${text}`
    );
  }

  return header + dialogueLines.join("\n") + "\n";
}

/**
 * Trim video by removing the first N seconds and/or keeping only the first N seconds
 * @param inputPath - Path or URL to the input video
 * @param options - Processing options
 * @param options.trimStart - Number of seconds to trim from the start (default: 0)
 * @param options.keepDuration - Maximum duration to keep in seconds (optional)
 * @param options.removeAudio - Whether to remove audio (optional)
 * @param outputPath - Optional output path (defaults to processing directory)
 * @returns Path to the processed video file
 */
export async function trimVideo(
  inputPath: string,
  options: { trimStart?: number; keepDuration?: number; removeAudio?: boolean },
  outputPath?: string
): Promise<string> {
  await ensureDir(config.processingPath);
  const output =
    outputPath ||
    join(config.processingPath, generateFilename("processed", "mp4"));

  const { trimStart = 0, keepDuration, removeAudio = false } = options;

  return new Promise((resolve, reject) => {
    let command = ffmpeg(inputPath);

    // Set start time if trimStart is specified
    if (trimStart > 0) {
      command = command.setStartTime(trimStart);
    }

    // Set duration if keepDuration is specified
    if (keepDuration && keepDuration > 0) {
      command = command.setDuration(keepDuration);
    }

    const outputOptions = [
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-movflags",
      "+faststart",
    ];

    if (removeAudio) {
      outputOptions.push("-an");
    } else {
      outputOptions.push("-c:a", "aac");
    }

    command
      .outputOptions(outputOptions)
      .output(output)
      .on("end", () => {
        const trimMsg = trimStart > 0 ? `trimmed ${trimStart}s from start` : "";
        const durationMsg = keepDuration ? `kept ${keepDuration}s` : "";
        const audioMsg = removeAudio ? "audio removed" : "";
        const parts = [trimMsg, durationMsg, audioMsg].filter(Boolean);
        console.log(`✂️  Video processed: ${parts.join(", ")}`);
        resolve(output);
      })
      .on("error", (err) => {
        reject(new Error(`Video processing failed: ${err.message}`));
      })
      .run();
  });
}

/**
 * Remove audio from a video file
 * @param inputPath - Path or URL to the input video
 * @param outputPath - Optional output path
 * @returns Path to the processed video file
 */
export async function removeAudioFromVideo(
  inputPath: string,
  outputPath?: string
): Promise<string> {
  return trimVideo(inputPath, { removeAudio: true }, outputPath);
}
