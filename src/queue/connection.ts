import type { ConnectionOptions } from "bullmq";
import { config } from "../config";

// ============================================
// Shared Redis connection options for BullMQ. Passed as plain options (not
// an ioredis instance) so every Queue/Worker uses BullMQ's own bundled
// ioredis build — avoids a duplicate-package type conflict from installing
// ioredis separately at the top level.
// `maxRetriesPerRequest: null` is required by BullMQ (it manages its own
// retry/blocking semantics).
//
// Redis Cloud usually needs TLS even when the URI is `redis://` (not
// `rediss://`). We enable TLS for `rediss://`, REDIS_TLS=true, or known
// cloud hostnames. Local `redis://localhost` stays plain.
//
// Redis Cloud certs often omit a matching DNS SAN → Node throws
// ERR_TLS_CERT_ALTNAME_INVALID. We set servername (SNI) and skip hostname
// verification for those hosts (still encrypts the connection). Force
// strict verify with REDIS_TLS_REJECT_UNAUTHORIZED=true if you mount a CA.
// ============================================

const url = new URL(config.redisUrl);

const isRedisCloud = /\.(redis\.io|redislabs\.com)$/i.test(url.hostname);

const useTls =
  url.protocol === "rediss:" ||
  process.env.REDIS_TLS === "true" ||
  (isRedisCloud && process.env.REDIS_TLS !== "false");

const rejectUnauthorized =
  process.env.REDIS_TLS_REJECT_UNAUTHORIZED === "true"
    ? true
    : isRedisCloud
      ? false
      : process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== "false";

export const redisConnection: ConnectionOptions = {
  host: url.hostname,
  port: url.port ? Number(url.port) : useTls ? 6380 : 6379,
  username: url.username ? decodeURIComponent(url.username) : undefined,
  password: url.password ? decodeURIComponent(url.password) : undefined,
  maxRetriesPerRequest: null,
  ...(useTls
    ? {
        tls: {
          servername: url.hostname,
          rejectUnauthorized,
        },
      }
    : {}),
};
