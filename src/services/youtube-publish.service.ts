import { google, type youtube_v3 } from "googleapis";
import type { MethodOptions } from "googleapis-common";
import ffmpeg from "fluent-ffmpeg";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "../config";
import { OAuthState, Reel, YouTubeChannel } from "../models";
import { getErrorMessage } from "../types";
import { recordOperationLog } from "./operation-log.service";
import { ensureReelReviewPackage } from "./reel-review.service";
import { resolveRenderedPublishDestination } from "./reel-outro.service";
import { buildFirstCommentText } from "./post-comment.service";
import { assertDailyPublishLimit } from "./publish-guard.service";
import { applyOutputOptions } from "../utils";

export interface YouTubePublishChannel {
  id: string;
  label: string;
  refreshToken: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  privacyStatus?: "private" | "unlisted" | "public";
  categoryId?: string;
  niches?: string[];
}

export interface PublicYouTubePublishChannel {
  id: string;
  label: string;
  googleChannelId?: string;
  googleChannelTitle?: string;
  googleChannelHandle?: string;
  logoUrl?: string;
  privacyStatus: "private" | "unlisted" | "public";
  categoryId: string;
  niches?: string[];
  isDefault: boolean;
  source: "env" | "database";
  status?: "active" | "needs_reauth" | "disabled";
  lastError?: string;
}

export interface StartYouTubeConnectInput {
  label: string;
  channelKey?: string;
  privacyStatus?: "private" | "unlisted" | "public";
  categoryId?: string;
  niches?: string[];
}

/** Bun's fetch idle timeout (~5 min) aborts large resumable uploads to Google. */
const fetchWithoutIdleTimeout = ((
  input: Parameters<typeof fetch>[0],
  init?: RequestInit
) => fetch(input, { ...init, timeout: false } as RequestInit & { timeout: false })) as typeof fetch;

const YOUTUBE_API_OPTIONS: MethodOptions = {
  fetchImplementation: fetchWithoutIdleTimeout,
  // Safety net only — the Bun idle timer is disabled via fetchImplementation above.
  timeout: 60 * 60 * 1000,
};

/** YouTube Data API custom-thumbnail limit (2 MiB). */
const YOUTUBE_THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

/** Shorts shelf / channel grid uses a vertical cover (`oar2`), not the classic
 *  16:9 `maxresdefault` that `thumbnails.set` historically updates. */
const SHORTS_COVER_W = 1080;
const SHORTS_COVER_H = 1920;

async function encodeThumbnailJpeg(
  inputPath: string,
  outputPath: string,
  quality: number,
  vf: string
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cmd = ffmpeg(inputPath);
    applyOutputOptions(cmd, ["-vf", vf, "-q:v", String(quality)])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err: Error) =>
        reject(new Error(`YouTube thumbnail compress failed: ${err.message}`))
      )
      .run();
  });
}

/**
 * Prepare a Shorts-friendly custom thumbnail: always JPEG, always 9:16
 * (1080×1920). Uploading a 16:9 PNG often updates only `maxresdefault` while
 * the Shorts shelf keeps an auto-picked vertical frame (`oar2`).
 */
async function prepareYouTubeShortsThumbnail(image: Buffer): Promise<{
  buffer: Buffer;
  mimeType: "image/jpeg";
}> {
  const dir = await mkdtemp(join(tmpdir(), "yt-thumb-"));
  const inputPath = join(dir, "input.png");
  const outputPath = join(dir, "output.jpg");
  try {
    await writeFile(inputPath, image);
    const vf =
      `scale=${SHORTS_COVER_W}:${SHORTS_COVER_H}:force_original_aspect_ratio=increase,` +
      `crop=${SHORTS_COVER_W}:${SHORTS_COVER_H}`;
    const qualities = [3, 5, 8, 12, 18, 24, 31];
    for (const quality of qualities) {
      await encodeThumbnailJpeg(inputPath, outputPath, quality, vf);
      const compressed = await readFile(outputPath);
      if (compressed.length <= YOUTUBE_THUMBNAIL_MAX_BYTES) {
        console.log(
          `🖼️  Shorts cover prepared ${Math.round(image.length / 1024)} KB → ` +
            `${Math.round(compressed.length / 1024)} KB (9:16 ${SHORTS_COVER_W}x${SHORTS_COVER_H}, q=${quality})`
        );
        return { buffer: compressed, mimeType: "image/jpeg" };
      }
    }
    throw new Error(
      `Could not compress Shorts cover below ${YOUTUBE_THUMBNAIL_MAX_BYTES} bytes (source ${image.length} bytes)`
    );
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function fetchYouTubeCoverBytes(videoId: string, name: "oar2" | "maxresdefault"): Promise<Buffer | null> {
  const url = `https://i.ytimg.com/vi/${videoId}/${name}.jpg?t=${Date.now()}`;
  try {
    const res = await fetchWithoutIdleTimeout(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Wait briefly for CDN to refresh the Shorts vertical cover after thumbnails.set. */
async function verifyShortsCoverApplied(
  videoId: string,
  beforeOar: Buffer | null
): Promise<"applied" | "unchanged" | "unknown"> {
  if (!beforeOar) return "unknown";
  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise((r) => setTimeout(r, 2500));
    const after = await fetchYouTubeCoverBytes(videoId, "oar2");
    if (after && !after.equals(beforeOar)) return "applied";
  }
  return "unchanged";
}

async function downloadVideoToTempFile(url: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "yt-publish-"));
  const path = join(dir, "video.mp4");
  const res = await fetchWithoutIdleTimeout(url);
  if (!res.ok || !res.body) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`Failed to fetch rendered video (${res.status})`);
  }
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(path));
  return { dir, path };
}

// ============================================
// YouTube Data API v3 publishing. Uses a single pre-authorized channel
// (refresh token minted once via `scripts/youtube-authorize.ts`) — matches
// the "content farm first, one channel/niche at a time" model, not
// multi-tenant SaaS. Publish is a separate stage from rendering: it reads the
// exact already-rendered destination output (S3/CDN) and never touches the
// render pipeline, so a failed/retried publish never re-spends on assets.
// ============================================

export function getYouTubeOAuthClient() {
  return getYouTubeOAuthClientForRefreshToken(
    config.youtubeRefreshToken,
    config.youtubeClientId,
    config.youtubeClientSecret,
    config.youtubeRedirectUri
  );
}

function getYouTubeOAuthClientForRefreshToken(
  refreshToken: string,
  clientId = config.youtubeClientId,
  clientSecret = config.youtubeClientSecret,
  redirectUri = config.youtubeRedirectUri
) {
  if (!clientId || !clientSecret) {
    throw new Error("YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET not configured");
  }
  const client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    redirectUri
  );
  if (refreshToken) {
    client.setCredentials({ refresh_token: refreshToken });
  }
  return client;
}

function getYouTubeOAuthClientWithoutCredentials() {
  if (!config.youtubeConnectClientId || !config.youtubeConnectClientSecret) {
    throw new Error("YOUTUBE_CONNECT_CLIENT_ID / YOUTUBE_CONNECT_CLIENT_SECRET not configured");
  }
  return new google.auth.OAuth2(
    config.youtubeConnectClientId,
    config.youtubeConnectClientSecret,
    config.youtubeConnectRedirectUri
  );
}

function encryptionKey(): Buffer {
  const source =
    config.youtubeTokenEncryptionKey ||
    config.youtubeClientSecret ||
    config.mongodbUri;
  return createHash("sha256").update(source).digest();
}

function encryptToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptToken(encryptedToken: string): string {
  const [version, iv, tag, encrypted] = encryptedToken.split(":");
  if (version !== "v1" || !iv || !tag || !encrypted) {
    throw new Error("Unsupported encrypted YouTube token format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function slugifyChannelKey(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || `youtube-${Date.now()}`;
}

function parseYouTubeChannels(): YouTubePublishChannel[] {
  const channels: YouTubePublishChannel[] = [];
  if (config.youtubeChannelsJson.trim()) {
    const parsed = JSON.parse(config.youtubeChannelsJson) as unknown;
    if (!Array.isArray(parsed)) throw new Error("YOUTUBE_CHANNELS_JSON must be a JSON array");
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const record = item as Partial<YouTubePublishChannel>;
      if (!record.id || !record.label || !record.refreshToken) {
        throw new Error("Each YOUTUBE_CHANNELS_JSON item needs id, label, and refreshToken");
      }
      channels.push({
        id: record.id,
        label: record.label,
        refreshToken: record.refreshToken,
        clientId: record.clientId,
        clientSecret: record.clientSecret,
        redirectUri: record.redirectUri,
        privacyStatus: record.privacyStatus,
        categoryId: record.categoryId,
        niches: record.niches,
      });
    }
  }

  if (config.youtubeRefreshToken && !channels.some((channel) => channel.id === "default")) {
    channels.unshift({
      id: "default",
      label: "Default YouTube Channel",
      refreshToken: config.youtubeRefreshToken,
      clientId: config.youtubeClientId,
      clientSecret: config.youtubeClientSecret,
      redirectUri: config.youtubeRedirectUri,
      privacyStatus: config.youtubePrivacyStatus,
      categoryId: config.youtubeCategoryId,
    });
  }
  return channels;
}

export function listYouTubePublishChannels(): PublicYouTubePublishChannel[] {
  return parseYouTubeChannels().map((channel, index) => ({
    id: channel.id,
    label: channel.label,
    privacyStatus: channel.privacyStatus ?? config.youtubePrivacyStatus,
    categoryId: channel.categoryId ?? config.youtubeCategoryId,
    niches: channel.niches,
    isDefault: index === 0,
    source: "env",
  }));
}

/** Environment-configured channels historically contained only an internal
 * label + refresh token. Resolve their real channel identity for account UI
 * parity with channels connected through our OAuth flow. A failed metadata
 * lookup is intentionally non-fatal: publishing can still work with the
 * narrower legacy `youtube.upload` token scope. */
async function enrichEnvChannel(
  channel: YouTubePublishChannel,
  index: number
): Promise<PublicYouTubePublishChannel> {
  const fallback: PublicYouTubePublishChannel = {
    id: channel.id,
    label: channel.label,
    privacyStatus: channel.privacyStatus ?? config.youtubePrivacyStatus,
    categoryId: channel.categoryId ?? config.youtubeCategoryId,
    niches: channel.niches,
    isDefault: index === 0,
    source: "env",
  };
  try {
    const auth = getYouTubeOAuthClientForRefreshToken(
      channel.refreshToken,
      channel.clientId,
      channel.clientSecret,
      channel.redirectUri
    );
    const youtube = google.youtube({ version: "v3", auth });
    const response = await youtube.channels.list({ part: ["snippet"], mine: true });
    const profile = response.data.items?.[0];
    if (!profile) return fallback;
    return {
      ...fallback,
      googleChannelId: profile.id ?? undefined,
      googleChannelTitle: profile.snippet?.title ?? undefined,
      googleChannelHandle: profile.snippet?.customUrl ?? undefined,
      logoUrl:
        profile.snippet?.thumbnails?.high?.url ??
        profile.snippet?.thumbnails?.medium?.url ??
        profile.snippet?.thumbnails?.default?.url ??
        undefined,
    };
  } catch (error: unknown) {
    recordOperationLog({
      scope: "external",
      level: "warn",
      event: "youtube.channel_metadata_fallback",
      message: "Could not enrich an environment YouTube channel; keeping its configured label",
      metadata: { channelId: channel.id },
      error,
    });
    return fallback;
  }
}

export async function listAllYouTubePublishChannels(): Promise<PublicYouTubePublishChannel[]> {
  const envConfiguredChannels = parseYouTubeChannels();
  const dbChannels = await YouTubeChannel.find({ status: { $ne: "disabled" } })
    .sort({ createdAt: 1 })
    .lean();
  const databaseByKey = new Map(dbChannels.map((channel) => [channel.channelKey, channel]));
  // A channel re-authorized from the Accounts UI is deliberately stored in the
  // database, even when it was originally configured via YOUTUBE_CHANNELS_JSON.
  // The database credential must shadow the stale environment token everywhere:
  // publishing already resolves database channels first, and this keeps the
  // Accounts screen from rendering two copies of the same destination.
  const envChannels = await Promise.all(
    envConfiguredChannels
      .filter((channel) => !databaseByKey.has(channel.id))
      .map((channel, index) => enrichEnvChannel(channel, index))
  );
  return [
    ...envChannels,
    ...dbChannels.map((channel) => ({
      id: channel.channelKey,
      label: channel.label,
      googleChannelId: channel.googleChannelId,
      googleChannelTitle: channel.googleChannelTitle,
      googleChannelHandle: channel.googleChannelHandle,
      logoUrl: channel.logoUrl,
      privacyStatus: channel.privacyStatus,
      categoryId: channel.categoryId,
      niches: channel.niches,
      isDefault: envChannels.length === 0 && dbChannels[0]?._id.equals(channel._id),
      source: "database" as const,
      status: channel.status,
      lastError: channel.lastError,
    })),
  ];
}

async function resolveYouTubePublishChannel(channelId?: string): Promise<YouTubePublishChannel> {
  const dbQuery = channelId
    ? { channelKey: channelId, status: { $ne: "disabled" } }
    : { status: "active" as const };
  const dbChannel = await YouTubeChannel.findOne(dbQuery).sort({ createdAt: 1 });
  if (dbChannel) {
    return {
      id: dbChannel.channelKey,
      label: dbChannel.label,
      refreshToken: decryptToken(dbChannel.encryptedRefreshToken),
      clientId: config.youtubeConnectClientId,
      clientSecret: config.youtubeConnectClientSecret,
      redirectUri: config.youtubeConnectRedirectUri,
      privacyStatus: dbChannel.privacyStatus,
      categoryId: dbChannel.categoryId,
      niches: dbChannel.niches,
    };
  }

  const channels = parseYouTubeChannels();
  if (!channels.length) {
    throw new Error(
      "No YouTube channel configured — set YOUTUBE_REFRESH_TOKEN or YOUTUBE_CHANNELS_JSON"
    );
  }
  const channel = channelId
    ? channels.find((candidate) => candidate.id === channelId)
    : channels[0];
  if (!channel) throw new Error(`Unknown YouTube channel: ${channelId}`);
  return channel;
}

export async function startYouTubeChannelConnect(input: StartYouTubeConnectInput) {
  if (!input.label.trim()) throw new Error("Channel label is required");
  const auth = getYouTubeOAuthClientWithoutCredentials();
  const state = randomBytes(24).toString("base64url");
  await OAuthState.create({
    state,
    provider: "youtube",
    payload: {
      label: input.label.trim(),
      channelKey: input.channelKey?.trim() || slugifyChannelKey(input.label),
      privacyStatus: input.privacyStatus ?? config.youtubePrivacyStatus,
      categoryId: input.categoryId ?? config.youtubeCategoryId,
      niches: input.niches ?? [],
    },
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });

  const authUrl = auth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent select_account",
    scope: [
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube.readonly",
      // Owned-channel retention / engaged-view reporting. Existing channels
      // must reconnect once to grant this separate Analytics API scope.
      "https://www.googleapis.com/auth/yt-analytics.readonly",
      // Required for the own-post first comment + assisted read/reply layer
      // (commentThreads.insert / comments.insert). Channels connected before
      // this scope was added must reconnect once to grant it.
      "https://www.googleapis.com/auth/youtube.force-ssl",
    ],
    state,
  });
  return { authUrl };
}

export async function completeYouTubeChannelConnect(code: string, state: string) {
  const pending = await OAuthState.findOne({ state, provider: "youtube" });
  if (!pending || pending.expiresAt.getTime() < Date.now()) {
    throw new Error("YouTube connect session expired. Start again from the frontend.");
  }

  const auth = getYouTubeOAuthClientWithoutCredentials();
  const { tokens } = await auth.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error("Google did not return a refresh token. Remove app access and connect again.");
  }
  auth.setCredentials(tokens);
  const youtube = google.youtube({ version: "v3", auth });
  const channelRes = await youtube.channels.list({ part: ["snippet"], mine: true });
  const googleChannel = channelRes.data.items?.[0];
  const logoUrl =
    googleChannel?.snippet?.thumbnails?.high?.url ??
    googleChannel?.snippet?.thumbnails?.medium?.url ??
    googleChannel?.snippet?.thumbnails?.default?.url;
  const googleChannelHandle = googleChannel?.snippet?.customUrl;
  const channelKey = pending.payload.channelKey || slugifyChannelKey(pending.payload.label);

  const channel = await YouTubeChannel.findOneAndUpdate(
    { channelKey },
    {
      channelKey,
      label: pending.payload.label,
      googleChannelId: googleChannel?.id,
      googleChannelTitle: googleChannel?.snippet?.title,
      googleChannelHandle,
      logoUrl,
      encryptedRefreshToken: encryptToken(tokens.refresh_token),
      privacyStatus: pending.payload.privacyStatus,
      categoryId: pending.payload.categoryId,
      niches: pending.payload.niches,
      status: "active",
      lastError: undefined,
      lastConnectedAt: new Date(),
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  await pending.deleteOne();
  return channel;
}

export async function cancelYouTubeChannelConnect(state?: string): Promise<void> {
  if (!state) return;
  await OAuthState.deleteOne({ state, provider: "youtube" });
}

export async function disableYouTubeChannel(channelId: string): Promise<void> {
  await YouTubeChannel.updateOne(
    { channelKey: channelId },
    { $set: { status: "disabled" } }
  );
}

export async function updateYouTubeChannel(
  channelId: string,
  input: Partial<Pick<StartYouTubeConnectInput, "label" | "privacyStatus" | "categoryId" | "niches">>
) {
  const channel = await YouTubeChannel.findOne({ channelKey: channelId, status: { $ne: "disabled" } });
  if (!channel) throw new Error("This YouTube channel is environment-configured and must be edited in YOUTUBE_CHANNELS_JSON");
  if (input.label !== undefined) { if (!input.label.trim()) throw new Error("Channel label cannot be empty"); channel.label = input.label.trim(); }
  if (input.privacyStatus) channel.privacyStatus = input.privacyStatus;
  if (input.categoryId !== undefined) channel.categoryId = input.categoryId;
  if (input.niches !== undefined) channel.niches = input.niches;
  await channel.save();
  return channel;
}

/**
 * First-party reporting for a Short we published. This is deliberately kept
 * separate from the public search/scout path: the Analytics API only exposes
 * data for the connected owner's channel.
 */
export async function fetchOwnedYouTubeVideoMetrics(channelId: string, videoId: string): Promise<{
  accountLabel: string;
  platformAccountId?: string;
  metrics: Record<string, number>;
  available: string[];
  limitations: string[];
}> {
  const channel = await resolveYouTubePublishChannel(channelId);
  const auth = getYouTubeOAuthClientForRefreshToken(
    channel.refreshToken,
    channel.clientId,
    channel.clientSecret,
    channel.redirectUri,
  );
  const analytics = google.youtubeAnalytics({ version: "v2", auth });
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 92 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const response = await analytics.reports.query({
    ids: "channel==MINE",
    startDate,
    endDate,
    filters: `video==${videoId}`,
    metrics: "views,engagedViews,likes,comments,shares,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost",
  });
  const headers = response.data.columnHeaders?.map((header) => header.name ?? "") ?? [];
  const row = response.data.rows?.[0] ?? [];
  const metrics: Record<string, number> = {};
  headers.forEach((name, index) => {
    const value = row[index];
    if (name && typeof value === "number" && Number.isFinite(value)) metrics[name] = value;
  });
  return {
    accountLabel: channel.label,
    metrics,
    available: Object.keys(metrics),
    limitations: Object.keys(metrics).length ? [] : ["YouTube returned no report row for this video/date range yet."],
  };
}

/** Publish an already-rendered reel to YouTube as a Short. Updates `reel.youtube`. */
export async function publishReelToYouTube(reelId: string, channelId?: string): Promise<void> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  const destination = resolveRenderedPublishDestination(reel, "youtube", channelId);
  const channel = await resolveYouTubePublishChannel((channelId ?? destination.channelId) || reel.outroChannelId);
  await assertDailyPublishLimit("youtube");
  recordOperationLog({
    scope: "system",
    event: "publish.destination_output_selected",
    message: "Selected the destination-specific rendered output for YouTube publishing",
    reelId,
    metadata: { platform: "youtube", channelId: channel.id, destinationId: destination.id },
  });

  const previousPublish = {
    videoId: reel.youtube?.videoId,
    url: reel.youtube?.url,
    publishedAt: reel.youtube?.publishedAt,
    channelId: reel.youtube?.channelId,
    channelLabel: reel.youtube?.channelLabel,
    thumbnailStatus: reel.youtube?.thumbnailStatus,
    thumbnailError: reel.youtube?.thumbnailError,
  };

  reel.youtube = {
    ...previousPublish,
    status: "uploading",
    channelId: channel.id,
    channelLabel: channel.label,
  };
  await reel.save();

  try {
    const review = await ensureReelReviewPackage(reelId);
    const auth = getYouTubeOAuthClientForRefreshToken(
      channel.refreshToken,
      channel.clientId,
      channel.clientSecret,
      channel.redirectUri
    );
    const youtube = google.youtube({ version: "v3", auth, ...YOUTUBE_API_OPTIONS });

    const tempVideo = await downloadVideoToTempFile(destination.outputUrl!);
    let res;
    try {
      res = await youtube.videos.insert(
        {
          part: ["snippet", "status"],
          requestBody: {
            snippet: {
              title: (review.title ?? reel.title ?? reel.hook ?? "Untitled").slice(0, 100),
              description: review.description,
              tags: review.tags,
              categoryId: channel.categoryId ?? config.youtubeCategoryId,
            },
            status: {
              privacyStatus: channel.privacyStatus ?? config.youtubePrivacyStatus,
              selfDeclaredMadeForKids: false,
            },
          },
          media: { body: createReadStream(tempVideo.path) },
        },
        YOUTUBE_API_OPTIONS
      );
    } finally {
      await rm(tempVideo.dir, { recursive: true, force: true }).catch(() => {});
    }

    const videoId = res.data.id ?? undefined;
    let thumbnailStatus: "uploaded" | "missing" | "failed" = review.thumbnailUrl
      ? "failed"
      : "missing";
    let thumbnailError: string | undefined;
    let shortsCoverStatus: "applied" | "unchanged" | "unknown" | undefined;

    if (videoId && review.thumbnailUrl) {
      try {
        const thumbnailRes = await fetchWithoutIdleTimeout(review.thumbnailUrl);
        if (!thumbnailRes.ok) {
          throw new Error(`Failed to fetch thumbnail (${thumbnailRes.status})`);
        }
        const thumbnailBuffer = Buffer.from(await thumbnailRes.arrayBuffer());
        // Snapshot Shorts cover before upload so we can detect whether YouTube
        // actually replaced the vertical shelf image (oar2) vs only maxres.
        const beforeOar = await fetchYouTubeCoverBytes(videoId, "oar2");
        const { buffer: uploadBuffer, mimeType } =
          await prepareYouTubeShortsThumbnail(thumbnailBuffer);
        await youtube.thumbnails.set({
          videoId,
          media: {
            mimeType,
            body: Readable.from(uploadBuffer),
          },
        });
        thumbnailStatus = "uploaded";
        shortsCoverStatus = await verifyShortsCoverApplied(videoId, beforeOar);
        if (shortsCoverStatus === "applied") {
          console.log(`🖼️  Shorts cover (oar2) updated for ${reelId} (${videoId})`);
        } else if (shortsCoverStatus === "unchanged") {
          console.warn(
            `⚠️  Custom thumb API-accepted for ${reelId} (${videoId}) but Shorts cover (oar2) did not change — ` +
              `shelf may keep an auto video frame. Check YouTube Studio → Shorts cover / select a frame.`
          );
          recordOperationLog({
            scope: "external",
            level: "warn",
            event: "youtube.shorts_cover_unchanged",
            message: "YouTube accepted the thumbnail but did not update the observed Shorts shelf cover",
            reelId,
            metadata: { videoId },
          });
        } else {
          console.log(
            `🖼️  Custom thumbnail accepted for ${reelId} (${videoId}) — Shorts cover verify skipped (no prior oar2)`
          );
        }
      } catch (error: unknown) {
        thumbnailError = getErrorMessage(error);
        console.warn(`⚠️  Thumbnail upload failed for reel ${reelId}: ${thumbnailError}`);
        recordOperationLog({
          scope: "external",
          level: "warn",
          event: "youtube.thumbnail_upload_failed",
          message: "YouTube publish succeeded, but custom thumbnail upload failed",
          reelId,
          metadata: { videoId },
          error,
        });
      }
    }

    reel.youtube = {
      status: "published",
      videoId,
      url: videoId ? `https://youtube.com/shorts/${videoId}` : undefined,
      channelId: channel.id,
      channelLabel: channel.label,
      thumbnailStatus,
      thumbnailError,
      shortsCoverStatus,
      publishedAt: new Date(),
    };
    await reel.save();
    console.log(`📤 Published reel ${reelId} to YouTube: ${reel.youtube.url}`);
    // Freeze the exact creative used at publish before later Studio edits. The
    // analytics service is dynamically loaded to keep the publish adapter
    // independent from its metric-provider imports.
    if (videoId) {
      void import("./owned-analytics.service")
        .then(({ registerOwnedPublication }) => registerOwnedPublication(reel, {
          platform: "youtube", accountKey: channel.id, accountLabel: channel.label,
          mediaId: videoId, url: reel.youtube?.url, publishedAt: reel.youtube?.publishedAt,
          firstCommentKind: "none",
        }))
        .catch((error) => console.warn(`Could not freeze YouTube publication analytics context: ${getErrorMessage(error)}`));
    }

    // Own-post pinned-style first comment (curiosity prompt + series link).
    // Best-effort: never flip a successful publish to failed. Requires the
    // youtube.force-ssl scope — a channel connected before that scope was added
    // will get a permission error here and simply skip.
    if (config.youtubeAutoFirstComment && videoId) {
      try {
        const comment = buildFirstCommentText(reel, "youtube", 9_000);
        const commentId = await insertYouTubeTopComment(youtube, videoId, comment.text);
        reel.youtube = { ...reel.youtube, firstCommentStatus: "posted", firstCommentId: commentId, firstCommentError: undefined };
        await reel.save();
        recordOperationLog({
          scope: "external",
          event: "youtube.first_comment_posted",
          message: "Posted the own-post first comment on the published Short",
          reelId,
          metadata: { videoId, source: comment.source, hasSeriesLink: comment.hasSeriesLink },
        });
      } catch (commentError: unknown) {
        reel.youtube = { ...reel.youtube, firstCommentStatus: "failed", firstCommentError: getErrorMessage(commentError) };
        await reel.save();
        recordOperationLog({
          scope: "external",
          level: "warn",
          event: "youtube.first_comment_failed",
          message: "YouTube Short published, but the own-post first comment could not be posted (check the youtube.force-ssl scope)",
          reelId,
          metadata: { videoId },
          error: commentError,
        });
      }
      void import("./series-navigation-comment.service")
        .then(({ reconcileSeriesNavigationComments }) => reconcileSeriesNavigationComments(reelId, "youtube", channel.id))
        .catch((error) => console.warn(`Could not reconcile YouTube series-navigation comments: ${getErrorMessage(error)}`));
    }
  } catch (error: unknown) {
    reel.youtube = {
      ...previousPublish,
      status: "failed",
      error: getErrorMessage(error),
      channelId: channel.id,
      channelLabel: channel.label,
    };
    await reel.save();
    throw error;
  }
}

// ============================================================
// Own-post comment layer (own-media only).
//
// Posting a first comment on OUR OWN just-published Short, and reading/replying
// to early comments on it, are safe reach boosters. They all require the
// youtube.force-ssl scope, so channels connected before that scope was added
// must reconnect once. This is NOT cross-account automation: every call targets
// a video the account itself owns. There is no auto-like/subscribe/spam here.
// ============================================================

/** Build an authenticated YouTube client for a connected channel (force-ssl
 *  scope needed for comment writes). Throws if the channel has no usable token. */
async function youtubeClientForChannel(channelId: string): Promise<{ youtube: youtube_v3.Youtube; channelLabel: string }> {
  const channel = await resolveYouTubePublishChannel(channelId);
  const auth = getYouTubeOAuthClientForRefreshToken(
    channel.refreshToken,
    channel.clientId,
    channel.clientSecret,
    channel.redirectUri,
  );
  return { youtube: google.youtube({ version: "v3", auth, ...YOUTUBE_API_OPTIONS }), channelLabel: channel.label };
}

/** Low-level: insert a top-level comment thread on a video. Returns comment id. */
async function insertYouTubeTopComment(youtube: youtube_v3.Youtube, videoId: string, text: string): Promise<string> {
  const res = await youtube.commentThreads.insert({
    part: ["snippet"],
    requestBody: { snippet: { videoId, topLevelComment: { snippet: { textOriginal: text } } } },
  });
  const id = res.data.id ?? res.data.snippet?.topLevelComment?.id;
  if (!id) throw new Error("YouTube did not return a comment id");
  return id;
}

/** A separate comment used only after a linked series part is confirmed live. */
export async function postYouTubeSeriesNavigationComment(channelId: string, videoId: string, text: string): Promise<string> {
  const { youtube } = await youtubeClientForChannel(channelId);
  return insertYouTubeTopComment(youtube, videoId, text);
}

export interface YouTubeCommentView {
  id: string;
  text: string;
  author?: string;
  publishedAt?: string;
  likeCount?: number;
  replyCount: number;
}

/** Manually (re)post the own-post first comment for a published Short. */
export async function postYouTubeFirstComment(reelId: string, channelId?: string): Promise<string> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  const videoId = reel.youtube?.videoId;
  if (!videoId || reel.youtube?.status !== "published") throw new Error("This reel has no published YouTube Short yet");
  const { youtube } = await youtubeClientForChannel(channelId ?? reel.youtube?.channelId ?? "");
  const comment = buildFirstCommentText(reel, "youtube", 9_000);
  const commentId = await insertYouTubeTopComment(youtube, videoId, comment.text);
  reel.youtube = { ...reel.youtube, firstCommentStatus: "posted", firstCommentId: commentId, firstCommentError: undefined };
  await reel.save();
  void import("./series-navigation-comment.service")
    .then(({ reconcileSeriesNavigationComments }) => reconcileSeriesNavigationComments(reelId, "youtube", channelId ?? reel.youtube?.channelId ?? ""))
    .catch((error) => console.warn(`Could not reconcile YouTube series-navigation comments: ${getErrorMessage(error)}`));
  recordOperationLog({ scope: "external", event: "youtube.first_comment_posted", message: "Manually posted the own-post first comment", reelId, metadata: { videoId, source: comment.source } });
  return commentId;
}

/** Read early top-level comments on our own published Short (assisted replies). */
export async function listYouTubeComments(reelId: string, channelId?: string, limit = 25): Promise<YouTubeCommentView[]> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  const videoId = reel.youtube?.videoId;
  if (!videoId) throw new Error("This reel has no published YouTube Short yet");
  const { youtube } = await youtubeClientForChannel(channelId ?? reel.youtube?.channelId ?? "");
  const res = await youtube.commentThreads.list({
    part: ["snippet"],
    videoId,
    maxResults: Math.min(Math.max(limit, 1), 50),
    order: "time",
  });
  return (res.data.items ?? []).map((item) => {
    const snippet = item.snippet?.topLevelComment?.snippet;
    return {
      id: item.snippet?.topLevelComment?.id ?? item.id ?? "",
      text: snippet?.textDisplay ?? "",
      author: snippet?.authorDisplayName ?? undefined,
      publishedAt: snippet?.publishedAt ?? undefined,
      likeCount: snippet?.likeCount ?? undefined,
      replyCount: item.snippet?.totalReplyCount ?? 0,
    };
  });
}

/** Reply to a comment on our own published Short. Own-media only. */
export async function replyToYouTubeComment(channelId: string, parentCommentId: string, text: string): Promise<string> {
  if (!text.trim()) throw new Error("Reply text is required");
  const { youtube } = await youtubeClientForChannel(channelId);
  const res = await youtube.comments.insert({
    part: ["snippet"],
    requestBody: { snippet: { parentId: parentCommentId, textOriginal: text.trim() } },
  });
  const id = res.data.id;
  if (!id) throw new Error("YouTube did not return a reply id");
  recordOperationLog({ scope: "external", event: "youtube.comment_replied", message: "Replied to a comment on an own YouTube Short", metadata: { channelId, parentCommentId } });
  return id;
}
