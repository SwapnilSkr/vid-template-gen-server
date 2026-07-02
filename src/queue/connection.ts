import type { ConnectionOptions } from "bullmq";
import { config } from "../config";

// ============================================
// Shared Redis connection options for BullMQ. Passed as plain options (not
// an ioredis instance) so every Queue/Worker uses BullMQ's own bundled
// ioredis build — avoids a duplicate-package type conflict from installing
// ioredis separately at the top level.
// `maxRetriesPerRequest: null` is required by BullMQ (it manages its own
// retry/blocking semantics).
// ============================================

const url = new URL(config.redisUrl);

export const redisConnection: ConnectionOptions = {
  host: url.hostname,
  port: url.port ? Number(url.port) : 6379,
  username: url.username || undefined,
  password: url.password || undefined,
  maxRetriesPerRequest: null,
};
