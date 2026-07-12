import type { Context } from "elysia";
import { config } from "../config";
import { listRedditCandidates, listStoryBank, REDDIT_GENRES } from "../services";
import type { StorySource } from "../models";
import { getErrorMessage } from "../types";
import { httpErrorFromUnknown } from "../services/ffmpeg-capability.service";
import type { TListStoryBankQuery, TListStoryCandidatesQuery } from "../types/guards";

interface ListCandidatesContext extends Context {
  query: TListStoryCandidatesQuery;
}

interface ListBankContext extends Context {
  query: TListStoryBankQuery;
}

function parseExcludeUrls(raw?: string): string[] | undefined {
  if (!raw?.trim()) return undefined;
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((url): url is string => typeof url === "string" && url.length > 0);
      }
    } catch {
      // fall through to comma-separated parsing
    }
  }
  return trimmed
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
}

/** Live Reddit posts for browse/select (hybrid/verbatim modes). */
export async function listStoryCandidatesController({ query, set }: ListCandidatesContext) {
  try {
    const source = (query.source ?? config.storyMode) as StorySource;
    if (source === "llm") {
      return { success: true, data: { items: [], hasMore: false } };
    }
    const excludeUrls = parseExcludeUrls(query.excludeUrls);
    const result = await listRedditCandidates(query.genre, source, {
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
      excludeUrls,
    });
    return { success: true, data: result };
  } catch (error: unknown) {
    const mapped = httpErrorFromUnknown(error);
    set.status = mapped.status;
    return mapped.body;
  }
}

/** Unused banked stories for browse/select. */
export async function listStoryBankController({ query, set }: ListBankContext) {
  try {
    const sort = query.sort === "fifo" || query.sort === "oldest" ? "oldest" : query.sort;
    const result = await listStoryBank({
      genre: query.genre,
      source: query.source as StorySource | undefined,
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
      offset: query.offset ? parseInt(query.offset, 10) : undefined,
      sort,
    });
    return {
      success: true,
      data: {
        total: result.total,
        hasMore: result.hasMore,
        items: result.items.map((item) => ({
          id: item.id,
          title: item.title,
          excerpt: item.body.slice(0, 280),
          source: item.source,
          genre: item.genre,
          subreddit: item.subreddit,
          upvotes: item.upvotes,
          comments: item.comments,
          seedUrl: item.seedUrl,
          wordCount: item.body.trim().split(/\s+/).filter(Boolean).length,
          createdAt: item.createdAt.toISOString(),
        })),
      },
    };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

/** Reddit genre catalog for the browse UI. */
export async function listStoryGenresController() {
  const genres = Object.values(REDDIT_GENRES).map((g) => ({
    id: g.id,
    label: g.label,
    subreddits: g.subreddits,
  }));
  return { success: true, data: genres };
}
