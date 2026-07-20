import { createHash } from "node:crypto";
import {
  OwnedMetricSnapshot,
  PerformanceEvidenceCard,
  Reel,
  type IOwnedMetricSnapshot,
  type OwnedAnalyticsPlatform,
  type PerformanceEvidenceConfidence,
} from "../models";
import { getErrorMessage } from "../types";
import { fetchOwnedYouTubeVideoMetrics } from "./youtube-publish.service";
import { fetchOwnedInstagramMediaMetrics } from "./instagram-publish.service";
import { fetchOwnedFacebookReelMetrics } from "./facebook-publish.service";
import { fetchOwnedThreadsMediaMetrics } from "./threads-publish.service";
import { recordOperationLog } from "./operation-log.service";

const COLLECTOR_VERSION = "owned-analytics-v1";
const WINDOW_DAYS = 90;
const STABLE_AGE_HOURS = 72;
const REFRESH_YOUNG_HOURS = 6;
const REFRESH_OLDER_HOURS = 7 * 24;

interface PlatformMetricResult {
  accountLabel: string;
  platformAccountId?: string;
  metrics: Record<string, number>;
  available: string[];
  limitations: string[];
  provider?: Record<string, unknown>;
}

interface PublishedTarget {
  platform: OwnedAnalyticsPlatform;
  accountKey: string;
  accountLabel?: string;
  mediaId: string;
  url?: string;
  publishedAt?: Date;
  firstCommentKind: "discussion" | "series_navigation" | "story_request" | "none" | "unknown";
}

export interface OwnedAnalyticsSyncResult {
  scanned: number;
  skippedFresh: number;
  snapshotsCreated: number;
  unavailable: number;
  failed: { platform: OwnedAnalyticsPlatform; accountKey: string; mediaId: string; error: string }[];
  cardsRebuilt: number;
  requiresReauth: { platform: OwnedAnalyticsPlatform; accountKey: string; error: string }[];
}

function hoursSince(date: Date | undefined, now = new Date()): number {
  if (!date) return 0;
  return Math.max(0, (now.getTime() - date.getTime()) / 3_600_000);
}

function extractHashtags(value: string): string[] {
  return [...value.matchAll(/#[\p{L}\p{N}_]+/gu)].map((match) => match[0].toLowerCase()).slice(0, 8);
}

function hookType(value: string): string {
  const text = value.trim().toLowerCase();
  if (!text) return "unknown";
  if (text.includes("?") || /^(aita|am i|would you|should i|is it)/.test(text)) return "question";
  if (/\b(after|then|until|when|because)\b/.test(text)) return "consequence";
  if (/\b(accused|called|caught|refused|lied|stole|betrayed)\b/.test(text)) return "accusation";
  if (/\b(turns out|but then|instead|actually|only to)\b/.test(text)) return "reversal";
  return "dilemma";
}

function titleForPlatform(reel: InstanceType<typeof Reel>, platform: OwnedAnalyticsPlatform): string {
  if (platform === "youtube") return reel.review?.title ?? reel.title ?? reel.hook ?? reel.topic ?? "";
  if (platform === "instagram") return reel.instagramSettings?.caption ?? reel.title ?? reel.hook ?? "";
  if (platform === "facebook") return reel.facebookSettings?.description ?? reel.review?.description ?? reel.title ?? reel.hook ?? "";
  return reel.threadsSettings?.text ?? reel.title ?? reel.hook ?? "";
}

function targetsForReel(reel: InstanceType<typeof Reel>): PublishedTarget[] {
  const targets: PublishedTarget[] = [];
  if (reel.youtube?.status === "published" && reel.youtube.videoId && reel.youtube.channelId) {
    targets.push({
      platform: "youtube", accountKey: reel.youtube.channelId, accountLabel: reel.youtube.channelLabel,
      mediaId: reel.youtube.videoId, url: reel.youtube.url, publishedAt: reel.youtube.publishedAt,
      firstCommentKind: reel.youtube.firstCommentStatus === "posted" ? "discussion" : "none",
    });
  }
  for (const publish of reel.instagram ?? []) if (publish.status === "published" && publish.mediaId) {
    targets.push({ platform: "instagram", accountKey: publish.channelId, accountLabel: publish.channelLabel, mediaId: publish.mediaId, url: publish.url, publishedAt: publish.publishedAt, firstCommentKind: publish.firstCommentStatus === "posted" ? "discussion" : "none" });
  }
  for (const publish of reel.facebook ?? []) if (publish.status === "published" && publish.videoId) {
    targets.push({ platform: "facebook", accountKey: publish.channelId, accountLabel: publish.channelLabel, mediaId: publish.videoId, url: publish.url, publishedAt: publish.publishedAt, firstCommentKind: publish.firstCommentStatus === "posted" ? "discussion" : "none" });
  }
  for (const publish of reel.threads ?? []) if (publish.status === "published" && publish.mediaId) {
    targets.push({ platform: "threads", accountKey: publish.channelId, accountLabel: publish.channelLabel, mediaId: publish.mediaId, url: publish.url, publishedAt: publish.publishedAt, firstCommentKind: publish.firstCommentStatus === "posted" ? "discussion" : "none" });
  }
  return targets;
}

async function fetchPlatformMetrics(target: PublishedTarget): Promise<PlatformMetricResult> {
  if (target.platform === "youtube") return fetchOwnedYouTubeVideoMetrics(target.accountKey, target.mediaId);
  if (target.platform === "instagram") return fetchOwnedInstagramMediaMetrics(target.accountKey, target.mediaId);
  if (target.platform === "facebook") return fetchOwnedFacebookReelMetrics(target.accountKey, target.mediaId);
  return fetchOwnedThreadsMediaMetrics(target.accountKey, target.mediaId);
}

function normalizeMetrics(platform: OwnedAnalyticsPlatform, source: Record<string, number>) {
  const first = (...keys: string[]) => keys.map((key) => source[key]).find((value) => typeof value === "number");
  const watchedMinutes = first("estimatedMinutesWatched");
  const avgDuration = first("averageViewDuration", "ig_reels_avg_watch_time", "post_video_avg_time_watched");
  return {
    views: first("views", "total_views", "post_video_views"),
    reach: first("reach"),
    plays: first("plays", "total_views", "views"),
    engagedViews: first("engagedViews"),
    watchTimeSeconds: watchedMinutes === undefined ? first("ig_reels_video_view_total_time", "post_video_view_time") : watchedMinutes * 60,
    averageViewDurationSeconds: avgDuration,
    averageViewPercentage: first("averageViewPercentage"),
    likes: first("likes"),
    comments: first("comments", "replies"),
    shares: first("shares"),
    saves: first("saved"),
    reposts: first("reposts"),
    quotes: first("quotes"),
    follows: first("follows"),
    subscribersGained: first("subscribersGained"),
    provider: { platform, metrics: source },
  };
}

function needsRefresh(lastSnapshot: Pick<IOwnedMetricSnapshot, "fetch" | "available"> | null, publishedAt?: Date): boolean {
  if (!lastSnapshot) return true;
  // A publication record protects the creative snapshot before its first API
  // pull; it is not itself a metric observation and must not delay that pull.
  if (!lastSnapshot.available.metrics.length) return true;
  const ageHours = hoursSince(publishedAt);
  const waited = hoursSince(lastSnapshot.fetch.fetchedAt);
  return waited >= (ageHours < 14 * 24 ? REFRESH_YOUNG_HOURS : REFRESH_OLDER_HOURS);
}

/**
 * Freeze the creative context at successful publication, before later Studio
 * edits can affect it. This writes no provider data and makes no API request.
 */
export async function registerOwnedPublication(reel: InstanceType<typeof Reel>, target: PublishedTarget): Promise<void> {
  const existing = await OwnedMetricSnapshot.exists({
    platform: target.platform,
    "account.key": target.accountKey,
    "media.id": target.mediaId,
  });
  if (existing) return;
  await OwnedMetricSnapshot.create({
    reel: { id: reel._id, niche: reel.niche, genre: reel.genre ?? "general", partNumber: reel.partNumber, seriesKey: reel.seriesId },
    platform: target.platform,
    account: { key: target.accountKey, label: target.accountLabel },
    media: { id: target.mediaId, type: target.platform === "threads" ? "post" : target.platform === "youtube" ? "short" : "reel", url: target.url },
    publish: { status: "published", publishedAt: target.publishedAt ?? new Date() },
    fetch: { fetchedAt: new Date(), source: "backfill", collectorVersion: COLLECTOR_VERSION },
    raw: {},
    available: { metrics: [], insights: [], missing: [], limitations: ["Creative snapshot captured at publish; first API metric pull is pending."] },
    features: snapshotFeatures(reel, target.platform, target),
  });
}

function snapshotFeatures(reel: InstanceType<typeof Reel>, platform: OwnedAnalyticsPlatform, target: PublishedTarget) {
  const title = titleForPlatform(reel, platform).trim().slice(0, 2_200);
  const durationSeconds = reel.scenes.reduce((sum, scene) => sum + (scene.duration || 0), 0);
  return {
    hookType: hookType(reel.hook ?? title),
    narrativeFormat: reel.partCount && reel.partCount > 1 ? "series" as const : "standalone" as const,
    durationSeconds: durationSeconds || undefined,
    title: title || undefined,
    titleLength: title.length || undefined,
    captionLength: platform === "instagram" || platform === "facebook" || platform === "threads" ? title.length : undefined,
    keywordPhrases: [reel.genre, reel.niche, reel.redditStory?.subreddit?.replace(/^r\//i, "")].filter((value): value is string => Boolean(value)).slice(0, 4),
    hashtags: extractHashtags(title),
    firstCommentKind: target.firstCommentKind,
  };
}

function isAuthError(message: string): boolean {
  return /token|oauth|permission|scope|access|reauth|authorization/i.test(message);
}

/**
 * On-demand collector. It has no timer/cron: the user decides when to pull
 * first-party metrics while this local server is online. Provider failures are
 * isolated to their one destination so Instagram/YouTube etc. keep syncing.
 */
export async function syncOwnedAnalytics(input: { platform?: OwnedAnalyticsPlatform; accountKey?: string } = {}): Promise<OwnedAnalyticsSyncResult> {
  const now = new Date();
  const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const reels = await Reel.find({
    $or: [
      { "youtube.status": "published" }, { "instagram.status": "published" },
      { "facebook.status": "published" }, { "threads.status": "published" },
    ],
  }).sort({ updatedAt: -1 }).limit(600);
  const result: OwnedAnalyticsSyncResult = { scanned: 0, skippedFresh: 0, snapshotsCreated: 0, unavailable: 0, failed: [], cardsRebuilt: 0, requiresReauth: [] };
  const affected = new Set<string>();

  for (const reel of reels) {
    for (const target of targetsForReel(reel)) {
      if (input.platform && target.platform !== input.platform) continue;
      if (input.accountKey && target.accountKey !== input.accountKey) continue;
      if (target.publishedAt && target.publishedAt < since) continue;
      result.scanned += 1;
      const last = await OwnedMetricSnapshot.findOne({ platform: target.platform, "account.key": target.accountKey, "media.id": target.mediaId }).sort({ "fetch.fetchedAt": -1 }).select({ fetch: 1, available: 1 }).lean();
      if (!needsRefresh(last, target.publishedAt)) { result.skippedFresh += 1; continue; }
      try {
        const response = await fetchPlatformMetrics(target);
        const raw = normalizeMetrics(target.platform, response.metrics);
        await OwnedMetricSnapshot.create({
          reel: { id: reel._id, niche: reel.niche, genre: reel.genre ?? "general", partNumber: reel.partNumber, seriesKey: reel.seriesId },
          platform: target.platform,
          account: { key: target.accountKey, label: response.accountLabel || target.accountLabel, platformAccountId: response.platformAccountId },
          media: { id: target.mediaId, type: target.platform === "threads" ? "post" : target.platform === "youtube" ? "short" : "reel", url: target.url },
          publish: { status: "published", publishedAt: target.publishedAt },
          fetch: { fetchedAt: now, source: "api", collectorVersion: COLLECTOR_VERSION },
          raw,
          available: { metrics: response.available, insights: response.available, missing: [], limitations: response.limitations },
          features: snapshotFeatures(reel, target.platform, target),
        });
        result.snapshotsCreated += 1;
        if (!response.available.length) result.unavailable += 1;
        affected.add(`${target.platform}:${target.accountKey}:${reel.genre ?? "general"}`);
      } catch (error) {
        const message = getErrorMessage(error);
        result.failed.push({ platform: target.platform, accountKey: target.accountKey, mediaId: target.mediaId, error: message });
        if (isAuthError(message)) result.requiresReauth.push({ platform: target.platform, accountKey: target.accountKey, error: message });
      }
    }
  }
  for (const key of affected) {
    const [platform, accountKey, genre] = key.split(":") as [OwnedAnalyticsPlatform, string, string];
    result.cardsRebuilt += await rebuildOwnedEvidenceCards(platform, genre, accountKey);
  }
  recordOperationLog({
    scope: "system",
    event: "analytics.owned_sync_completed",
    message: "Completed manual first-party analytics sync",
    metadata: { ...result },
  });
  return result;
}

type LatestSnapshot = IOwnedMetricSnapshot & { _id: unknown };

function primaryRate(snapshot: LatestSnapshot): number | undefined {
  const raw = snapshot.raw;
  const denominator = raw.reach ?? raw.views ?? raw.engagedViews;
  if (snapshot.platform === "youtube") {
    if (typeof raw.averageViewPercentage === "number") return raw.averageViewPercentage / 100;
    if (denominator && typeof raw.engagedViews === "number") return raw.engagedViews / denominator;
  }
  if (!denominator) return undefined;
  if (snapshot.platform === "instagram") return ((raw.shares ?? 0) + (raw.saves ?? 0) + (raw.comments ?? 0)) / denominator;
  if (snapshot.platform === "threads") return ((raw.comments ?? 0) + (raw.reposts ?? 0) + (raw.quotes ?? 0)) / denominator;
  return ((raw.shares ?? 0) + (raw.comments ?? 0)) / denominator;
}

function confidenceFor(posts: LatestSnapshot[], rates: number[]): { level: PerformanceEvidenceConfidence; score: number; reasons: string[] } {
  const distinctReels = new Set(posts.map((post) => post.reel.id.toString())).size;
  const coverage = posts.length ? rates.length / posts.length : 0;
  const count = posts.length;
  const reasons = [`${count} eligible published post${count === 1 ? "" : "s"}`, `${distinctReels} distinct reel${distinctReels === 1 ? "" : "s"}`, `${Math.round(coverage * 100)}% primary-metric coverage`];
  const score = Math.min(1, (count / 15) * (distinctReels / 8) * coverage);
  if (count >= 15 && distinctReels >= 8 && coverage >= 0.8) return { level: "high", score, reasons };
  if (count >= 6 && distinctReels >= 5 && coverage >= 0.7) return { level: "medium", score, reasons };
  return { level: "low", score, reasons };
}

function mean(values: number[]): number | undefined {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

function insightForGroup(platform: OwnedAnalyticsPlatform, posts: LatestSnapshot[]) {
  const rates = posts.map(primaryRate).filter((value): value is number => value !== undefined && Number.isFinite(value));
  const confidence = confidenceFor(posts, rates);
  const allBaseline = mean(rates);
  const byHook = new Map<string, number[]>();
  for (const post of posts) {
    const rate = primaryRate(post);
    const key = post.features.hookType ?? "unknown";
    if (rate === undefined || key === "unknown") continue;
    byHook.set(key, [...(byHook.get(key) ?? []), rate]);
  }
  const winner = [...byHook.entries()]
    .map(([key, values]) => ({ key, values, average: mean(values) ?? 0 }))
    .filter((row) => row.values.length >= 2 && allBaseline && row.average >= allBaseline * 1.1)
    .sort((a, b) => b.average - a.average)[0];
  const supportsGuidance = confidence.level !== "low" && Boolean(winner);
  const objective = platform === "youtube" ? "average viewed percentage / engaged views" : platform === "instagram" ? "shares, saves and comments per reach" : platform === "threads" ? "replies, reposts and quotes per view" : "shares and comments per view/reach";
  const summary = supportsGuidance
    ? `${winner!.key}-style openings outperformed this comparable owned cohort by ${Math.round(((winner!.average / (allBaseline ?? 1)) - 1) * 100)}% on ${objective}. Treat this as ${confidence.level}-confidence guidance, never a promise.`
    : confidence.level === "low"
      ? `Not enough comparable owned ${platform} posts for a creative recommendation. Use strict platform defaults only.`
      : `Owned ${platform} metrics are available, but no repeatable creative pattern clears the safety threshold yet. Keep using strict platform defaults.`;
  return {
    guidance: {
      summary,
      hookPatterns: supportsGuidance ? [`Prefer a truthful ${winner!.key}-style opening when the story naturally supports it.`] : [],
      titlePatterns: [], keywordPhrases: [], interactionPatterns: [],
      cautions: ["This compares only your own posts; missing platform metrics are never treated as zero.", "Do not invent stakes to fit a detected pattern."],
    },
    confidence,
    rates,
  };
}

async function rebuildOneCard(platform: OwnedAnalyticsPlatform, genre: string, accountKey?: string): Promise<boolean> {
  const endsAt = new Date();
  const startsAt = new Date(endsAt.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const query: Record<string, unknown> = { platform, "reel.genre": genre, "fetch.fetchedAt": { $gte: startsAt }, "publish.publishedAt": { $lte: new Date(endsAt.getTime() - STABLE_AGE_HOURS * 3_600_000) }, "available.metrics.0": { $exists: true } };
  if (accountKey) query["account.key"] = accountKey;
  const rows = await OwnedMetricSnapshot.find(query).sort({ "fetch.fetchedAt": -1 }).lean() as LatestSnapshot[];
  const latest = new Map<string, LatestSnapshot>();
  for (const row of rows) {
    const key = `${row.account.key}:${row.media.id}`;
    if (!latest.has(key)) latest.set(key, row);
  }
  const posts = [...latest.values()];
  if (!posts.length) return false;
  const card = insightForGroup(platform, posts);
  const fingerprint = createHash("sha256").update(posts.map((post) => `${post._id}:${post.fetch.fetchedAt.toISOString()}`).sort().join("|")).digest("hex").slice(0, 16);
  await PerformanceEvidenceCard.findOneAndUpdate(
    { platform, "account.scope": accountKey ? "account" : "all", "account.key": accountKey, genre, "window.key": "last_90d" },
    {
      platform, account: { scope: accountKey ? "account" : "all", ...(accountKey ? { key: accountKey, label: posts[0]?.account.label } : {}) }, genre,
      window: { key: "last_90d", startsAt, endsAt, days: WINDOW_DAYS }, guidance: card.guidance,
      confidence: { level: card.confidence.level, score: card.confidence.score, sampleSize: posts.length, reelCount: new Set(posts.map((post) => post.reel.id.toString())).size, snapshotCount: rows.length, reasons: card.confidence.reasons },
      source: { aggregatorVersion: COLLECTOR_VERSION, inputFingerprint: fingerprint, generatedAt: endsAt },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return true;
}

export async function rebuildOwnedEvidenceCards(platform: OwnedAnalyticsPlatform, genre: string, accountKey?: string): Promise<number> {
  let rebuilt = 0;
  if (accountKey && await rebuildOneCard(platform, genre, accountKey)) rebuilt += 1;
  if (await rebuildOneCard(platform, genre)) rebuilt += 1;
  return rebuilt;
}

/** Prompt-safe retrieval. We never return raw post/snapshot rows to the LLM. */
export async function getOwnedAnalyticsGuidance(platform: OwnedAnalyticsPlatform, genre?: string, accountKey?: string): Promise<string | undefined> {
  if (!genre) return undefined;
  const base = { platform, genre, "window.key": "last_90d" };
  const exact = accountKey ? await PerformanceEvidenceCard.findOne({ ...base, "account.scope": "account", "account.key": accountKey }).lean() : undefined;
  const card = exact ?? await PerformanceEvidenceCard.findOne({ ...base, "account.scope": "all" }).lean();
  if (!card || card.confidence.level === "low") return undefined;
  return `OWNED ${platform.toUpperCase()} PERFORMANCE (${card.confidence.level} confidence; ${card.confidence.sampleSize} eligible posts, last ${card.window.days} days):\n${card.guidance.summary}\n${card.guidance.hookPatterns.map((value) => `- ${value}`).join("\n")}\nThis is first-party evidence for this platform only; it cannot override story truth or the platform defaults.`.trim();
}

export async function getOwnedAnalyticsOverview() {
  const [snapshots, cards, platformRows] = await Promise.all([
    OwnedMetricSnapshot.countDocuments(),
    PerformanceEvidenceCard.find().sort({ "source.generatedAt": -1 }).limit(100).lean(),
    OwnedMetricSnapshot.aggregate<{ _id: OwnedAnalyticsPlatform; snapshots: number; lastFetchedAt?: Date }>([
      { $group: { _id: "$platform", snapshots: { $sum: 1 }, lastFetchedAt: { $max: "$fetch.fetchedAt" } } },
    ]),
  ]);
  return {
    snapshots,
    cards,
    platforms: platformRows.map((row) => ({ platform: row._id, snapshots: row.snapshots, lastFetchedAt: row.lastFetchedAt })),
  };
}
