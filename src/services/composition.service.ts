import { join } from "node:path";
import { config } from "../config";
import type {
  CompositionRequest,
  CompositionJob,
  DialogueLine,
  AudioSegment,
  VideoSegment,
} from "../types";
import { generateSpeech } from "./elevenlabs.service";
import {
  applyCharacterOverlays,
  mergeAudioTracks,
  finalizeVideo,
} from "./ffmpeg.service";
import { getTemplate } from "./template.service";
import { getCharacter } from "./character.service";
import {
  createJob,
  updateJobStatus,
  setJobOutput,
  failJob,
} from "./job.service";
import { generateFilename, ensureDir } from "../utils";

/**
 * Start a new video composition
 */
export async function createComposition(
  request: CompositionRequest
): Promise<CompositionJob> {
  // Validate template exists
  const template = getTemplate(request.templateId);
  if (!template) {
    throw new Error(`Template not found: ${request.templateId}`);
  }

  // Validate all characters exist
  for (const line of request.dialogue) {
    const character = getCharacter(line.characterId);
    if (!character) {
      throw new Error(`Character not found: ${line.characterId}`);
    }
  }

  // Create job
  const job = createJob(request.templateId, request.title, request.dialogue);

  // Start async processing
  processComposition(job.id, request).catch((error) => {
    console.error("Composition error:", error);
    failJob(job.id, error.message);
  });

  return job;
}

/**
 * Process composition asynchronously
 */
async function processComposition(
  jobId: string,
  request: CompositionRequest
): Promise<void> {
  const template = getTemplate(request.templateId)!;
  const { dialogue } = request;

  // Step 1: Generate audio for all dialogue lines
  updateJobStatus(jobId, "processing_audio", 10);

  const audioSegments: AudioSegment[] = [];
  const dialogueWithDurations: DialogueLine[] = [];

  for (let i = 0; i < dialogue.length; i++) {
    const line = dialogue[i];
    const character = getCharacter(line.characterId)!;

    const { audioPath, duration } = await generateSpeech(
      line.text,
      character.voiceId
    );

    audioSegments.push({
      characterId: line.characterId,
      text: line.text,
      audioPath,
      startTime: line.startTime,
      duration,
    });

    dialogueWithDurations.push({
      ...line,
      duration,
    });

    // Update progress (10-40%)
    const progress = 10 + Math.round(((i + 1) / dialogue.length) * 30);
    updateJobStatus(jobId, "processing_audio", progress);
  }

  // Step 2: Create video segments for character overlays
  updateJobStatus(jobId, "processing_video", 45);

  const videoSegments: VideoSegment[] = [];

  for (const audio of audioSegments) {
    const character = getCharacter(audio.characterId)!;
    const dialogueLine = dialogue.find(
      (d) =>
        d.characterId === audio.characterId && d.startTime === audio.startTime
    );

    videoSegments.push({
      characterId: audio.characterId,
      imagePath: character.imagePath,
      position: dialogueLine?.position || character.defaultPosition,
      startTime: audio.startTime,
      endTime: audio.startTime + audio.duration,
    });
  }

  // Step 3: Apply character overlays to video
  updateJobStatus(jobId, "compositing", 50);

  const videoWithOverlays = await applyCharacterOverlays(
    template.filePath,
    videoSegments
  );

  // Step 4: Merge audio tracks
  updateJobStatus(jobId, "compositing", 70);

  const videoWithAudio = await mergeAudioTracks(
    videoWithOverlays,
    audioSegments
  );

  // Step 5: Finalize video
  updateJobStatus(jobId, "finalizing", 85);

  await ensureDir(config.outputPath);
  const outputFilename = generateFilename(
    request.title.replace(/[^a-z0-9]/gi, "_").toLowerCase(),
    "mp4"
  );
  const outputPath = join(config.outputPath, outputFilename);

  await finalizeVideo(videoWithAudio, outputPath, {
    quality: request.outputSettings?.quality || "medium",
  });

  // Mark complete
  setJobOutput(jobId, outputPath);
  updateJobStatus(jobId, "completed", 100);

  console.log(`🎉 Composition complete: ${outputPath}`);
}
