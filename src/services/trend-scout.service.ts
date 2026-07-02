import { config } from "../config";
import { TrendReference, type TrendScanWindow } from "../models";
import { REDDIT_GENRES } from "./story.service";
import { getErrorMessage } from "../types";

// ============================================
// Trend scout — pulls top-performing YouTube Shorts per Reddit genre via the
// YouTube Data API v3 (read-only API key, separate from the OAuth publish
// credentials) and upserts them into TrendReference. Feeds:
//  1. the trends dashboard (raw reference browsing)
//  2. trend-insight.service's digest (compact context for script/thumbnail prompts)
//  3. posting-time analysis (dayOfWeek/hourUtc bucketed from postedAt)
//
// Quota: search.list = 100 units, videos.list = 1 unit. ~14 Reddit genres ×
// 1 search + 1 videos call ≈ 1,414 units per full scan — the 10,000/day free
// quota comfortably covers a daily (rolling week) scan.
// ============================================

const YT_API_BASE = "https://www.googleapis.com/youtube/v3";
/** YouTube's current Shorts ceiling (extended from 60s in Oct 2024). Search's
 * own `videoDuration=short` filter is coarse (<4min), so re-check exactly. */
const SHORTS_MAX_DURATION_SEC = 183;

export interface ScoutOptions {
  publishedAfter: Date;
  publishedBefore?: Date;
  scanWindow: TrendScanWindow;
  maxResults?: number; // per genre, default 15
}

export interface ScoutGenreResult {
  genre: string;
  found: number;
  upserted: number;
  error?: string;
}

interface YouTubeSearchItem {
  id?: { videoId?: string };
}

interface YouTubeVideoItem {
  id: string;
  snippet?: {
    title?: string;
    description?: string;
    channelTitle?: string;
    publishedAt?: string;
    tags?: string[];
    thumbnails?: Record<string, { url?: string }>;
  };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  contentDetails?: { duration?: string };
}

/** Parse an ISO 8601 duration (e.g. "PT1M5S") into whole seconds. */
function parseIsoDuration(iso: string): number {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  const [, h, min, s] = m;
  return Number(h || 0) * 3600 + Number(min || 0) * 60 + Number(s || 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Search + resolve stats for one Reddit genre's top-viewed Shorts in the window. */
export async function scoutGenre(genre: string, opts: ScoutOptions): Promise<ScoutGenreResult> {
  if (!config.youtubeDataApiKey) {
    throw new Error("YOUTUBE_DATA_API_KEY not configured — get one from Google Cloud Console");
  }
  const meta = REDDIT_GENRES[genre];
  if (!meta) throw new Error(`Unknown Reddit genre: ${genre}`);

  const searchParams = new URLSearchParams({
    part: "snippet",
    type: "video",
    videoDuration: "short",
    order: "viewCount",
    maxResults: String(opts.maxResults ?? 15),
    q: `${meta.label} reddit story`,
    publishedAfter: opts.publishedAfter.toISOString(),
    key: config.youtubeDataApiKey,
  });
  if (opts.publishedBefore) searchParams.set("publishedBefore", opts.publishedBefore.toISOString());

  const searchRes = await fetch(`${YT_API_BASE}/search?${searchParams}`);
  if (!searchRes.ok) {
    throw new Error(`YouTube search.list failed (${searchRes.status}): ${await searchRes.text()}`);
  }
  const searchJson = (await searchRes.json()) as { items?: YouTubeSearchItem[] };
  const videoIds = (searchJson.items ?? [])
    .map((i) => i.id?.videoId)
    .filter((id): id is string => Boolean(id));
  if (!videoIds.length) return { genre, found: 0, upserted: 0 };

  const videosParams = new URLSearchParams({
    part: "snippet,statistics,contentDetails",
    id: videoIds.join(","),
    key: config.youtubeDataApiKey,
  });
  const videosRes = await fetch(`${YT_API_BASE}/videos?${videosParams}`);
  if (!videosRes.ok) {
    throw new Error(`YouTube videos.list failed (${videosRes.status}): ${await videosRes.text()}`);
  }
  const videosJson = (await videosRes.json()) as { items?: YouTubeVideoItem[] };

  let upserted = 0;
  for (const item of videosJson.items ?? []) {
    const durationSec = parseIsoDuration(item.contentDetails?.duration ?? "");
    if (durationSec > SHORTS_MAX_DURATION_SEC) continue; // search's filter is coarse — re-verify true Short

    const postedAt = item.snippet?.publishedAt ? new Date(item.snippet.publishedAt) : undefined;
    const thumb =
      item.snippet?.thumbnails?.high?.url ??
      item.snippet?.thumbnails?.medium?.url ??
      item.snippet?.thumbnails?.default?.url;

    await TrendReference.findOneAndUpdate(
      { externalId: item.id },
      {
        niche: "reddit",
        genre,
        sourceUrl: `https://youtube.com/shorts/${item.id}`,
        platform: "youtube_shorts",
        externalId: item.id,
        title: item.snippet?.title,
        description: item.snippet?.description?.slice(0, 500),
        thumbnailUrl: thumb,
        channelTitle: item.snippet?.channelTitle,
        tags: (item.snippet?.tags ?? []).slice(0, 15),
        dayOfWeek: postedAt?.getUTCDay(),
        hourUtc: postedAt?.getUTCHours(),
        scanWindow: opts.scanWindow,
        metrics: {
          views: Number(item.statistics?.viewCount) || undefined,
          likes: Number(item.statistics?.likeCount) || undefined,
          comments: Number(item.statistics?.commentCount) || undefined,
          durationSec,
          postedAt,
          capturedAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    upserted++;
  }

  return { genre, found: videoIds.length, upserted };
}

/** Scout every Reddit genre in sequence (gentle pacing to avoid bursty quota errors). */
export async function scoutAllGenres(opts: ScoutOptions): Promise<ScoutGenreResult[]> {
  const results: ScoutGenreResult[] = [];
  for (const genre of Object.keys(REDDIT_GENRES)) {
    try {
      results.push(await scoutGenre(genre, opts));
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      console.error(`🔎 trend-scout: ${genre} failed: ${message}`);
      results.push({ genre, found: 0, upserted: 0, error: message });
    }
    await sleep(300);
  }
  return results;
}

// ============================================
// Trend summary — per-genre top performers + a posting-time histogram
// (dayOfWeek/hourUtc bucketed, view-weighted). Powers the trends dashboard
// and gives a starting prior for "best time to post" — see the caveat in
// docs: this is publish-timestamp clustering of competitors, correlational
// not causal. Your own channel's YouTube Analytics data (once publishing)
// is the stronger long-term signal.
// ============================================

export interface TrendTopPerformer {
  title?: string;
  thumbnailUrl?: string;
  channelTitle?: string;
  sourceUrl: string;
  views?: number;
  postedAt?: Date;
}

export interface TrendPostingBucket {
  dayOfWeek: number; // 0 (Sun) - 6 (Sat), UTC
  hourUtc: number;
  weightedScore: number;
}

export interface TrendGenreSummary {
  genre: string;
  displayLabel: string;
  sampleSize: number;
  topPerformers: TrendTopPerformer[];
  postingBuckets: TrendPostingBucket[]; // sorted best-first
  bestPostingTime?: { dayOfWeek: number; hourUtc: number };
}

const PERIOD_WINDOWS: Record<"week" | "month", TrendScanWindow[]> = {
  week: ["last_48h", "weekly_scan"],
  month: ["last_30d", "monthly_scan"],
};

/** Per-genre leaderboard + posting-time histogram for the given period. */
export async function getTrendSummary(
  period: "week" | "month",
  niche = "reddit"
): Promise<TrendGenreSummary[]> {
  const scanWindow = PERIOD_WINDOWS[period];
  const out: TrendGenreSummary[] = [];

  for (const [genreId, meta] of Object.entries(REDDIT_GENRES)) {
    const refs = await TrendReference.find({ niche, genre: genreId, scanWindow: { $in: scanWindow } })
      .sort({ "metrics.views": -1 })
      .limit(50);
    if (!refs.length) continue;

    const topPerformers: TrendTopPerformer[] = refs.slice(0, 5).map((r) => ({
      title: r.title,
      thumbnailUrl: r.thumbnailUrl,
      channelTitle: r.channelTitle,
      sourceUrl: r.sourceUrl,
      views: r.metrics?.views,
      postedAt: r.metrics?.postedAt,
    }));

    const buckets = new Map<string, number>();
    for (const r of refs) {
      if (r.dayOfWeek === undefined || r.hourUtc === undefined) continue;
      const key = `${r.dayOfWeek}-${r.hourUtc}`;
      // log-dampen so one outlier viral video doesn't dominate the bucket
      const weight = Math.log10((r.metrics?.views ?? 1) + 1);
      buckets.set(key, (buckets.get(key) ?? 0) + weight);
    }
    const postingBuckets: TrendPostingBucket[] = [...buckets.entries()]
      .map(([key, weightedScore]) => {
        const [dayOfWeek, hourUtc] = key.split("-").map(Number);
        return { dayOfWeek, hourUtc, weightedScore };
      })
      .sort((a, b) => b.weightedScore - a.weightedScore);

    out.push({
      genre: genreId,
      displayLabel: meta.label,
      sampleSize: refs.length,
      topPerformers,
      postingBuckets,
      bestPostingTime: postingBuckets[0]
        ? { dayOfWeek: postingBuckets[0].dayOfWeek, hourUtc: postingBuckets[0].hourUtc }
        : undefined,
    });
  }

  return out.sort((a, b) => (b.topPerformers[0]?.views ?? 0) - (a.topPerformers[0]?.views ?? 0));
}
