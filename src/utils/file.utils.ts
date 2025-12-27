import { mkdir, stat, unlink, readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { config } from "../config";
import { isNodeError } from "../types";

/**
 * Ensure a directory exists, creating it if necessary
 */
export async function ensureDir(dirPath: string): Promise<void> {
  try {
    await mkdir(dirPath, { recursive: true });
  } catch (error: unknown) {
    if (isNodeError(error) && error.code !== "EEXIST") throw error;
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
  } catch (error: unknown) {
    if (isNodeError(error) && error.code !== "ENOENT") throw error;
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
  await ensureDir(config.processingPath);
  console.log("📁 Storage directories initialized");
}

/**
 * Bun.write function signature for type safety
 */
declare const Bun:
  | {
      write: (
        path: string,
        data: File | Blob | ArrayBuffer | string
      ) => Promise<number>;
    }
  | undefined;

/**
 * Save a File object to disk
 */
export async function saveFileToDisk(
  file: File,
  prefix: string
): Promise<string> {
  const extension = getExtension(file.name) || "mp4";
  const filename = generateFilename(prefix, extension);
  const filePath = join(config.processingPath, filename);

  await ensureDir(config.processingPath);

  // Use Bun.write for efficiency if available (in Bun environment)
  // Otherwise use Node stream-based approach
  if (typeof Bun !== "undefined" && Bun) {
    await Bun.write(filePath, file);
  } else {
    const buffer = Buffer.from(await file.arrayBuffer());
    const { writeFile } = await import("node:fs/promises");
    await writeFile(filePath, buffer);
  }

  return filePath;
}
