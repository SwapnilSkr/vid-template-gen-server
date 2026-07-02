import type { Context } from "elysia";
import { reconcileS3Assets, purgeFailedReels } from "../services";
import { getErrorMessage } from "../types";

interface ReconcileS3Context extends Context {
  query: { apply?: string };
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
