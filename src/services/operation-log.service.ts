import { config } from "../config";
import {
  OperationLog,
  type IOperationLog,
  type OperationLogLevel,
  type OperationLogScope,
} from "../models";
import { getErrorMessage } from "../types";

const SENSITIVE_KEY = /authorization|cookie|token|secret|password|api[-_]?key|signature|credential/i;
const MAX_TEXT_LENGTH = 2_000;
const MAX_METADATA_DEPTH = 4;
const MAX_METADATA_KEYS = 40;
const MAX_STACK_LENGTH = 8_000;

export interface OperationLogInput {
  requestId?: string;
  level?: OperationLogLevel;
  scope: OperationLogScope;
  event: string;
  message: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  reelId?: string;
  jobId?: string;
  metadata?: Record<string, unknown>;
  error?: unknown;
}

export interface ListOperationLogInput {
  limit?: number;
  before?: Date;
  level?: OperationLogLevel;
  scope?: OperationLogScope;
  reelId?: string;
}

function trim(value: string, max = MAX_TEXT_LENGTH): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function scrub(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    // Never retain a complete signed URL or query string in an operational log.
    const queryAt = value.indexOf("?");
    return trim(queryAt >= 0 ? `${value.slice(0, queryAt)}?[redacted]` : value);
  }
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_METADATA_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, MAX_METADATA_KEYS).map((item) => scrub(item, depth + 1));
  if (typeof value === "object") {
    const safe: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_METADATA_KEYS)) {
      safe[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : scrub(item, depth + 1);
    }
    return safe;
  }
  return trim(String(value));
}

function normalizedError(error: unknown): IOperationLog["error"] | undefined {
  if (!error) return undefined;
  if (error instanceof Error) {
    const coded = error as Error & { code?: unknown };
    return {
      name: error.name,
      message: trim(error.message),
      stack: error.stack ? trim(error.stack, MAX_STACK_LENGTH) : undefined,
      code: coded.code ? trim(String(coded.code), 100) : undefined,
    };
  }
  return { message: trim(getErrorMessage(error)) };
}

/** Print the same redacted server event that is persisted to Mongo. Console
 * output is intentionally compact so one request/job is one readable line,
 * while the Operations page retains the full bounded metadata for inspection. */
function mirrorOperationLogToConsole(input: OperationLogInput): void {
  if (!config.operationLogConsole) return;
  const level = input.level ?? (input.error ? "error" : "info");
  const metadata = input.metadata
    ? (scrub(input.metadata) as Record<string, unknown>)
    : undefined;
  const error = normalizedError(input.error);
  const line = JSON.stringify({
    level,
    scope: input.scope,
    event: trim(input.event, 160),
    message: trim(input.message),
    requestId: input.requestId,
    reelId: input.reelId,
    jobId: input.jobId,
    method: input.method,
    path: input.path ? trim(input.path, 512) : undefined,
    status: input.status,
    durationMs: input.durationMs,
    metadata,
    error: error ? { name: error.name, message: error.message, code: error.code } : undefined,
  });
  const prefix = `[operations] ${line}`;
  if (level === "error") console.error(prefix);
  else if (level === "warn") console.warn(prefix);
  else console.log(prefix);
}

/** Durable log writer. Its failure must never affect the action being logged. */
export async function writeOperationLog(input: OperationLogInput): Promise<IOperationLog | undefined> {
  mirrorOperationLogToConsole(input);
  try {
    const now = new Date();
    return await OperationLog.create({
      requestId: input.requestId,
      level: input.level ?? (input.error ? "error" : "info"),
      scope: input.scope,
      event: trim(input.event, 160),
      message: trim(input.message),
      method: input.method,
      path: input.path ? trim(input.path, 512) : undefined,
      status: input.status,
      durationMs: input.durationMs,
      reelId: input.reelId,
      jobId: input.jobId,
      metadata: input.metadata ? (scrub(input.metadata) as Record<string, unknown>) : undefined,
      error: normalizedError(input.error),
      expiresAt: new Date(now.getTime() + config.operationLogRetentionDays * 24 * 60 * 60 * 1_000),
    });
  } catch (error) {
    // Do not recurse through the database logger if Mongo itself is unhealthy.
    console.error(`Operational log write failed: ${getErrorMessage(error)}`);
    return undefined;
  }
}

/** Fire-and-forget companion for non-critical telemetry in workers and fallbacks. */
export function recordOperationLog(input: OperationLogInput): void {
  void writeOperationLog(input);
}

export async function listOperationLogs(input: ListOperationLogInput = {}): Promise<{
  logs: IOperationLog[];
  nextBefore?: string;
}> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const filter: Record<string, unknown> = {};
  if (input.before) filter.createdAt = { $lt: input.before };
  if (input.level) filter.level = input.level;
  if (input.scope) filter.scope = input.scope;
  if (input.reelId) filter.reelId = input.reelId;
  const rows = await OperationLog.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1);
  const hasMore = rows.length > limit;
  const logs = hasMore ? rows.slice(0, limit) : rows;
  return { logs, nextBefore: hasMore && logs.length ? logs[logs.length - 1].createdAt.toISOString() : undefined };
}

export async function deleteOperationLog(id: string): Promise<boolean> {
  return Boolean((await OperationLog.deleteOne({ _id: id })).deletedCount);
}

export async function deleteOperationLogs(ids: string[]): Promise<number> {
  return (await OperationLog.deleteMany({ _id: { $in: ids.slice(0, 100) } })).deletedCount ?? 0;
}

/** Permanently remove all operational telemetry. The caller is intentionally
 * not recorded as a new entry, otherwise "delete all" could never leave the
 * collection empty. */
export async function deleteAllOperationLogs(): Promise<number> {
  return (await OperationLog.deleteMany({})).deletedCount ?? 0;
}
