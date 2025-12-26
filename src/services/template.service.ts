import { v4 as uuidv4 } from "uuid";
import { join } from "node:path";
import { writeFile, readFile, unlink, readdir } from "node:fs/promises";
import { config } from "../config";
import type { VideoTemplate } from "../types";
import { getVideoMetadata, extractThumbnail } from "./ffmpeg.service";
import { ensureDir, fileExists, generateFilename } from "../utils";

// In-memory template storage (could be replaced with DB)
const templates = new Map<string, VideoTemplate>();
const TEMPLATES_JSON = "templates.json";

/**
 * Load templates from disk on startup
 */
export async function loadTemplates(): Promise<void> {
  try {
    const filePath = join(config.templatesPath, TEMPLATES_JSON);
    if (await fileExists(filePath)) {
      const data = await readFile(filePath, "utf-8");
      const loaded = JSON.parse(data) as VideoTemplate[];
      for (const template of loaded) {
        template.createdAt = new Date(template.createdAt);
        templates.set(template.id, template);
      }
      console.log(`📂 Loaded ${templates.size} templates`);
    }
  } catch (error) {
    console.warn("Could not load templates:", error);
  }
}

/**
 * Save templates to disk
 */
async function saveTemplates(): Promise<void> {
  const filePath = join(config.templatesPath, TEMPLATES_JSON);
  const data = JSON.stringify(Array.from(templates.values()), null, 2);
  await writeFile(filePath, data);
}

/**
 * Create a new template from uploaded video
 */
export async function createTemplate(
  videoBuffer: Buffer,
  filename: string,
  name: string,
  description: string = ""
): Promise<VideoTemplate> {
  await ensureDir(config.templatesPath);

  const id = uuidv4();
  const ext = filename.split(".").pop() || "mp4";
  const videoFilename = `${id}.${ext}`;
  const filePath = join(config.templatesPath, videoFilename);

  // Save video file
  await writeFile(filePath, videoBuffer);

  // Get video metadata
  const metadata = await getVideoMetadata(filePath);

  // Generate thumbnail
  let thumbnailPath: string | undefined;
  try {
    const thumbFilename = `${id}_thumb.jpg`;
    thumbnailPath = join(config.templatesPath, thumbFilename);
    await extractThumbnail(filePath, thumbnailPath);
  } catch (error) {
    console.warn("Could not generate thumbnail:", error);
  }

  const template: VideoTemplate = {
    id,
    name,
    description,
    filePath,
    duration: metadata.duration,
    width: metadata.width,
    height: metadata.height,
    frameRate: metadata.frameRate,
    createdAt: new Date(),
    thumbnailPath,
  };

  templates.set(id, template);
  await saveTemplates();

  console.log(
    `📹 Created template: ${name} (${metadata.duration.toFixed(1)}s)`
  );

  return template;
}

/**
 * Get a template by ID
 */
export function getTemplate(id: string): VideoTemplate | undefined {
  return templates.get(id);
}

/**
 * List all templates
 */
export function listTemplates(): VideoTemplate[] {
  return Array.from(templates.values()).sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  );
}

/**
 * Delete a template
 */
export async function deleteTemplate(id: string): Promise<boolean> {
  const template = templates.get(id);
  if (!template) return false;

  // Delete video file
  try {
    await unlink(template.filePath);
    if (template.thumbnailPath) {
      await unlink(template.thumbnailPath);
    }
  } catch (error) {
    console.warn("Could not delete template files:", error);
  }

  templates.delete(id);
  await saveTemplates();

  console.log(`🗑️  Deleted template: ${id}`);

  return true;
}
