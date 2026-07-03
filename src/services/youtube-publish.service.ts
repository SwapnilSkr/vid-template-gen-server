import { google } from "googleapis";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { config } from "../config";
import { OAuthState, Reel, YouTubeChannel } from "../models";
import { getErrorMessage } from "../types";
import { ensureReelReviewPackage } from "./reel-review.service";

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

// ============================================
// YouTube Data API v3 publishing. Uses a single pre-authorized channel
// (refresh token minted once via `scripts/youtube-authorize.ts`) — matches
// the "content farm first, one channel/niche at a time" model, not
// multi-tenant SaaS. Publish is a separate stage from rendering: it reads
// the already-rendered `reel.outputUrl` (S3/CDN) and never touches the
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

export async function listAllYouTubePublishChannels(): Promise<PublicYouTubePublishChannel[]> {
  const envChannels = listYouTubePublishChannels();
  const dbChannels = await YouTubeChannel.find({ status: { $ne: "disabled" } })
    .sort({ createdAt: 1 })
    .lean();
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

/** Publish an already-rendered reel to YouTube as a Short. Updates `reel.youtube`. */
export async function publishReelToYouTube(reelId: string, channelId?: string): Promise<void> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  if (!reel.outputUrl) throw new Error("Reel has no rendered video yet");
  const channel = await resolveYouTubePublishChannel(channelId ?? reel.outroChannelId);

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
    const youtube = google.youtube({ version: "v3", auth });

    const videoRes = await fetch(reel.outputUrl);
    if (!videoRes.ok || !videoRes.body) {
      throw new Error(`Failed to fetch rendered video (${videoRes.status})`);
    }
    const videoStream = Readable.fromWeb(videoRes.body as never);

    const res = await youtube.videos.insert({
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
      media: { body: videoStream },
    });

    const videoId = res.data.id ?? undefined;
    let thumbnailStatus: "uploaded" | "missing" | "failed" = review.thumbnailUrl
      ? "failed"
      : "missing";
    let thumbnailError: string | undefined;

    if (videoId && review.thumbnailUrl) {
      try {
        const thumbnailRes = await fetch(review.thumbnailUrl);
        if (!thumbnailRes.ok) {
          throw new Error(`Failed to fetch thumbnail (${thumbnailRes.status})`);
        }
        const thumbnailBuffer = Buffer.from(await thumbnailRes.arrayBuffer());
        await youtube.thumbnails.set({
          videoId,
          media: {
            mimeType: thumbnailRes.headers.get("content-type") ?? "image/png",
            body: Readable.from(thumbnailBuffer),
          },
        });
        thumbnailStatus = "uploaded";
      } catch (error: unknown) {
        thumbnailError = getErrorMessage(error);
        console.warn(`⚠️  Thumbnail upload failed for reel ${reelId}: ${thumbnailError}`);
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
      publishedAt: new Date(),
    };
    await reel.save();
    console.log(`📤 Published reel ${reelId} to YouTube: ${reel.youtube.url}`);
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
