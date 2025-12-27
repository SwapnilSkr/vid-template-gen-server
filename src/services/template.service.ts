import { Template, type ITemplate, Character } from "../models";
import { uploadVideo, deleteFromS3 } from "./s3.service";
import { getVideoMetadata, trimVideo } from "./ffmpeg.service";
import { unlink, readFile } from "node:fs/promises";

/**
 * High-level service to process and create a template
 */
export async function createTemplateWithProcessing(
  localPath: string,
  data: { name: string; description: string; originalName: string },
  options: { trimStart?: number; keepDuration?: number }
): Promise<ITemplate> {
  let processedPath: string | null = null;

  try {
    const { trimStart, keepDuration } = options;
    let finalVideoUrl: string;

    // 1. Process video if needed
    if ((trimStart && trimStart > 0) || (keepDuration && keepDuration > 0)) {
      console.log(`✂️  Processing video in service...`);
      processedPath = await trimVideo(localPath, { trimStart, keepDuration });

      const buffer = await readFile(processedPath);
      finalVideoUrl = await uploadVideo(
        buffer,
        "templates",
        `processed_${Date.now()}.mp4`
      );
    } else {
      // Direct upload
      const buffer = await readFile(localPath);
      finalVideoUrl = await uploadVideo(buffer, "templates", data.originalName);
    }

    // 2. Create record in DB
    return await createTemplate(finalVideoUrl, data.name, data.description);
  } finally {
    // Cleanup local files
    await unlink(localPath).catch(() => {});
    if (processedPath) await unlink(processedPath).catch(() => {});
  }
}

/**
 * High-level service to process and update a template
 */
export async function updateTemplateWithProcessing(
  id: string,
  data: {
    name?: string;
    description?: string;
    localPath?: string;
    originalName?: string;
  },
  options: { trimStart?: number; keepDuration?: number }
): Promise<ITemplate | null> {
  const { localPath, name, description, originalName } = data;
  const { trimStart, keepDuration } = options;
  let processedPath: string | null = null;

  try {
    const updates: any = { name, description };

    if (localPath) {
      let finalVideoUrl: string;

      if ((trimStart && trimStart > 0) || (keepDuration && keepDuration > 0)) {
        processedPath = await trimVideo(localPath, { trimStart, keepDuration });
        const buffer = await readFile(processedPath);
        finalVideoUrl = await uploadVideo(
          buffer,
          "templates",
          `processed_${Date.now()}.mp4`
        );
      } else {
        const buffer = await readFile(localPath);
        finalVideoUrl = await uploadVideo(
          buffer,
          "templates",
          originalName || "updated_video.mp4"
        );
      }
      updates.videoUrl = finalVideoUrl;
    }

    return await updateTemplate(id, updates);
  } finally {
    if (localPath) await unlink(localPath).catch(() => {});
    if (processedPath) await unlink(processedPath).catch(() => {});
  }
}

/**
 * Create a new template record in DB
 */
export async function createTemplate(
  videoUrl: string,
  name: string,
  description: string = ""
): Promise<ITemplate> {
  try {
    const metadata = await getVideoMetadata(videoUrl);

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
      `📹 Created template: ${name} (${metadata.duration?.toFixed(1) || "?"}s)`
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

  const characters = await Character.find({ _id: { $in: characterIds } });
  if (characters.length !== characterIds.length) {
    throw new Error("Some characters not found");
  }

  const existingIds = new Set(template.characters.map((c) => c.toString()));
  for (const id of characterIds) {
    if (!existingIds.has(id)) {
      template.characters.push(id as any);
    }
  }

  await template.save();
  return Template.findById(templateId);
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
 * Update a template record in DB
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
