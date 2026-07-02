import type { Context } from "elysia";
import {
  listTrendReferences,
  getTrendSummary,
  scoutAllGenres,
  refreshAllTrendInsights,
  getScoutTargets,
} from "../services";
import type { TrendPlatform, TrendReferenceStatus } from "../models";
import { getErrorMessage } from "../types";
import type {
  TListTrendsQuery,
  TTrendSummaryQuery,
  TTriggerScoutBody,
} from "../types/guards";

interface ListTrendsContext extends Context {
  query: TListTrendsQuery;
}

interface TrendSummaryContext extends Context {
  query: TTrendSummaryQuery;
}

interface TriggerScoutContext extends Context {
  body: TTriggerScoutBody;
}

/** List trend references (dashboard browsing) — filterable by niche/genre/platform/status. */
export async function listTrendsController({ query }: ListTrendsContext) {
  const refs = await listTrendReferences({
    niche: query.niche,
    genre: query.genre,
    platform: query.platform as TrendPlatform | undefined,
    status: query.status as TrendReferenceStatus | undefined,
    limit: query.limit ? parseInt(query.limit) : undefined,
  });
  return { success: true, data: refs };
}

/** Per-genre top performers + posting-time histogram, for the trends dashboard. */
export async function getTrendSummaryController({ query, set }: TrendSummaryContext) {
  try {
    const summary = await getTrendSummary(query.period ?? "week", query.niche ?? "reddit");
    return { success: true, data: summary };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

/** Manually trigger a scout scan + insight-digest refresh (same logic as the
 * daily/weekly cron script) — lets the dashboard kick off a run on demand. */
export async function triggerTrendScoutController({ body, set }: TriggerScoutContext) {
  try {
    const mode = body.window ?? "week";
    const now = new Date();
    const publishedAfter = new Date(now.getTime() - (mode === "month" ? 30 : 7) * 24 * 60 * 60 * 1000);
    const scanWindow = mode === "month" ? "monthly_scan" : "weekly_scan";

    const results = await scoutAllGenres({ publishedAfter, scanWindow }, body.niche);
    const digests = await refreshAllTrendInsights(getScoutTargets(body.niche));

    return {
      success: true,
      data: { results, digestsRefreshed: digests.length },
      message: `Trend scout (${mode}) complete`,
    };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}
