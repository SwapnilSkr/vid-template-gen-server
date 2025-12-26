import { join } from "node:path";
import { readFile, unlink } from "node:fs/promises";
import {
  Composition,
  type IComposition,
  Template,
  Character,
  type ICharacter,
} from "../models";
import { generateScript, type GeneratedScript } from "./ai.service";
import { generateSpeech } from "./elevenlabs.service";
import {
  applyCharacterOverlays,
  mergeAudioTracks,
  finalizeVideo,
  addSubtitlesToVideo,
} from "./ffmpeg.service";
import { uploadToS3, uploadSubtitles } from "./s3.service";
import {
  generateSrtContent,
  calculateDialogueTiming,
} from "./subtitle.service";
import { getTemplate } from "./template.service";
import { ensureDir, generateFilename } from "../utils";
import { config } from "../config";

/**
 * Create a new composition from plot
 */
export async function createComposition(
  templateId: string,
  plot: string,
  title?: string
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
    status: "pending",
    progress: 0,
    generatedScript: [],
  });

  await composition.save();
  console.log(`🎬 Created composition: ${composition._id}`);

  // Start async processing
  processComposition(composition._id.toString()).catch((error) => {
    console.error("Composition processing failed:", error);
    updateCompositionStatus(
      composition._id.toString(),
      "failed",
      0,
      error.message
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
  const composition = await Composition.findById(compositionId).populate(
    "template"
  );
  if (!composition) throw new Error("Composition not found");

  const template = composition.template as any;
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
      const character = characters.find((c) =>
        c.name.toLowerCase() === d.text
          ? false
          : c.name.toLowerCase() ===
            generatedScript.dialogues
              .find((gd) => gd.text === d.text)
              ?.characterName.toLowerCase()
      );
      const matchedDialogue = generatedScript.dialogues.find(
        (gd) => gd.text === d.text
      );
      const char = characters.find(
        (c) =>
          c.name.toLowerCase() === matchedDialogue?.characterName.toLowerCase()
      );

      return {
        character: char?._id || characters[0]._id,
        text: d.text,
        startTime: d.startTime,
        duration: d.duration,
      };
    });

    await composition.save();
    await updateCompositionStatus(compositionId, "generating_audio", 15);

    // Step 2: Generate audio for each dialogue
    await ensureDir(config.processingPath);
    const audioSegments: Array<{
      characterId: string;
      text: string;
      audioPath: string;
      startTime: number;
      duration: number;
    }> = [];

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

      audioSegments.push({
        characterId: character._id.toString(),
        text: line.text,
        audioPath,
        startTime: line.startTime,
        duration,
      });

      // Update line duration with actual audio duration
      line.duration = duration;

      const progress =
        15 + Math.round(((i + 1) / composition.generatedScript.length) * 25);
      await updateCompositionStatus(
        compositionId,
        "generating_audio",
        progress
      );
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
          x: 50,
          y: 75,
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
      srtContent
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

    // Cleanup temp files
    await unlink(finalOutputPath).catch(() => {});

    console.log(`🎉 Composition complete: ${composition._id}`);
  } catch (error: any) {
    console.error(`Composition ${compositionId} failed:`, error);
    await updateCompositionStatus(compositionId, "failed", 0, error.message);
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
export async function listCompositions(
  limit: number = 50
): Promise<IComposition[]> {
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
