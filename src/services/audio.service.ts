/**
 * Audio Test Service
 * Isolated service to test and debug audio merging functionality
 */
import ffmpeg from "fluent-ffmpeg";
import { join } from "node:path";
import { unlink, readdir } from "node:fs/promises";
import { config } from "../config";
import { ensureDir, generateFilename } from "../utils";
import type { AudioSegment } from "../types";

// Sample test audio - we'll generate simple beep tones for testing
const TEST_VIDEO_URL =
  "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

/**
 * Generate a simple test audio file using ffmpeg CLI directly
 * (fluent-ffmpeg has issues with lavfi virtual input)
 */
async function generateTestAudio(
  durationSeconds: number,
  frequency: number,
  outputPath: string
): Promise<string> {
  const { spawn } = await import("node:child_process");

  return new Promise((resolve, reject) => {
    const args = [
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${frequency}:duration=${durationSeconds}`,
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-y", // Overwrite output
      outputPath,
    ];

    const ffmpegProcess = spawn("ffmpeg", args);

    let stderr = "";
    ffmpegProcess.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    ffmpegProcess.on("close", (code) => {
      if (code === 0) {
        console.log(
          `🔊 Generated test audio: ${frequency}Hz, ${durationSeconds}s`
        );
        resolve(outputPath);
      } else {
        reject(
          new Error(`Failed to generate test audio (code ${code}): ${stderr}`)
        );
      }
    });

    ffmpegProcess.on("error", (err) => {
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
    });
  });
}

/**
 * Check if a video has an audio stream
 */
async function hasAudioStream(videoPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        reject(new Error(`Failed to probe video: ${err.message}`));
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
 * FIXED VERSION: Handles videos with no audio track
 */
export async function mergeAudioTracksFixed(
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
      // If video has audio, reduce its volume and include it
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
    console.log(`🎛️  FFmpeg filter: ${filterString}`);

    command
      .complexFilter(filterString)
      .outputOptions(["-map", "0:v", "-map", "[aout]", "-c:v", "copy"])
      .output(output)
      .on("start", (commandLine) => {
        console.log(`🚀 FFmpeg command: ${commandLine}`);
      })
      .on("progress", (progress) => {
        if (progress.percent) {
          console.log(`⏳ Processing: ${progress.percent.toFixed(1)}%`);
        }
      })
      .on("end", () => {
        console.log(`🔊 Merged ${audioSegments.length} audio tracks`);
        resolve(output);
      })
      .on("error", (err, stdout, stderr) => {
        console.error("FFmpeg stderr:", stderr);
        reject(new Error(`Audio merge failed: ${err.message}`));
      })
      .run();
  });
}

/**
 * Test the audio merging with generated test audio
 */
export async function testAudioMerge(): Promise<{
  success: boolean;
  outputPath?: string;
  error?: string;
  details: {
    videoPath: string;
    audioSegments: number;
    filterUsed: string;
    hasSourceAudio: boolean;
  };
}> {
  await ensureDir(config.processingPath);

  const testDir = join(config.processingPath, "audio-test");
  await ensureDir(testDir);

  try {
    // Generate test audio files with different frequencies
    const testAudioFiles: { path: string; startTime: number }[] = [];

    // Audio 1: 440Hz (A4 note) starting at 0 seconds
    const audio1Path = join(testDir, "test_audio_1.aac");
    await generateTestAudio(2, 440, audio1Path);
    testAudioFiles.push({ path: audio1Path, startTime: 0 });

    // Audio 2: 523Hz (C5 note) starting at 3 seconds
    const audio2Path = join(testDir, "test_audio_2.aac");
    await generateTestAudio(2, 523, audio2Path);
    testAudioFiles.push({ path: audio2Path, startTime: 3 });

    // Audio 3: 659Hz (E5 note) starting at 6 seconds
    const audio3Path = join(testDir, "test_audio_3.aac");
    await generateTestAudio(2, 659, audio3Path);
    testAudioFiles.push({ path: audio3Path, startTime: 6 });

    // Check if source video has audio
    const hasAudio = await hasAudioStream(TEST_VIDEO_URL);

    // Build audio segments
    const audioSegments: AudioSegment[] = testAudioFiles.map((file, index) => ({
      characterId: `test-char-${index}`,
      text: `Test audio ${index + 1}`,
      audioPath: file.path,
      startTime: file.startTime,
      duration: 2,
    }));

    // Calculate what filter will be used
    const mixLabels: string[] = [];
    if (hasAudio) mixLabels.push("[orig]");
    audioSegments.forEach((_, i) => mixLabels.push(`[a${i}]`));
    const numInputs = hasAudio
      ? audioSegments.length + 1
      : audioSegments.length;
    const filterUsed = `${mixLabels.join(
      ""
    )}amix=inputs=${numInputs}:duration=longest[aout]`;

    // Run the merge
    const outputPath = join(testDir, "test_merged_output.mp4");
    await mergeAudioTracksFixed(TEST_VIDEO_URL, audioSegments, outputPath);

    return {
      success: true,
      outputPath,
      details: {
        videoPath: TEST_VIDEO_URL,
        audioSegments: audioSegments.length,
        filterUsed,
        hasSourceAudio: hasAudio,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: message,
      details: {
        videoPath: TEST_VIDEO_URL,
        audioSegments: 3,
        filterUsed: "N/A - failed before filter construction",
        hasSourceAudio: false,
      },
    };
  }
}

/**
 * Test with a custom video URL and audio configuration
 */
export async function testAudioMergeCustom(
  videoUrl: string,
  audioConfigs: { startTime: number; frequency?: number; duration?: number }[]
): Promise<{
  success: boolean;
  outputPath?: string;
  error?: string;
  ffmpegLog?: string;
}> {
  await ensureDir(config.processingPath);

  const testDir = join(config.processingPath, "audio-test-custom");
  await ensureDir(testDir);

  // Clean up old test files
  try {
    const oldFiles = await readdir(testDir);
    for (const file of oldFiles) {
      await unlink(join(testDir, file)).catch(() => {});
    }
  } catch {
    // Directory might not exist yet
  }

  try {
    // Generate test audio files
    const audioSegments: AudioSegment[] = [];

    for (let i = 0; i < audioConfigs.length; i++) {
      const cfg = audioConfigs[i];
      const frequency = cfg.frequency || 440 + i * 100;
      const duration = cfg.duration || 2;

      const audioPath = join(testDir, `custom_audio_${i}.aac`);
      await generateTestAudio(duration, frequency, audioPath);

      audioSegments.push({
        characterId: `custom-${i}`,
        text: `Custom audio ${i + 1}`,
        audioPath,
        startTime: cfg.startTime,
        duration,
      });
    }

    // Run the merge
    const outputPath = join(testDir, `custom_merged_${Date.now()}.mp4`);
    await mergeAudioTracksFixed(videoUrl, audioSegments, outputPath);

    return {
      success: true,
      outputPath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: message,
    };
  }
}

/**
 * List test output files
 */
export async function listTestOutputs(): Promise<string[]> {
  const testDir = join(config.processingPath, "audio-test");
  try {
    const files = await readdir(testDir);
    return files.map((f) => join(testDir, f));
  } catch {
    return [];
  }
}

/**
 * Clean up test files
 */
export async function cleanupTestFiles(): Promise<number> {
  const testDir = join(config.processingPath, "audio-test");
  let deleted = 0;
  try {
    const files = await readdir(testDir);
    for (const file of files) {
      await unlink(join(testDir, file));
      deleted++;
    }
  } catch {
    // Directory might not exist
  }
  return deleted;
}
