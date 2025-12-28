import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { IComposition, ICharacter } from "../models";
import {
  applyCharacterOverlays,
  mergeAudioTracks,
  finalizeVideo,
  addSubtitlesToVideo,
} from "../services/ffmpeg.service";
import { uploadToS3, uploadSubtitles } from "../services/s3.service";
import { generateSrtContent } from "../services/subtitle.service";
import { generateFilename } from "../utils";
import { config } from "../config";

/**
 * Recalculate dialogue start times based on delays and durations
 */
export function recalculateTimings(
  script: IComposition["generatedScript"],
  audioSegments: { startTime: number }[]
): void {
  let currentTime = 0;
  for (let i = 0; i < script.length; i++) {
    const line = script[i];
    currentTime += line.delay;
    line.startTime = currentTime;
    if (audioSegments[i]) {
      audioSegments[i].startTime = currentTime;
    }
    currentTime += line.duration;
  }
}

/**
 * Build video segments from audio segments and characters
 */
export function buildVideoSegments(
  audioSegments: {
    characterId: string;
    startTime: number;
    duration: number;
  }[],
  characters: ICharacter[]
) {
  return audioSegments.map((seg) => {
    const character = characters.find(
      (c) => c._id.toString() === seg.characterId
    );
    return {
      characterId: seg.characterId,
      imagePath: character?.imageUrl || "",
      position: character?.position || {
        x: 5,
        y: 95,
        scale: 0.25,
        anchor: "bottom-left" as const,
      },
      startTime: seg.startTime,
      endTime: seg.startTime + seg.duration,
    };
  });
}

/**
 * Process video with audio and subtitles pipeline
 * Returns the paths to temporary files for cleanup
 */
export async function processVideoWithAudioAndSubtitles(
  compositionId: string,
  composition: IComposition,
  templateVideoPath: string,
  audioSegments: {
    characterId: string;
    text: string;
    audioPath: string;
    startTime: number;
    duration: number;
  }[],
  characters: ICharacter[],
  filenameSuffix = ""
): Promise<{
  outputUrl: string;
  subtitlesUrl: string;
  tempFiles: string[];
}> {
  // Build video segments
  const videoSegments = buildVideoSegments(audioSegments, characters);

  // Apply character overlays
  const videoWithOverlays = await applyCharacterOverlays(
    templateVideoPath,
    videoSegments
  );

  // Merge audio tracks
  const videoWithAudio = await mergeAudioTracks(
    videoWithOverlays,
    audioSegments
  );

  // Generate and add subtitles
  const srtContent = generateSrtContent(
    composition.generatedScript.map((s) => ({
      text: s.text,
      startTime: s.startTime,
      duration: s.duration,
    }))
  );

  const subtitlesUrl = await uploadSubtitles(
    srtContent,
    filenameSuffix ? `${compositionId}_${filenameSuffix}` : compositionId
  );

  const subtitlePos = composition.subtitlePosition || "bottom";
  console.log(`🎯 addSubtitlesToVideo called with position: ${subtitlePos}`);

  const videoWithSubtitles = await addSubtitlesToVideo(
    videoWithAudio,
    srtContent,
    undefined,
    subtitlePos
  );

  // Finalize and upload
  const outputFilename = generateFilename(
    `${composition.title.replace(/[^a-z0-9]/gi, "_").toLowerCase()}${
      filenameSuffix ? `_${filenameSuffix}` : ""
    }`,
    "mp4"
  );
  const finalOutputPath = join(config.processingPath, outputFilename);

  await finalizeVideo(videoWithSubtitles, finalOutputPath, {
    quality: "high",
  });

  // Upload to S3
  const outputBuffer = await readFile(finalOutputPath);
  const outputUrl = await uploadToS3(
    outputBuffer,
    "compositions",
    outputFilename,
    "video/mp4"
  );

  return {
    outputUrl,
    subtitlesUrl,
    tempFiles: [
      finalOutputPath,
      videoWithOverlays,
      videoWithAudio,
      videoWithSubtitles,
    ],
  };
}
