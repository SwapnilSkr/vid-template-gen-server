import { mkdir, stat, unlink, readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { config } from "../config";

/**
 * Ensure a directory exists, creating it if necessary
 */
export async function ensureDir(dirPath: string): Promise<void> {
  try {
    await mkdir(dirPath, { recursive: true });
  } catch (error: any) {
    if (error.code !== "EEXIST") throw error;
  }
}

/**
 * Check if a file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get file size in bytes
 */
export async function getFileSize(filePath: string): Promise<number> {
  const stats = await stat(filePath);
  return stats.size;
}

/**
 * Delete a file if it exists
 */
export async function deleteFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
}

/**
 * Generate a unique filename
 */
export function generateFilename(prefix: string, extension: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${timestamp}_${random}.${extension}`;
}

/**
 * Get file extension from filename
 */
export function getExtension(filename: string): string {
  return extname(filename).toLowerCase().slice(1);
}

/**
 * List files in a directory
 */
export async function listFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Initialize storage directories
 */
export async function initializeStorage(): Promise<void> {
  await Promise.all([
    ensureDir(config.templatesPath),
    ensureDir(config.charactersPath),
    ensureDir(config.processingPath),
    ensureDir(config.outputPath),
  ]);
  console.log("📁 Storage directories initialized");
}
