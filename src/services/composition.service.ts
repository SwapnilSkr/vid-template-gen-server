import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  Composition,
  type IComposition,
  type ICharacter,
  type ITemplate,
  type ICharacterPosition,
  type ScreenType,
} from "../models";
import { generateScript } from "./ai.service";
import { generateSpeech } from "./elevenlabs.service";
import { uploadAudio, deleteFromS3 } from "./s3.service";
import { calculateDialogueTiming } from "./subtitle.service";
import { getTemplate } from "./template.service";
import { ensureDir, cleanupFiles } from "../utils";
import { config } from "../config";
import { getErrorMessage } from "../types";
import {
  recalculateTimings,
  processVideoWithAudioAndSubtitles,
} from "../helpers/composition.helper";

// ============================================
// Types
// ============================================

/**
 * Populated template type - when template is populated via Mongoose
 */
interface PopulatedTemplate extends Omit<ITemplate, "characters"> {
  characters: ICharacter[];
}

/**
 * Create composition options
 */
interface CreateCompositionOptions {
  templateId: string;
  plot: string;
  title?: string;
  screenType?: ScreenType;
  subtitlePosition?: "top" | "center" | "bottom";
  characterPositions?: Map<string, ICharacterPosition>;
}

/**
 * Regenerate composition options
 */
interface RegenerateCompositionOptions {
  compositionId: string;
  delays?: number[];
  screenType?: ScreenType;
  subtitlePosition?: "top" | "center" | "bottom";
  characterPositions?: Map<string, ICharacterPosition>;
}

// ============================================
// Default Position Constants
// ============================================

/**
 * Default character position based on screen type and character index
 * Mobile uses a universal 9:16 aspect ratio optimized positioning
 * Desktop uses a standard 16:9 aspect ratio positioning
 */
function getDefaultCharacterPosition(
  screenType: ScreenType,
  characterIndex: number,
  totalCharacters: number
): ICharacterPosition {
  // For mobile (9:16 portrait), characters positioned at bottom
  if (screenType === "mobile") {
    // Spread characters horizontally at bottom
    const xPositions =
      totalCharacters === 1
        ? [50]
        : totalCharacters === 2
        ? [25, 75]
        : [15, 50, 85];

    return {
      x: xPositions[characterIndex % xPositions.length],
      y: 85,
      scale: 0.3,
      anchor: "bottom-left" as const,
    };
  }

  // For desktop (16:9 landscape), characters positioned at bottom corners
  const xPositions =
    totalCharacters === 1
      ? [50]
      : totalCharacters === 2
      ? [10, 90]
      : [10, 50, 90];

  return {
    x: xPositions[characterIndex % xPositions.length],
    y: 90,
    scale: 0.25,
    anchor: "bottom-left" as const,
  };
}

/**
 * Generate default character positions for all template characters
 */
function generateDefaultCharacterPositions(
  characters: ICharacter[],
  screenType: ScreenType
): Map<string, ICharacterPosition> {
  const positions = new Map<string, ICharacterPosition>();

  characters.forEach((character, index) => {
    positions.set(
      character._id.toString(),
      getDefaultCharacterPosition(screenType, index, characters.length)
    );
  });

  return positions;
}

// ============================================
// Composition Service Functions
// ============================================

/**
 * Create a new composition from plot
 */
export async function createComposition(
  options: CreateCompositionOptions
): Promise<IComposition> {
  const {
    templateId,
    plot,
    title,
    screenType = "mobile",
    subtitlePosition = "bottom",
    characterPositions,
  } = options;

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

  // Populate characters to generate default positions
  const populatedTemplate = await template.populate<{
    characters: ICharacter[];
  }>("characters");
  const characters = populatedTemplate.characters;

  // Generate default positions based on screen type
  const defaultPositions = generateDefaultCharacterPositions(
    characters,
    screenType
  );

  // Merge provided positions with defaults (provided takes precedence)
  const finalPositions = new Map(defaultPositions);
  if (characterPositions) {
    characterPositions.forEach((pos, charId) => {
      finalPositions.set(charId, pos);
    });
  }

  // Create composition record
  const composition = new Composition({
    template: templateId,
    title: title || "Generating...",
    plot,
    screenType,
    characterPositions: finalPositions,
    subtitlePosition,
    status: "pending",
    progress: 0,
    generatedScript: [],
  });

  await composition.save();
  console.log(
    `🎬 Created composition: ${composition._id} (${screenType} mode)`
  );

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
    recalculateTimings(composition.generatedScript, audioSegments);

    await composition.save();

    // Step 3: Process video with audio and subtitles
    await updateCompositionStatus(compositionId, "compositing", 45);

    const templateVideoPath = template.videoUrl;

    const { outputUrl, subtitlesUrl, tempFiles } =
      await processVideoWithAudioAndSubtitles(
        compositionId,
        composition,
        templateVideoPath,
        audioSegments,
        characters
      );

    composition.outputUrl = outputUrl;
    composition.subtitlesUrl = subtitlesUrl;
    composition.status = "completed";
    composition.progress = 100;
    await composition.save();

    // Cleanup all temp files
    const filesToClean = [
      ...tempFiles,
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
 */
export async function regenerateComposition(
  options: RegenerateCompositionOptions
): Promise<IComposition> {
  const {
    compositionId,
    delays,
    screenType,
    subtitlePosition,
    characterPositions,
  } = options;

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

  // Update screen type if provided
  if (screenType && screenType !== composition.screenType) {
    composition.screenType = screenType;

    // Regenerate default positions for new screen type
    const newDefaultPositions = generateDefaultCharacterPositions(
      characters,
      screenType
    );
    composition.characterPositions = newDefaultPositions;
  }

  // Merge character position overrides if provided
  if (characterPositions) {
    characterPositions.forEach((pos, charId) => {
      composition.characterPositions.set(charId, pos);
    });
  }

  // Update subtitle position if provided
  if (subtitlePosition) {
    composition.subtitlePosition = subtitlePosition;
  }

  await composition.save();

  // Start async regeneration
  regenerateCompositionAsync(composition, characters, delays).catch(
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

    // Delete old S3 files to save storage costs
    const oldFilesToDelete: string[] = [];
    if (composition.outputUrl) {
      oldFilesToDelete.push(composition.outputUrl);
    }
    if (composition.subtitlesUrl) {
      oldFilesToDelete.push(composition.subtitlesUrl);
    }

    for (const fileUrl of oldFilesToDelete) {
      try {
        await deleteFromS3(fileUrl);
        console.log(`🗑️  Deleted old file from S3: ${fileUrl}`);
      } catch (error) {
        console.warn(`Failed to delete old file: ${fileUrl}`, error);
      }
    }

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

    // Process video with audio and subtitles
    const templateVideoPath = template.videoUrl;

    console.log(
      `🎬 Regenerating with screenType: ${composition.screenType}, subtitlePosition: ${composition.subtitlePosition}`
    );

    const { outputUrl, subtitlesUrl, tempFiles } =
      await processVideoWithAudioAndSubtitles(
        compositionId,
        composition,
        templateVideoPath,
        audioSegments,
        characters,
        "regen"
      );

    composition.outputUrl = outputUrl;
    composition.subtitlesUrl = subtitlesUrl;
    composition.status = "completed";
    composition.progress = 100;
    await composition.save();

    // Cleanup temp files
    const filesToClean = [
      ...tempFiles,
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
