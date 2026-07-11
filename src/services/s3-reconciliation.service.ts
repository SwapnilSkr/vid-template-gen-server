import { Reel, Composition } from "../models";
import { listKeysWithMeta, deleteKey, type S3Folder } from "./s3.service";
import { getErrorMessage } from "../types";

// ============================================
// S3 reconciliation — the safety net a field-based cascading delete can never
// be: if a render uploads an asset to S3 and then crashes/stalls before the
// URL is saved back to the Reel/Composition doc, that object has zero trace
// in Mongo. deleteReel()'s cascade can only delete what's *recorded* on the
// doc it's given — it can't find what was never recorded anywhere.
//
// This sweeps the folders that hold per-reel/per-composition generated
// output and deletes anything not referenced by ANY current Reel or
// Composition document, with an age safety margin so it never races an
// in-flight render. Deliberately excludes "voice-samples/" (permanent cross-
// reel cache, not tied to any doc), "gameplay/" (persistent clip pool),
// "templates/" and "characters/" (legacy library assets, out of scope here).
// ============================================

const SWEEP_FOLDERS: S3Folder[] = ["reels", "compositions", "audio", "subtitles"];
const MIN_AGE_MS = 2 * 60 * 60 * 1000; // 2h — anything newer might belong to an in-flight render

function keyFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const parts = url.split(".amazonaws.com/");
  return parts.length >= 2 ? parts[1] : undefined;
}

/** Every S3 key currently referenced by a live Reel or Composition document. */
async function referencedKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  const addUrl = (url?: string) => {
    const key = keyFromUrl(url);
    if (key) keys.add(key);
  };

  const reels = await Reel.find(
    {},
    {
      outputUrl: 1,
      bodyVideoUrl: 1,
      assemblyVideoUrl: 1,
      subtitlesUrl: 1,
      titleAudioUrl: 1,
      partOutroAudioUrl: 1,
      outroAudioUrl: 1,
      "review.thumbnailUrl": 1,
      scenes: 1,
      voiceVariants: 1,
    }
  );
  for (const reel of reels) {
    addUrl(reel.outputUrl);
    addUrl(reel.bodyVideoUrl);
    addUrl(reel.assemblyVideoUrl);
    addUrl(reel.subtitlesUrl);
    addUrl(reel.titleAudioUrl);
    addUrl(reel.partOutroAudioUrl);
    addUrl(reel.outroAudioUrl);
    addUrl(reel.review?.thumbnailUrl);
    for (const scene of reel.scenes) {
      addUrl(scene.assetUrl);
      addUrl(scene.audioUrl);
    }
    for (const variant of reel.voiceVariants) addUrl(variant.videoUrl);
  }

  const compositions = await Composition.find({}, { outputUrl: 1, subtitlesUrl: 1, generatedScript: 1 });
  for (const composition of compositions) {
    addUrl(composition.outputUrl);
    addUrl(composition.subtitlesUrl);
    for (const line of composition.generatedScript) addUrl(line.speechUrl);
  }

  return keys;
}

export interface ReconciliationResult {
  scanned: number;
  orphaned: string[];
  deleted: string[];
  skippedRecent: number;
  errors: { key: string; error: string }[];
}

/** Find (and optionally delete) S3 objects under the reel/composition output
 * folders that no current document references. `dryRun` (default true in
 * the script, false here) just reports what WOULD be deleted. */
export async function reconcileS3Assets(dryRun: boolean): Promise<ReconciliationResult> {
  const referenced = await referencedKeys();
  const cutoff = Date.now() - MIN_AGE_MS;
  const result: ReconciliationResult = {
    scanned: 0,
    orphaned: [],
    deleted: [],
    skippedRecent: 0,
    errors: [],
  };

  for (const folder of SWEEP_FOLDERS) {
    const objects = await listKeysWithMeta(`${folder}/`);
    result.scanned += objects.length;

    for (const { key, lastModified } of objects) {
      if (referenced.has(key)) continue;
      if (!lastModified || lastModified.getTime() > cutoff) {
        result.skippedRecent++;
        continue;
      }

      result.orphaned.push(key);
      if (dryRun) continue;

      try {
        await deleteKey(key);
        result.deleted.push(key);
      } catch (error: unknown) {
        result.errors.push({ key, error: getErrorMessage(error) });
      }
    }
  }

  console.log(
    `🧹 S3 reconciliation${dryRun ? " (dry run)" : ""}: ${result.scanned} scanned, ` +
      `${result.orphaned.length} orphaned, ${result.deleted.length} deleted, ` +
      `${result.skippedRecent} skipped (too recent), ${result.errors.length} error(s)`
  );

  return result;
}
