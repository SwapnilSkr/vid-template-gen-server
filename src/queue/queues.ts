import { Queue } from "bullmq";
import { Reel } from "../models";
import { redisConnection } from "./connection";
import { recordOperationLog } from "../services/operation-log.service";

// ============================================
// BullMQ queues — replaces the old fire-and-forget `processX(id).catch()`
// pattern (blocker #1, see docs/DECISIONS.md §10). Jobs are persisted in
// Redis: a server restart/crash mid-render no longer loses the job — BullMQ
// detects the stalled lock and redelivers it to a worker once one is back up.
//
// NOTE: this gives crash-survival + retry + concurrency control. Produce
// already skips scenes that have assetUrl/audioUrl on S3. Failed jobs can be
// resumed via POST /api/reels/:id/resume (render-only reuse) without re-spending
// on images/TTS. See resumeFailedReel in reel-edit.service.ts.
// ============================================

const defaultJobOptions = {
  attempts: 2,
  backoff: { type: "exponential" as const, delay: 10_000 },
  removeOnComplete: { age: 24 * 60 * 60 }, // keep completed jobs 1 day
  removeOnFail: { age: 7 * 24 * 60 * 60 }, // keep failed jobs 1 week for debugging
};

export interface ReelJobData {
  reelId: string;
  /** undefined = full auto (plan+produce). "plan" stops at plan_review for
   *  human review; "produce" runs assets→render→upload on an approved/edited plan. */
  stage?: "plan" | "produce";
  /** Produce-only: skip body rebuild and append a new outro onto bodyVideoUrl.
   *  composite_only finishes from assembly/narration caches (no TTS / no Ken Burns). */
  produceMode?: "full" | "outro_only" | "composite_only";
  /** Explicit visual outro retry. Keeps existing narration when its signature
   * still matches, but redraws the card from the latest account profile data. */
  outroRetry?: {
    scope: "all" | "primary" | "destination";
    destinationId?: string;
  };
}

export interface CompositionJobData {
  compositionId: string;
}

export interface RegenerateCompositionJobData {
  compositionId: string;
  delays?: number[];
}

export interface PublishJobData {
  reelId: string;
  platform: "youtube" | "instagram" | "facebook" | "threads";
  channelId?: string;
}

export interface RevoiceJobData {
  reelId: string;
  variantIds: string[];
}

export interface YtImportJobData {
  importId: string;
}

export interface YtImportFramesJobData {
  importId: string;
}

export const reelQueue = new Queue<ReelJobData, void, "process">(
  "reel-processing",
  { connection: redisConnection, defaultJobOptions }
);

export const compositionQueue = new Queue<CompositionJobData, void, "process">(
  "composition-processing",
  { connection: redisConnection, defaultJobOptions }
);

export const compositionRegenerateQueue = new Queue<
  RegenerateCompositionJobData,
  void,
  "regenerate"
>("composition-regeneration", { connection: redisConnection, defaultJobOptions });

export const publishQueue = new Queue<PublishJobData, void, "publish">(
  "reel-publishing",
  { connection: redisConnection, defaultJobOptions }
);

export const revoiceQueue = new Queue<RevoiceJobData, void, "revoice">(
  "reel-revoicing",
  { connection: redisConnection, defaultJobOptions }
);

export const ytImportQueue = new Queue<YtImportJobData, void, "process">(
  "yt-import-processing",
  { connection: redisConnection, defaultJobOptions }
);

export const ytImportFramesQueue = new Queue<YtImportFramesJobData, void, "extract">(
  "yt-import-frames",
  { connection: redisConnection, defaultJobOptions }
);

export async function enqueueReel(reelId: string): Promise<void> {
  await reelQueue.add("process", { reelId }, { jobId: reelId });
  recordOperationLog({ scope: "queue", event: "queue.reel_enqueued", message: "Full reel job queued", reelId, jobId: reelId });
}

/** Plan-only stage — cheap script/scene-graph, stops at plan_review. */
export async function enqueueReelPlan(reelId: string): Promise<void> {
  const jobId = `${reelId}-plan`;
  await reelQueue.add("process", { reelId, stage: "plan" }, { jobId });
  recordOperationLog({ scope: "queue", event: "queue.reel_plan_enqueued", message: "Reel plan job queued", reelId, jobId });
}

/** Produce stage — assets→render→upload on an approved/edited plan. Unique
 *  jobId per run so intentional re-renders aren't deduped away, but skip if a
 *  produce job for this reel is already waiting/active (double-click / race). */
export async function enqueueReelProduce(
  reelId: string,
  options: {
    produceMode?: "full" | "outro_only" | "composite_only";
    outroRetry?: ReelJobData["outroRetry"];
  } = {}
): Promise<void> {
  const produceMode = options.produceMode ?? "full";
  const outroRetry = options.outroRetry;
  const activeJobs = await reelQueue.getJobs(["waiting", "delayed", "active"], 0, 200);
  const duplicate = activeJobs.some(
    (job) => job.data.reelId === reelId && job.data.stage === "produce"
  );
  if (duplicate) {
    console.warn(`⏭️  Skipping duplicate produce enqueue for reel ${reelId}`);
    recordOperationLog({
      scope: "queue",
      level: "warn",
      event: "queue.produce_duplicate_skipped",
      message: "Skipped a duplicate produce request because a produce job is already active",
      reelId,
      metadata: { produceMode },
    });
    return;
  }
  const jobId = `${reelId}-produce-${Date.now()}`;
  await reelQueue.add(
    "process",
    { reelId, stage: "produce", produceMode, outroRetry },
    { jobId }
  );
  recordOperationLog({
    scope: "queue",
    event: "queue.reel_produce_enqueued",
    message: "Reel produce job queued",
    reelId,
    jobId,
    metadata: { produceMode, outroRetry },
  });
}

/** Remove a reel's queued jobs regardless of state (queued, stalled, failed,
 *  completed) — used when deleting a reel so no orphaned job lingers or gets
 *  redelivered to a worker later. Covers the full-auto and plan job ids. */
export async function removeReelJob(reelId: string): Promise<void> {
  for (const id of [reelId, `${reelId}-plan`]) {
    const job = await reelQueue.getJob(id);
    await job?.remove().catch(() => {});
  }
}

export async function enqueuePublish(
  reelId: string,
  platform: PublishJobData["platform"] = "youtube",
  channelId?: string
): Promise<void> {
  const activeJobs = await publishQueue.getJobs(["waiting", "delayed", "active"], 0, 100);
  const duplicate = activeJobs.some(
    (job) =>
      job.data.reelId === reelId &&
      job.data.platform === platform &&
      job.data.channelId === channelId
  );
  if (duplicate) {
    recordOperationLog({
      scope: "queue",
      level: "warn",
      event: "queue.publish_duplicate_skipped",
      message: "Skipped a duplicate publish request because a matching publish job is already active",
      reelId,
      metadata: { platform, channelId },
    });
    return;
  }

  // Surface an in-flight publish to the studio poller. Auto-publish used to
  // enqueue without this, so the UI stayed on "completed" until a manual refresh.
  if (platform === "youtube") {
    await Reel.findByIdAndUpdate(reelId, {
      $set: {
        "youtube.status": "pending",
        ...(channelId ? { "youtube.channelId": channelId } : {}),
      },
    });
  }

  const jobId = `${reelId}-publish-${platform}-${channelId ?? "default"}-${Date.now()}`;
  await publishQueue.add(
    "publish",
    { reelId, platform, channelId },
    {
      jobId,
      // Retrying a failed container/upload automatically can create a duplicate
      // post on the Meta platforms. Surface the failure and require an explicit
      // resend. YouTube resumable uploads are safe to auto-retry.
      ...(platform !== "youtube" ? { attempts: 1 } : {}),
    }
  );
  recordOperationLog({
    scope: "queue",
    event: "queue.publish_enqueued",
    message: `${platform} publish job queued`,
    reelId,
    jobId,
    metadata: { platform, channelId },
  });
}

export async function enqueueRevoice(reelId: string, variantIds: string[]): Promise<void> {
  const jobId = `${reelId}-revoice-${Date.now()}`;
  await revoiceQueue.add(
    "revoice",
    { reelId, variantIds },
    { jobId }
  );
  recordOperationLog({ scope: "queue", event: "queue.revoice_enqueued", message: "Revoice job queued", reelId, jobId, metadata: { variantIds } });
}

export async function enqueueYtImport(importId: string): Promise<void> {
  const jobId = `yt-import-${importId}`;
  await ytImportQueue.add("process", { importId }, { jobId });
  recordOperationLog({ scope: "queue", event: "queue.yt_import_enqueued", message: "YouTube import job queued", jobId, metadata: { importId } });
}

export async function enqueueYtImportFrames(importId: string): Promise<void> {
  const jobId = `yt-frames-${importId}-${Date.now()}`;
  await ytImportFramesQueue.add(
    "extract",
    { importId },
    { jobId }
  );
  recordOperationLog({ scope: "queue", event: "queue.yt_import_frames_enqueued", message: "YouTube import frame-extraction job queued", jobId, metadata: { importId } });
}

export async function enqueueComposition(compositionId: string): Promise<void> {
  await compositionQueue.add("process", { compositionId }, { jobId: compositionId });
  recordOperationLog({ scope: "queue", event: "queue.composition_enqueued", message: "Composition job queued", jobId: compositionId, metadata: { compositionId } });
}

export async function enqueueCompositionRegeneration(
  compositionId: string,
  delays?: number[]
): Promise<void> {
  const jobId = `${compositionId}-regen-${Date.now()}`;
  await compositionRegenerateQueue.add(
    "regenerate",
    { compositionId, delays },
    { jobId }
  );
  recordOperationLog({ scope: "queue", event: "queue.composition_regeneration_enqueued", message: "Composition regeneration job queued", jobId, metadata: { compositionId } });
}
