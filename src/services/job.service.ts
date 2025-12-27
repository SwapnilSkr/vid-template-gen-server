import { v4 as uuidv4 } from "uuid";
import type { CompositionJob, CompositionStatus, DialogueLine } from "../types";

// In-memory job storage
const jobs = new Map<string, CompositionJob>();

/**
 * Create a new composition job
 */
export function createJob(
  templateId: string,
  title: string,
  dialogue: DialogueLine[]
): CompositionJob {
  const job: CompositionJob = {
    id: uuidv4(),
    status: "pending",
    progress: 0,
    templateId,
    title,
    dialogue,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  jobs.set(job.id, job);
  console.log(`📋 Created job: ${job.id}`);

  return job;
}

/**
 * Get a job by ID
 */
export function getJob(jobId: string): CompositionJob | undefined {
  return jobs.get(jobId);
}

/**
 * List all jobs
 */
export function listJobs(limit = 50): CompositionJob[] {
  const allJobs = Array.from(jobs.values());
  return allJobs
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit);
}

/**
 * Update job status
 */
export function updateJobStatus(
  jobId: string,
  status: CompositionStatus,
  progress?: number
): CompositionJob | undefined {
  const job = jobs.get(jobId);
  if (!job) return undefined;

  job.status = status;
  if (progress !== undefined) {
    job.progress = Math.min(100, Math.max(0, progress));
  }
  job.updatedAt = new Date();

  if (status === "completed") {
    job.completedAt = new Date();
    job.progress = 100;
  }

  console.log(`📊 Job ${jobId}: ${status} (${job.progress}%)`);

  return job;
}

/**
 * Set job output path
 */
export function setJobOutput(
  jobId: string,
  outputPath: string
): CompositionJob | undefined {
  const job = jobs.get(jobId);
  if (!job) return undefined;

  job.outputPath = outputPath;
  job.updatedAt = new Date();

  return job;
}

/**
 * Mark job as failed
 */
export function failJob(
  jobId: string,
  error: string
): CompositionJob | undefined {
  const job = jobs.get(jobId);
  if (!job) return undefined;

  job.status = "failed";
  job.error = error;
  job.updatedAt = new Date();

  console.error(`❌ Job ${jobId} failed: ${error}`);

  return job;
}

/**
 * Delete a job
 */
export function deleteJob(jobId: string): boolean {
  return jobs.delete(jobId);
}

/**
 * Clean up old completed/failed jobs
 */
export function cleanupJobs(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
  const cutoff = Date.now() - maxAgeMs;
  let deleted = 0;

  for (const [id, job] of jobs.entries()) {
    if (
      (job.status === "completed" || job.status === "failed") &&
      job.updatedAt.getTime() < cutoff
    ) {
      jobs.delete(id);
      deleted++;
    }
  }

  if (deleted > 0) {
    console.log(`🧹 Cleaned up ${deleted} old jobs`);
  }

  return deleted;
}
