import type { Context } from "elysia";
import {
  listTrendReferences,
  getTrendSummary,
  scoutAllGenres,
  refreshAllTrendInsights,
  getScoutTargets,
  listHorrorReferences,
  scoutHorrorReferences,
} from "../services";
import type { HorrorReferenceStatus, TrendPlatform, TrendReferenceStatus } from "../models";
import { getErrorMessage } from "../types";
import type {
  TListHorrorReferencesQuery,
  TListTrendsQuery,
  TTriggerHorrorReferenceScoutBody,
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

interface ListHorrorReferencesContext extends Context {
  query: TListHorrorReferencesQuery;
}

interface TriggerHorrorReferenceScoutContext extends Context {
  body: TTriggerHorrorReferenceScoutBody;
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
    const targets = getScoutTargets(body.niche);
    const successfulTargets = targets.filter((target) =>
      results.some(
        (result) =>
          result.niche === target.niche &&
          result.genre === target.genre &&
          !result.error &&
          result.upserted > 0
      )
    );
    const digests = await refreshAllTrendInsights(successfulTargets);
    const failed = results.filter((result) => result.error);

    return {
      success: true,
      data: {
        results,
        digestsRefreshed: digests.length,
        failed,
      },
      message: failed.length
        ? `Trend scout (${mode}) completed with ${failed.length} target failure${failed.length === 1 ? "" : "s"}`
        : `Trend scout (${mode}) complete`,
    };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

/** List public-domain horror story references available to the horror planner. */
export async function listHorrorReferencesController({ query }: ListHorrorReferencesContext) {
  const refs = await listHorrorReferences({
    status: query.status as HorrorReferenceStatus | undefined,
    genre: query.genre,
    limit: query.limit ? parseInt(query.limit) : undefined,
  });
  return { success: true, data: refs };
}

/** Manually scrape public-domain horror references for the horror story planner. */
export async function triggerHorrorReferenceScoutController({
  body,
  set,
}: TriggerHorrorReferenceScoutContext) {
  try {
    const result = await scoutHorrorReferences(body.limit ?? 20);
    return {
      success: true,
      data: result,
      message: `Horror reference scout complete: ${result.upserted} saved, ${result.skipped} skipped`,
    };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}
