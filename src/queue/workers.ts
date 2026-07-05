import { Worker, type Job } from "bullmq";
import { redisConnection } from "./connection";
import { config } from "../config";
import { getErrorMessage } from "../types";
import { Reel } from "../models";
import { processReel, processReelPlan, processReelProduce } from "../services/reel.service";
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
  YtImportJobData,
  YtImportFramesJobData,
} from "./queues";
import { processYtImport, extractFramesForImport } from "../services/yt-import.service";

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

  const workerBaseOptions = {
    connection: redisConnection,
    lockDuration: 120_000,
    stalledInterval: 30_000,
    maxStalledCount: 5,
  };

  const reelWorker = new Worker<ReelJobData, void, "process">(
    "reel-processing",
    async (job: Job<ReelJobData, void, "process">) => {
      const { reelId, stage } = job.data;
      if (stage === "plan") await processReelPlan(reelId);
      else if (stage === "produce") await processReelProduce(reelId);
      else await processReel(reelId);
    },
    { ...workerBaseOptions, concurrency: config.queueConcurrency }
  );

  const compositionWorker = new Worker<CompositionJobData, void, "process">(
    "composition-processing",
    async (job: Job<CompositionJobData, void, "process">) => {
      await processComposition(job.data.compositionId);
    },
    { ...workerBaseOptions, concurrency: config.queueConcurrency }
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
    { ...workerBaseOptions, concurrency: config.queueConcurrency }
  );

  const publishWorker = new Worker<PublishJobData, void, "publish">(
    "reel-publishing",
    async (job: Job<PublishJobData, void, "publish">) => {
      if (job.data.platform === "youtube") {
        await publishReelToYouTube(job.data.reelId, job.data.channelId);
      }
    },
    { ...workerBaseOptions, concurrency: config.queueConcurrency }
  );

  const revoiceWorker = new Worker<RevoiceJobData, void, "revoice">(
    "reel-revoicing",
    async (job: Job<RevoiceJobData, void, "revoice">) => {
      await processRevoice(job.data.reelId, job.data.variantIds);
    },
    { ...workerBaseOptions, concurrency: config.queueConcurrency }
  );

  const ytImportWorker = new Worker<YtImportJobData, void, "process">(
    "yt-import-processing",
    async (job: Job<YtImportJobData, void, "process">) => {
      await processYtImport(job.data.importId);
    },
    { ...workerBaseOptions, concurrency: 1 }
  );

  const ytImportFramesWorker = new Worker<YtImportFramesJobData, void, "extract">(
    "yt-import-frames",
    async (job: Job<YtImportFramesJobData, void, "extract">) => {
      await extractFramesForImport(job.data.importId);
    },
    { ...workerBaseOptions, concurrency: 1 }
  );

  reelWorker.on("failed", async (job, error) => {
    const reelId = job?.data.reelId;
    if (!reelId) return;
    await Reel.findByIdAndUpdate(reelId, {
      status: "failed",
      progress: 0,
      error: getErrorMessage(error),
    }).catch((updateError: unknown) => {
      console.error(`Could not mark reel ${reelId} failed:`, getErrorMessage(updateError));
    });
  });

  for (const [name, worker] of [
    ["reel", reelWorker],
    ["composition", compositionWorker],
    ["composition-regen", compositionRegenerateWorker],
    ["publish", publishWorker],
    ["revoice", revoiceWorker],
    ["yt-import", ytImportWorker],
    ["yt-import-frames", ytImportFramesWorker],
  ] as const) {
    worker.on("completed", (job) => console.log(`✅ [${name}] job ${job.id} completed`));
    worker.on("failed", (job, error) =>
      console.error(`❌ [${name}] job ${job?.id} failed:`, getErrorMessage(error))
    );
  }

  console.log(
    `🛠️  Queue workers started (concurrency=${config.queueConcurrency}): reel, composition, composition-regen, publish, revoice, yt-import, yt-import-frames`
  );
}
