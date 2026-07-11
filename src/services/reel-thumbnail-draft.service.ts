import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { config } from "../config";
import { Reel, type IReel } from "../models";
import { cleanupDirectory, ensureDir } from "../utils";
import {
  buildReelReviewPackage,
  composeThumbnailImage,
  replaceReviewThumbnail,
  type CustomThumbnailInput,
} from "./reel-review.service";

// ============================================
// Thumbnail Studio drafts — a locally staged thumbnail composition per reel.
// Mirrors the editDraft lifecycle discipline: exactly one draft dir per reel
// (restaging wipes the previous one), nothing goes to S3 until save, and
// save/discard/reel-delete all remove the local files so neither the storage
// folder nor the S3 bucket accumulates abandoned experiments.
// ============================================

const ACTIVE_STATUSES: IReel["status"][] = [
  "planning",
  "generating_assets",
  "generating_audio",
  "aligning",
  "rendering",
  "uploading",
];

function localAssetUrl(draftId: string, filename: string): string {
  return `/api/reels/thumb-drafts/${encodeURIComponent(draftId)}/assets/${encodeURIComponent(filename)}`;
}

async function loadReel(reelId: string): Promise<IReel> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  return reel;
}

function assertEditable(reel: IReel): void {
  if (ACTIVE_STATUSES.includes(reel.status)) {
    throw new Error(`Cannot edit the thumbnail while generation is active (status: ${reel.status})`);
  }
}

/** Remove the staged files and unset the draft on the doc (not saved here). */
export async function cleanupThumbnailDraft(reel: IReel): Promise<void> {
  if (reel.thumbnailDraft?.rootDir) {
    await cleanupDirectory(reel.thumbnailDraft.rootDir).catch((error) => {
      console.warn(`Could not clean thumbnail draft ${reel.thumbnailDraft?.id}:`, error);
    });
  }
  reel.thumbnailDraft = undefined;
  reel.markModified("thumbnailDraft");
}

/** Compose the thumbnail from the studio controls and stage it locally.
 *  Replaces any previously staged draft; S3 is untouched. */
export async function stageThumbnailDraft(
  reelId: string,
  input: CustomThumbnailInput
): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertEditable(reel);

  await cleanupThumbnailDraft(reel);
  const draftId = randomUUID();
  const rootDir = join(config.processingPath, "thumb-drafts", reelId, draftId);
  await ensureDir(rootDir);
  const imagePath = join(rootDir, "thumbnail.png");

  try {
    await composeThumbnailImage(reel, input, imagePath);
  } catch (error) {
    await cleanupDirectory(rootDir).catch(() => {});
    throw error;
  }

  reel.thumbnailDraft = {
    id: draftId,
    rootDir,
    imagePath,
    imageUrl: localAssetUrl(draftId, basename(imagePath)),
    input: { ...input } as Record<string, unknown>,
    aspectRatio: input.aspectRatio ?? "16:9",
    createdAt: new Date(),
  };
  await reel.save();
  return reel;
}

const MAX_STAGED_IMAGE_BYTES = 12 * 1024 * 1024;
const PNG_MAGIC = 0x89504e47;

/** Stage a client-rendered Thumbnail Studio canvas export. The PNG is already
 *  composed in the browser (true WYSIWYG); the opaque editor state rides along
 *  in draft.input so the studio can restore the full layer stack next visit. */
export async function stageThumbnailDraftImage(
  reelId: string,
  input: {
    imageDataUrl: string;
    aspectRatio?: "16:9" | "9:16" | "1:1";
    editorState?: Record<string, unknown>;
  }
): Promise<IReel> {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(input.imageDataUrl);
  if (!match) throw new Error("imageDataUrl must be a base64 PNG data URL");
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== PNG_MAGIC) {
    throw new Error("imageDataUrl does not decode to a PNG");
  }
  if (bytes.length > MAX_STAGED_IMAGE_BYTES) {
    throw new Error("Thumbnail image is too large (max 12MB)");
  }

  const reel = await loadReel(reelId);
  assertEditable(reel);

  await cleanupThumbnailDraft(reel);
  const draftId = randomUUID();
  const rootDir = join(config.processingPath, "thumb-drafts", reelId, draftId);
  await ensureDir(rootDir);
  const imagePath = join(rootDir, "thumbnail.png");
  await Bun.write(imagePath, bytes);

  reel.thumbnailDraft = {
    id: draftId,
    rootDir,
    imagePath,
    imageUrl: localAssetUrl(draftId, basename(imagePath)),
    input: input.editorState ? { ...input.editorState } : undefined,
    aspectRatio: input.aspectRatio ?? "16:9",
    createdAt: new Date(),
  };
  await reel.save();
  return reel;
}

/** Upload the staged draft PNG to S3 as the review thumbnail (deleting the
 *  object it replaces) and remove the local staging dir. */
export async function saveThumbnailDraft(reelId: string): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertEditable(reel);
  const draft = reel.thumbnailDraft;
  if (!draft?.imagePath || !(await Bun.file(draft.imagePath).exists())) {
    throw new Error("No staged thumbnail draft to save");
  }

  const current = reel.review ?? (await buildReelReviewPackage(reel));
  await replaceReviewThumbnail(
    reel,
    { ...current, thumbnailEditorState: draft.input ? { ...draft.input } : current.thumbnailEditorState },
    draft.imagePath,
  );
  await cleanupThumbnailDraft(reel);
  await reel.save();
  return reel;
}

/** Drop the staged draft without touching the saved thumbnail. */
export async function discardThumbnailDraft(reelId: string): Promise<IReel> {
  const reel = await loadReel(reelId);
  await cleanupThumbnailDraft(reel);
  await reel.save();
  return reel;
}

/** Resolve a staged draft file for serving, 404ing cleanly when the draft was
 *  superseded/discarded while a client still holds the old URL. */
export async function getThumbnailDraftAssetPath(draftId: string, filename: string): Promise<string> {
  const reel = await Reel.findOne({ "thumbnailDraft.id": draftId });
  if (!reel?.thumbnailDraft) throw new Error("Thumbnail draft not found");
  if (basename(reel.thumbnailDraft.imagePath) !== filename) {
    throw new Error("Thumbnail draft asset not found");
  }
  const path = join(reel.thumbnailDraft.rootDir, filename);
  if (!(await Bun.file(path).exists())) throw new Error("Thumbnail draft asset not available yet");
  return path;
}
