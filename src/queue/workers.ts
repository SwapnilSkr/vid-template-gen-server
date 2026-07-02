import { Worker, type Job } from "bullmq";
import { redisConnection } from "./connection";
import { config } from "../config";
import { getErrorMessage } from "../types";
import { processReel } from "../services/reel.service";
import {
  processComposition,
  regenerateCompositionAsync,
} from "../services/composition.service";
import { publishReelToYouTube } from "../services/youtube-publish.service";
import { processRevoice } from "../services/reel-revoice.service";
import type {
  ReelJobData,
  CompositionJobData,
  RegenerateCompositionJobData,
  PublishJobData,
  RevoiceJobData,
} from "./queues";

// ============================================
// BullMQ workers — one process per queue, started on server boot. Each
// worker calls straight into the existing service pipeline functions
// (already staged with status/progress writes to Mongo); BullMQ only adds
// persistence, retry/backoff, and concurrency control around them.
// ============================================

let started = false;

export function startWorkers(): void {
  if (started) return;
  started = true;

  const reelWorker = new Worker<ReelJobData, void, "process">(
    "reel-processing",
    async (job: Job<ReelJobData, void, "process">) => {
      await processReel(job.data.reelId);
    },
    { connection: redisConnection, concurrency: config.queueConcurrency }
  );

  const compositionWorker = new Worker<CompositionJobData, void, "process">(
    "composition-processing",
    async (job: Job<CompositionJobData, void, "process">) => {
      await processComposition(job.data.compositionId);
    },
    { connection: redisConnection, concurrency: config.queueConcurrency }
  );

  const compositionRegenerateWorker = new Worker<
    RegenerateCompositionJobData,
    void,
    "regenerate"
  >(
    "composition-regeneration",
    async (job: Job<RegenerateCompositionJobData, void, "regenerate">) => {
      await regenerateCompositionAsync(job.data.compositionId, job.data.delays);
    },
    { connection: redisConnection, concurrency: config.queueConcurrency }
  );

  const publishWorker = new Worker<PublishJobData, void, "publish">(
    "reel-publishing",
    async (job: Job<PublishJobData, void, "publish">) => {
      if (job.data.platform === "youtube") {
        await publishReelToYouTube(job.data.reelId);
      }
    },
    { connection: redisConnection, concurrency: config.queueConcurrency }
  );

  const revoiceWorker = new Worker<RevoiceJobData, void, "revoice">(
    "reel-revoicing",
    async (job: Job<RevoiceJobData, void, "revoice">) => {
      await processRevoice(job.data.reelId, job.data.variantIds);
    },
    { connection: redisConnection, concurrency: config.queueConcurrency }
  );

  for (const [name, worker] of [
    ["reel", reelWorker],
    ["composition", compositionWorker],
    ["composition-regen", compositionRegenerateWorker],
    ["publish", publishWorker],
    ["revoice", revoiceWorker],
  ] as const) {
    worker.on("completed", (job) => console.log(`✅ [${name}] job ${job.id} completed`));
    worker.on("failed", (job, error) =>
      console.error(`❌ [${name}] job ${job?.id} failed:`, getErrorMessage(error))
    );
  }

  console.log(
    `🛠️  Queue workers started (concurrency=${config.queueConcurrency}): reel, composition, composition-regen, publish, revoice`
  );
}
