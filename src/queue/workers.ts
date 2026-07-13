import { Worker, type Job } from "bullmq";
import "../config/ffmpeg-bootstrap"; // reel workers import fluent-ffmpeg via services — set paths first
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
import { publishReelToInstagram } from "../services/instagram-publish.service";
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
import { recordOperationLog } from "../services/operation-log.service";

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
      const { reelId, stage, produceMode } = job.data;
      console.log(
        `▶️  [reel] job ${job.id} start reel=${reelId} stage=${stage ?? "full"}` +
          (produceMode ? ` mode=${produceMode}` : "")
      );
      recordOperationLog({
        scope: "worker",
        event: "worker.reel_started",
        message: "Reel worker started",
        reelId,
        jobId: String(job.id),
        metadata: { stage: stage ?? "full", produceMode },
      });
      if (stage === "plan") await processReelPlan(reelId);
      else if (stage === "produce") await processReelProduce(reelId, produceMode ?? "full");
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
      } else if (job.data.platform === "instagram") {
        await publishReelToInstagram(job.data.reelId, job.data.channelId);
      }
    },
    {
      ...workerBaseOptions,
      // Large MP4 uploads to YouTube can run 10–30+ min on slow links.
      lockDuration: 60 * 60 * 1000,
      lockRenewTime: 60 * 1000,
      concurrency: config.queueConcurrency,
    }
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
    const attempts = job.opts.attempts ?? 1;
    const finalAttempt = job.attemptsMade >= attempts;
    recordOperationLog({
      scope: "worker",
      level: finalAttempt ? "error" : "warn",
      event: finalAttempt ? "worker.reel_failed" : "worker.reel_retry_scheduled",
      message: finalAttempt
        ? "Reel worker exhausted its retries"
        : `Reel worker failed; retry ${job.attemptsMade + 1} of ${attempts} will be attempted`,
      reelId,
      jobId: String(job.id),
      metadata: { attemptsMade: job.attemptsMade, attempts },
      error,
    });
    if (!finalAttempt) {
      await Reel.findByIdAndUpdate(reelId, {
        $set: { status: "pending", currentStep: `Retrying after worker error (${job.attemptsMade}/${attempts})`, error: getErrorMessage(error) },
      }).catch((updateError: unknown) => {
        console.error(`Could not mark reel ${reelId} for retry:`, getErrorMessage(updateError));
      });
      return;
    }
    await Reel.findByIdAndUpdate(reelId, {
      $set: {
        status: "failed",
        progress: 0,
        error: getErrorMessage(error),
      },
      $unset: { currentStep: "" },
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
    worker.on("active", (job) => {
      // Reel planning/production reports a richer start event at the exact
      // service boundary above. The other queues still need an observable
      // lifecycle start, not only an enqueue and eventual outcome.
      if (name === "reel") return;
      recordOperationLog({
        scope: "worker",
        event: "worker.job_started",
        message: `${name} job started`,
        reelId: "reelId" in job.data ? job.data.reelId : undefined,
        jobId: String(job.id),
        metadata: { worker: name },
      });
    });
    worker.on("completed", (job) => {
      console.log(`✅ [${name}] job ${job.id} completed`);
      recordOperationLog({
        scope: "worker",
        event: "worker.job_completed",
        message: `${name} job completed`,
        reelId: "reelId" in job.data ? job.data.reelId : undefined,
        jobId: String(job.id),
        metadata: { worker: name },
      });
    });
    worker.on("failed", (job, error) => {
      console.error(`❌ [${name}] job ${job?.id} failed:`, getErrorMessage(error));
      if (name === "reel") return; // logged above with retry/final-attempt context
      recordOperationLog({
        scope: "worker",
        level: "error",
        event: "worker.job_failed",
        message: `${name} job failed`,
        reelId: job && "reelId" in job.data ? job.data.reelId : undefined,
        jobId: job?.id ? String(job.id) : undefined,
        metadata: { worker: name, attemptsMade: job?.attemptsMade, attempts: job?.opts.attempts },
        error,
      });
    });
  }

  console.log(
    `🛠️  Queue workers started (concurrency=${config.queueConcurrency}): reel, composition, composition-regen, publish, revoice, yt-import, yt-import-frames`
  );
}
