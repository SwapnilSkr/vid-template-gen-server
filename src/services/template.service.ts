import { Template, type ITemplate, Character } from "../models";
import { uploadVideo, uploadImage, deleteFromS3 } from "./s3.service";
import { getVideoMetadata } from "./ffmpeg.service";
import { ensureDir } from "../utils";
import { config } from "../config";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * Create a new template from uploaded video
 */
/**
 * Create a new template from uploaded video
 */
export async function createTemplate(
  videoUrl: string,
  name: string,
  description: string = ""
): Promise<ITemplate> {
  try {
    // Get video metadata from URL (ffprobe supports URLs)
    const metadata = await getVideoMetadata(videoUrl);

    // Create template in DB
    const template = new Template({
      name,
      description,
      videoUrl,
      duration: metadata.duration,
      dimensions: {
        width: metadata.width,
        height: metadata.height,
      },
      frameRate: metadata.frameRate,
      characters: [],
    });

    await template.save();

    console.log(
      `📹 Created template: ${name} (${metadata.duration.toFixed(1)}s)`
    );

    return template;
  } catch (error: any) {
    console.error(`Failed to create template: ${error.message}`);
    throw error;
  }
}

/**
 * Get a template by ID
 */
export async function getTemplate(id: string): Promise<ITemplate | null> {
  return Template.findById(id);
}

/**
 * List all templates
 */
export async function listTemplates(): Promise<ITemplate[]> {
  return Template.find().sort({ createdAt: -1 });
}

/**
 * Add characters to a template
 */
export async function addCharactersToTemplate(
  templateId: string,
  characterIds: string[]
): Promise<ITemplate | null> {
  const template = await Template.findById(templateId);
  if (!template) return null;

  // Verify characters exist
  const characters = await Character.find({ _id: { $in: characterIds } });
  if (characters.length !== characterIds.length) {
    throw new Error("Some characters not found");
  }

  // Add unique characters
  const existingIds = new Set(template.characters.map((c) => c.toString()));
  for (const id of characterIds) {
    if (!existingIds.has(id)) {
      template.characters.push(id as any);
    }
  }

  await template.save();
  return Template.findById(templateId); // Re-fetch to populate
}

/**
 * Remove characters from a template
 */
export async function removeCharactersFromTemplate(
  templateId: string,
  characterIds: string[]
): Promise<ITemplate | null> {
  const template = await Template.findById(templateId);
  if (!template) return null;

  const removeSet = new Set(characterIds);
  template.characters = template.characters.filter(
    (c) => !removeSet.has(c.toString())
  );

  await template.save();
  return Template.findById(templateId);
}

/**
 * Update a template
 */
export async function updateTemplate(
  id: string,
  updates: Partial<{
    name: string;
    description: string;
    videoUrl: string;
    thumbnailUrl: string;
  }>
): Promise<ITemplate | null> {
  const existing = await Template.findById(id);
  if (!existing) return null;

  // If updating video, delete old one and get new metadata
  if (updates.videoUrl && updates.videoUrl !== existing.videoUrl) {
    await deleteFromS3(existing.videoUrl).catch(console.error);
    const metadata = await getVideoMetadata(updates.videoUrl);
    (updates as any).duration = metadata.duration;
    (updates as any).dimensions = {
      width: metadata.width,
      height: metadata.height,
    };
    (updates as any).frameRate = metadata.frameRate;
  }

  // If updating thumbnail, delete old one
  if (updates.thumbnailUrl && updates.thumbnailUrl !== existing.thumbnailUrl) {
    if (existing.thumbnailUrl) {
      await deleteFromS3(existing.thumbnailUrl).catch(console.error);
    }
  }

  return Template.findByIdAndUpdate(id, { $set: updates }, { new: true });
}

/**
 * Delete a template
 */
export async function deleteTemplate(id: string): Promise<boolean> {
  const template = await Template.findById(id);
  if (!template) return false;

  // Delete from S3
  if (template.videoUrl) {
    await deleteFromS3(template.videoUrl).catch(console.error);
  }
  if (template.thumbnailUrl) {
    await deleteFromS3(template.thumbnailUrl).catch(console.error);
  }

  await Template.findByIdAndDelete(id);
  console.log(`🗑️  Deleted template: ${id}`);

  return true;
}
