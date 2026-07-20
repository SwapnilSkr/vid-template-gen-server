import type { Context } from "elysia";
import {
  getOwnedAnalyticsOverview,
  syncOwnedAnalytics,
} from "../services";
import type { OwnedAnalyticsPlatform } from "../models";
import { getErrorMessage } from "../types";

const PLATFORM_SET = new Set<OwnedAnalyticsPlatform>(["youtube", "instagram", "facebook", "threads"]);

function platformFrom(value: unknown): OwnedAnalyticsPlatform | undefined {
  return typeof value === "string" && PLATFORM_SET.has(value as OwnedAnalyticsPlatform)
    ? value as OwnedAnalyticsPlatform
    : undefined;
}

/** Manual first-party pull. No scheduled/cron work is started by this route. */
export async function syncOwnedAnalyticsController({ body, set }: Context) {
  try {
    const input = (body && typeof body === "object" ? body : {}) as { platform?: unknown; accountKey?: unknown };
    if (input.platform && !platformFrom(input.platform)) {
      set.status = 400;
      return { success: false, error: "platform must be youtube, instagram, facebook, or threads" };
    }
    const data = await syncOwnedAnalytics({
      platform: platformFrom(input.platform),
      accountKey: typeof input.accountKey === "string" ? input.accountKey.trim() || undefined : undefined,
    });
    return { success: true, data };
  } catch (error) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function getOwnedAnalyticsOverviewController() {
  return { success: true, data: await getOwnedAnalyticsOverview() };
}
