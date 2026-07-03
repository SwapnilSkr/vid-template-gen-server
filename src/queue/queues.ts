import { Queue } from "bullmq";
import { redisConnection } from "./connection";

// ============================================
// BullMQ queues — replaces the old fire-and-forget `processX(id).catch()`
// pattern (blocker #1, see docs/DECISIONS.md §10). Jobs are persisted in
// Redis: a server restart/crash mid-render no longer loses the job — BullMQ
// detects the stalled lock and redelivers it to a worker once one is back up.
//
// NOTE: this gives crash-survival + retry + concurrency control, not yet
// full per-stage resumability (a redelivered job re-runs the whole pipeline
// from the top, re-spending on regenerated assets). True stage-level resume
// (skip scenes that already have assetUrl/audioUrl) is a follow-up — see
// docs/architecture/render-engine.md.
// ============================================

const defaultJobOptions = {
  attempts: 2,
  backoff: { type: "exponential" as const, delay: 10_000 },
  removeOnComplete: { age: 24 * 60 * 60 }, // keep completed jobs 1 day
  removeOnFail: { age: 7 * 24 * 60 * 60 }, // keep failed jobs 1 week for debugging
};

export interface ReelJobData {
  reelId: string;
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
  platform: "youtube";
  channelId?: string;
}

export interface RevoiceJobData {
  reelId: string;
  variantIds: string[];
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

export async function enqueueReel(reelId: string): Promise<void> {
  await reelQueue.add("process", { reelId }, { jobId: reelId });
}

/** Remove a reel's job from the queue regardless of state (queued, stalled,
 *  failed, or completed) — used when deleting a reel so no orphaned job
 *  lingers or gets redelivered to a worker later. */
export async function removeReelJob(reelId: string): Promise<void> {
  const job = await reelQueue.getJob(reelId);
  await job?.remove();
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
  if (duplicate) return;

  await publishQueue.add(
    "publish",
    { reelId, platform, channelId },
    { jobId: `${reelId}-publish-${platform}-${channelId ?? "default"}-${Date.now()}` }
  );
}

export async function enqueueRevoice(reelId: string, variantIds: string[]): Promise<void> {
  await revoiceQueue.add(
    "revoice",
    { reelId, variantIds },
    { jobId: `${reelId}-revoice-${Date.now()}` }
  );
}

export async function enqueueComposition(compositionId: string): Promise<void> {
  await compositionQueue.add("process", { compositionId }, { jobId: compositionId });
}

export async function enqueueCompositionRegeneration(
  compositionId: string,
  delays?: number[]
): Promise<void> {
  await compositionRegenerateQueue.add(
    "regenerate",
    { compositionId, delays },
    { jobId: `${compositionId}-regen-${Date.now()}` }
  );
}
