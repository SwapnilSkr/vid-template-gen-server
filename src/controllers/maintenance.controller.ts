import type { Context } from "elysia";
import { cleanupGameplayDownloadCache, cleanupLocalProcessing, reconcileS3Assets, purgeFailedReels } from "../services";
import { getErrorMessage } from "../types";

interface ReconcileS3Context extends Context {
  query: { apply?: string };
}

interface LocalCleanupContext extends Context {
  query: { apply?: string; olderThanHours?: string };
}

/** On-demand S3 orphan sweep (dry run by default — pass ?apply=true to delete). */
export async function reconcileS3Controller({ query, set }: ReconcileS3Context) {
  try {
    const apply = query.apply === "true";
    const result = await reconcileS3Assets(!apply);
    return { success: true, data: result };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

/** Delete every reel currently marked "failed" (Mongo doc + S3 assets + BullMQ job). */
export async function purgeFailedReelsController({ set }: Context) {
  try {
    const result = await purgeFailedReels();
    return { success: true, data: result };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

/** On-demand local processing cleanup (dry run by default). */
export async function cleanupLocalProcessingController({ query, set }: LocalCleanupContext) {
  try {
    const apply = query.apply === "true";
    const olderThanHours = query.olderThanHours ? Number(query.olderThanHours) : undefined;
    const result = await cleanupLocalProcessing(!apply, olderThanHours);
    return { success: true, data: result };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

/** Inspect or apply the bounded disposable gameplay-download cache sweep. */
export async function cleanupGameplayCacheController({ query, set }: LocalCleanupContext) {
  try {
    const apply = query.apply === "true";
    return { success: true, data: await cleanupGameplayDownloadCache(!apply) };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}
