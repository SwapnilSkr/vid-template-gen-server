import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type {
  IComposition,
  ICharacter,
  IRequiredCharacterPosition,
} from "../models";
import {
  applyCharacterOverlays,
  mergeAudioTracks,
  finalizeVideo,
  addSubtitlesToVideo,
  trimVideo,
} from "../services/ffmpeg.service";
import { uploadToS3, uploadSubtitles } from "../services/s3.service";
import { generateFilename, cleanupFiles } from "../utils";
import { config } from "../config";
import type { AudioSegment } from "../types";

/**
 * Default character position fallback (should rarely be needed now)
 */
const DEFAULT_POSITION: IRequiredCharacterPosition = {
  x: 5,
  y: 95,
  scale: 0.25,
  anchor: "bottom-left",
  animation: "none",
  animationDuration: 0.3,
};

/**
 * Calculate total duration of the conversation from generated script
 */
export function calculateConversationDuration(
  script: IComposition["generatedScript"]
): number {
  if (script.length === 0) return 0;

  const lastDialogue = script[script.length - 1];
  return lastDialogue.startTime + lastDialogue.duration;
}

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
 * Build video segments from audio segments and composition character positions
 * Now reads positions from composition.characterPositions instead of character.position
 */
export function buildVideoSegments(
  audioSegments: AudioSegment[],
  characters: ICharacter[],
  characterPositions: Map<string, IRequiredCharacterPosition>
) {
  return audioSegments.map((seg) => {
    const character = characters.find(
      (c) => c._id.toString() === seg.characterId
    );

    // Get position from composition's characterPositions map
    // At this point, all positions should be normalized with all fields present
    const position =
      characterPositions.get(seg.characterId) || DEFAULT_POSITION;

    return {
      characterId: seg.characterId,
      imagePath: character?.imageUrl || "",
      position,
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
  audioSegments: AudioSegment[],
  characters: ICharacter[],
  filenameSuffix = ""
): Promise<{
  outputUrl: string;
  subtitlesUrl: string;
  tempFiles: string[];
}> {
  const tempFiles: string[] = [];
  try {
    // Step 1: Convert template video to target aspect ratio
    const { convertToAspectRatio } = await import("../services/ffmpeg.service");
    const aspectCorrectedVideo = await convertToAspectRatio(
      templateVideoPath,
      composition.screenType
    );
    tempFiles.push(aspectCorrectedVideo);

    // Step 2: Build video segments using composition's character positions
    const videoSegments = buildVideoSegments(
      audioSegments,
      characters,
      composition.characterPositions
    );

    // Step 3: Apply character overlays
    const videoWithOverlays = await applyCharacterOverlays(
      aspectCorrectedVideo,
      videoSegments
    );
    tempFiles.push(videoWithOverlays);

    // Step 4: Merge audio tracks
    const videoWithAudio = await mergeAudioTracks(
      videoWithOverlays,
      audioSegments
    );
    tempFiles.push(videoWithAudio);

    // Generate and add subtitles with karaoke highlighting
    const { generateKaraokeAssContent } =
      await import("../services/subtitle.service");

    const subtitlePos = composition.subtitlePosition || "bottom";

    const styleConfig = {
      top: { alignment: 8, marginV: 20 },
      center: { alignment: 5, marginV: 0 },
      bottom: { alignment: 2, marginV: 30 },
    };
    const { alignment, marginV } = styleConfig[subtitlePos];

    const assContent = await generateKaraokeAssContent(
      composition.generatedScript.map((s) => ({
        text: s.text,
        startTime: s.startTime,
        duration: s.duration,
      })),
      {
        wordsPerChunkMin: 2,
        wordsPerChunkMax: 3,
        primaryColor: config.subtitleColors.primary,
        secondaryColor: config.subtitleColors.secondary,
        chunkSpeedMultiplier: config.chunkSpeedMultiplier,
      },
      alignment,
      marginV
    );

    const subtitlesUrl = await uploadSubtitles(
      assContent,
      filenameSuffix ? `${compositionId}_${filenameSuffix}` : compositionId
    );

    console.log(`🎯 addSubtitlesToVideo called with position: ${subtitlePos}`);

    const videoWithSubtitles = await addSubtitlesToVideo(
      videoWithAudio,
      assContent,
      undefined,
      subtitlePos
    );
    tempFiles.push(videoWithSubtitles);

    const conversationDuration = calculateConversationDuration(
      composition.generatedScript
    );
    console.log(
      `⏱️  Conversation duration: ${conversationDuration.toFixed(
        2
      )}s - will trim video to this length`
    );

    const trimmedVideo = await trimVideo(
      videoWithSubtitles,
      { keepDuration: conversationDuration },
      undefined
    );
    tempFiles.push(trimmedVideo);

    // Finalize and upload
    const outputFilename = generateFilename(
      `${composition.title.replace(/[^a-z0-9]/gi, "_").toLowerCase()}${
        filenameSuffix ? `_${filenameSuffix}` : ""
      }`,
      "mp4"
    );
    const finalOutputPath = join(config.processingPath, outputFilename);
    tempFiles.push(finalOutputPath);

    await finalizeVideo(trimmedVideo, finalOutputPath, {
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
      tempFiles,
    };
  } catch (error) {
    // If anything fails, clean up the files generated SO FAR
    console.error("Pipeline failed, cleaning up partial files...");
    await cleanupFiles(tempFiles);
    throw error;
  }
}
