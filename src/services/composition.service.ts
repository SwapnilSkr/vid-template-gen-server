import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  Composition,
  type IComposition,
  type ICharacter,
  type ITemplate,
} from "../models";
import { generateScript } from "./ai.service";
import { generateSpeech } from "./elevenlabs.service";
import {
  applyCharacterOverlays,
  mergeAudioTracks,
  finalizeVideo,
  addSubtitlesToVideo,
} from "./ffmpeg.service";
import { uploadToS3, uploadSubtitles, uploadAudio } from "./s3.service";
import {
  generateSrtContent,
  calculateDialogueTiming,
} from "./subtitle.service";
import { getTemplate } from "./template.service";
import { ensureDir, generateFilename, cleanupFiles } from "../utils";
import { config } from "../config";
import { getErrorMessage } from "../types";

/**
 * Populated template type - when template is populated via Mongoose
 */
interface PopulatedTemplate extends Omit<ITemplate, "characters"> {
  characters: ICharacter[];
}

/**
 * Create a new composition from plot
 */
export async function createComposition(
  templateId: string,
  plot: string,
  title?: string,
  subtitlePosition?: "top" | "center" | "bottom"
): Promise<IComposition> {
  // Validate template exists and has characters
  const template = await getTemplate(templateId);
  if (!template) {
    throw new Error(`Template not found: ${templateId}`);
  }

  if (!template.characters || template.characters.length === 0) {
    throw new Error(
      "Template has no characters assigned. Add characters first."
    );
  }

  // Create composition record
  const composition = new Composition({
    template: templateId,
    title: title || "Generating...",
    plot,
    subtitlePosition: subtitlePosition || "bottom",
    status: "pending",
    progress: 0,
    generatedScript: [],
  });

  await composition.save();
  console.log(`🎬 Created composition: ${composition._id}`);

  // Start async processing
  processComposition(composition._id.toString()).catch((error: unknown) => {
    console.error("Composition processing failed:", error);
    updateCompositionStatus(
      composition._id.toString(),
      "failed",
      0,
      getErrorMessage(error)
    );
  });

  return composition;
}

/**
 * Update composition status
 */
async function updateCompositionStatus(
  id: string,
  status: IComposition["status"],
  progress: number,
  error?: string
): Promise<void> {
  await Composition.findByIdAndUpdate(id, {
    status,
    progress: Math.min(100, Math.max(0, progress)),
    ...(error && { error }),
  });
}

/**
 * Process composition asynchronously
 */
async function processComposition(compositionId: string): Promise<void> {
  const composition = await Composition.findById(compositionId).populate({
    path: "template",
    populate: {
      path: "characters",
    },
  });
  if (!composition) throw new Error("Composition not found");

  // Cast populated template to proper type
  const template = composition.template as unknown as PopulatedTemplate;
  const characters = template.characters as ICharacter[];

  try {
    // Step 1: Generate script using AI
    await updateCompositionStatus(compositionId, "generating_script", 5);

    const generatedScript = await generateScript(
      composition.plot,
      characters,
      template.duration
    );

    // Update title if AI generated one
    composition.title = generatedScript.title || composition.title;

    // Calculate timing for dialogues
    const timedDialogues = calculateDialogueTiming(generatedScript.dialogues);

    // Map to character refs and save script
    composition.generatedScript = timedDialogues.map((d) => {
      // Find the original dialogue to get the character name
      const matchedDialogue = generatedScript.dialogues.find(
        (gd) => gd.text === d.text
      );

      // Find the character by matching the name
      const character = characters.find(
        (c) =>
          c.name.toLowerCase() === matchedDialogue?.characterName.toLowerCase()
      );

      return {
        character: character?._id || characters[0]._id,
        text: d.text,
        startTime: d.startTime,
        duration: d.duration,
        delay: d.delay,
      };
    });

    await composition.save();
    await updateCompositionStatus(compositionId, "generating_audio", 15);

    // Step 2: Generate audio for each dialogue and upload to S3
    await ensureDir(config.processingPath);
    const audioSegments: {
      characterId: string;
      text: string;
      audioPath: string;
      speechUrl: string;
      startTime: number;
      duration: number;
    }[] = [];

    for (let i = 0; i < composition.generatedScript.length; i++) {
      const line = composition.generatedScript[i];
      const character = characters.find(
        (c) => c._id.toString() === line.character.toString()
      );

      if (!character) continue;

      const { audioPath, duration } = await generateSpeech(
        line.text,
        character.voiceId
      );

      // Upload speech to S3 for future regeneration
      const audioBuffer = await readFile(audioPath);
      const speechUrl = await uploadAudio(
        audioBuffer,
        `speech_${compositionId}_${i}.mp3`
      );

      audioSegments.push({
        characterId: character._id.toString(),
        text: line.text,
        audioPath,
        speechUrl,
        startTime: line.startTime,
        duration,
      });

      // Update line duration and speechUrl with actual audio data
      line.duration = duration;
      line.speechUrl = speechUrl;

      const progress =
        15 + Math.round(((i + 1) / composition.generatedScript.length) * 25);
      await updateCompositionStatus(
        compositionId,
        "generating_audio",
        progress
      );
    }

    // Recalculate start times based on actual durations and delays
    let currentTime = 0;
    for (let i = 0; i < composition.generatedScript.length; i++) {
      const line = composition.generatedScript[i];
      currentTime += line.delay;
      line.startTime = currentTime;
      audioSegments[i].startTime = currentTime;
      currentTime += line.duration;
    }

    await composition.save();

    // Step 3: Download template video for processing
    await updateCompositionStatus(compositionId, "compositing", 45);

    // For now, we'll use the video URL directly (assumes accessible)
    // In production, you might want to download from S3 first
    const templateVideoPath = template.videoUrl;

    // Step 4: Apply character overlays
    const videoSegments = audioSegments.map((seg) => {
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

    // Note: For S3 videos, we need to download first
    // This is simplified - in production, download from S3
    const videoWithOverlays = await applyCharacterOverlays(
      templateVideoPath,
      videoSegments
    );
    await updateCompositionStatus(compositionId, "compositing", 60);

    // Step 5: Merge audio tracks
    const videoWithAudio = await mergeAudioTracks(
      videoWithOverlays,
      audioSegments
    );
    await updateCompositionStatus(compositionId, "adding_subtitles", 75);

    // Step 6: Generate and add subtitles
    const srtContent = generateSrtContent(
      composition.generatedScript.map((s) => ({
        text: s.text,
        startTime: s.startTime,
        duration: s.duration,
      }))
    );

    const subtitlesUrl = await uploadSubtitles(srtContent, compositionId);
    composition.subtitlesUrl = subtitlesUrl;

    // Burn subtitles into video
    const videoWithSubtitles = await addSubtitlesToVideo(
      videoWithAudio,
      srtContent,
      undefined,
      composition.subtitlePosition || "bottom"
    );
    await updateCompositionStatus(compositionId, "uploading", 85);

    // Step 7: Finalize and upload
    const outputFilename = generateFilename(
      composition.title.replace(/[^a-z0-9]/gi, "_").toLowerCase(),
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

    composition.outputUrl = outputUrl;
    composition.status = "completed";
    composition.progress = 100;
    await composition.save();

    // Cleanup all temp files
    const filesToClean = [
      finalOutputPath,
      videoWithOverlays,
      videoWithAudio,
      videoWithSubtitles,
      ...audioSegments.map((seg) => seg.audioPath),
    ];

    await cleanupFiles(filesToClean);
    console.log(`🧹 Cleaned up ${filesToClean.length} temporary files`);

    console.log(`🎉 Composition complete: ${composition._id}`);
  } catch (error: unknown) {
    console.error(`Composition ${compositionId} failed:`, error);
    await updateCompositionStatus(
      compositionId,
      "failed",
      0,
      getErrorMessage(error)
    );
    throw error;
  }
}

/**
 * Get composition by ID
 */
export async function getComposition(id: string): Promise<IComposition | null> {
  return Composition.findById(id);
}

/**
 * List compositions
 */
export async function listCompositions(limit = 50): Promise<IComposition[]> {
  return Composition.find().sort({ createdAt: -1 }).limit(limit);
}

/**
 * Delete composition
 */
export async function deleteComposition(id: string): Promise<boolean> {
  const composition = await Composition.findById(id);
  if (!composition) return false;

  // Note: Could also delete S3 files here

  await Composition.findByIdAndDelete(id);
  return true;
}

/**
 * Regenerate composition video using existing speech files
 * This saves ElevenLabs API costs by reusing already generated audio
 * @param compositionId - The ID of the composition to regenerate
 * @param customDelays - Optional array of custom delays (in seconds) for each dialogue line
 * @param subtitlePosition - Optional subtitle position override
 */
export async function regenerateComposition(
  compositionId: string,
  customDelays?: number[],
  subtitlePosition?: "top" | "center" | "bottom"
): Promise<IComposition> {
  const composition = await Composition.findById(compositionId).populate({
    path: "template",
    populate: {
      path: "characters",
    },
  });

  if (!composition) {
    throw new Error("Composition not found");
  }

  // Verify all speech files exist
  const missingAudio = composition.generatedScript.filter((s) => !s.speechUrl);
  if (missingAudio.length > 0) {
    throw new Error(
      `Missing speech files for ${missingAudio.length} dialogue lines. Cannot regenerate.`
    );
  }

  // Cast populated template
  const template = composition.template as unknown as PopulatedTemplate;
  const characters = template.characters as ICharacter[];

  // Reset status
  composition.status = "compositing";
  composition.progress = 10;
  composition.error = undefined;

  // Update subtitle position if provided
  if (subtitlePosition) {
    composition.subtitlePosition = subtitlePosition;
  }

  await composition.save();

  // Start async regeneration
  regenerateCompositionAsync(composition, characters, customDelays).catch(
    async (error: unknown) => {
      console.error("Composition regeneration failed:", error);
      composition.status = "failed";
      composition.error = getErrorMessage(error);
      await composition.save();
    }
  );

  return composition;
}

/**
 * Async regeneration process - reuses existing speech files
 */
async function regenerateCompositionAsync(
  composition: IComposition,
  characters: ICharacter[],
  customDelays?: number[]
): Promise<void> {
  const compositionId = composition._id.toString();
  const template = composition.template as unknown as PopulatedTemplate;

  try {
    // Apply custom delays if provided
    if (customDelays && customDelays.length > 0) {
      for (let i = 0; i < composition.generatedScript.length; i++) {
        if (i < customDelays.length && customDelays[i] !== undefined) {
          composition.generatedScript[i].delay = customDelays[i];
        }
      }
    }

    // Recalculate start times based on delays and durations
    let currentTime = 0;
    for (const line of composition.generatedScript) {
      currentTime += line.delay;
      line.startTime = currentTime;
      currentTime += line.duration;
    }

    await composition.save();
    await updateCompositionStatus(compositionId, "compositing", 20);

    // Download audio files from S3 to local
    await ensureDir(config.processingPath);
    const audioSegments: {
      characterId: string;
      text: string;
      audioPath: string;
      startTime: number;
      duration: number;
    }[] = [];

    for (let i = 0; i < composition.generatedScript.length; i++) {
      const line = composition.generatedScript[i];
      const character = characters.find(
        (c) => c._id.toString() === line.character.toString()
      );

      if (!character || !line.speechUrl) continue;

      // Download audio from S3
      const audioPath = join(
        config.processingPath,
        `regen_audio_${compositionId}_${i}.mp3`
      );
      const response = await fetch(line.speechUrl);
      const arrayBuffer = await response.arrayBuffer();
      const { writeFile } = await import("node:fs/promises");
      await writeFile(audioPath, Buffer.from(arrayBuffer));

      audioSegments.push({
        characterId: character._id.toString(),
        text: line.text,
        audioPath,
        startTime: line.startTime,
        duration: line.duration,
      });
    }

    console.log(`📥 Downloaded ${audioSegments.length} audio files from S3`);
    await updateCompositionStatus(compositionId, "compositing", 35);

    // Apply character overlays
    const templateVideoPath = template.videoUrl;
    const videoSegments = audioSegments.map((seg) => {
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

    const videoWithOverlays = await applyCharacterOverlays(
      templateVideoPath,
      videoSegments
    );
    await updateCompositionStatus(compositionId, "compositing", 50);

    // Merge audio tracks
    const videoWithAudio = await mergeAudioTracks(
      videoWithOverlays,
      audioSegments
    );
    await updateCompositionStatus(compositionId, "adding_subtitles", 65);

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
      `${compositionId}_regen`
    );
    composition.subtitlesUrl = subtitlesUrl;

    const videoWithSubtitles = await addSubtitlesToVideo(
      videoWithAudio,
      srtContent,
      undefined,
      composition.subtitlePosition || "bottom"
    );
    await updateCompositionStatus(compositionId, "uploading", 80);

    // Finalize and upload
    const outputFilename = generateFilename(
      `${composition.title.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_regen`,
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

    composition.outputUrl = outputUrl;
    composition.status = "completed";
    composition.progress = 100;
    await composition.save();

    // Cleanup temp files
    const filesToClean = [
      finalOutputPath,
      videoWithOverlays,
      videoWithAudio,
      videoWithSubtitles,
      ...audioSegments.map((seg) => seg.audioPath),
    ];

    await cleanupFiles(filesToClean);
    console.log(`🧹 Cleaned up ${filesToClean.length} temporary files`);

    console.log(`🔄 Composition regenerated: ${composition._id}`);
  } catch (error: unknown) {
    console.error(`Composition regeneration ${compositionId} failed:`, error);
    composition.status = "failed";
    composition.error = getErrorMessage(error);
    await composition.save();
    throw error;
  }
}
