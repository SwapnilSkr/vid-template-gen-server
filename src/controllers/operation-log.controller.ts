import type { Context } from "elysia";
import {
  deleteOperationLog,
  deleteAllOperationLogs,
  deleteOperationLogs,
  listOperationLogs,
} from "../services/operation-log.service";
import type { OperationLogLevel, OperationLogScope } from "../models";
import { getErrorMessage } from "../types";

const LEVELS = new Set<OperationLogLevel>(["debug", "info", "warn", "error"]);
const SCOPES = new Set<OperationLogScope>(["api", "queue", "worker", "external", "system"]);

interface ListOperationLogsContext extends Context {
  query: {
    limit?: string;
    before?: string;
    level?: string;
    scope?: string;
    reelId?: string;
  };
}

interface DeleteOperationLogContext extends Context {
  params: { id: string };
}

interface DeleteOperationLogsContext extends Context {
  body: { ids: string[] };
}

function queryLevel(value?: string): OperationLogLevel | undefined {
  return value && LEVELS.has(value as OperationLogLevel) ? (value as OperationLogLevel) : undefined;
}

function queryScope(value?: string): OperationLogScope | undefined {
  return value && SCOPES.has(value as OperationLogScope) ? (value as OperationLogScope) : undefined;
}

export async function listOperationLogsController({ query, set }: ListOperationLogsContext) {
  try {
    const before = query.before ? new Date(query.before) : undefined;
    if (before && Number.isNaN(before.getTime())) throw new Error("before must be an ISO timestamp");
    if (query.level && !queryLevel(query.level)) throw new Error("Invalid log level");
    if (query.scope && !queryScope(query.scope)) throw new Error("Invalid log scope");
    const result = await listOperationLogs({
      limit: query.limit ? Number(query.limit) : undefined,
      before,
      level: queryLevel(query.level),
      scope: queryScope(query.scope),
      reelId: query.reelId?.trim() || undefined,
    });
    return { success: true, data: result };
  } catch (error) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function deleteOperationLogController({ params, set }: DeleteOperationLogContext) {
  try {
    const deleted = await deleteOperationLog(params.id);
    if (!deleted) {
      set.status = 404;
      return { success: false, error: "Log entry not found" };
    }
    return { success: true, data: { deleted: 1 } };
  } catch (error) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function deleteOperationLogsController({ body, set }: DeleteOperationLogsContext) {
  try {
    return { success: true, data: { deleted: await deleteOperationLogs(body.ids) } };
  } catch (error) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

/** Permanently wipe every operational log entry. */
export async function deleteAllOperationLogsController({ set }: Context) {
  try {
    return { success: true, data: { deleted: await deleteAllOperationLogs() } };
  } catch (error) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}
