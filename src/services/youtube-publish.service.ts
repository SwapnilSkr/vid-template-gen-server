import { google } from "googleapis";
import { Readable } from "node:stream";
import { config } from "../config";
import { Reel } from "../models";
import { getErrorMessage } from "../types";
import { ensureReelReviewPackage } from "./reel-review.service";

// ============================================
// YouTube Data API v3 publishing. Uses a single pre-authorized channel
// (refresh token minted once via `scripts/youtube-authorize.ts`) — matches
// the "content farm first, one channel/niche at a time" model, not
// multi-tenant SaaS. Publish is a separate stage from rendering: it reads
// the already-rendered `reel.outputUrl` (S3/CDN) and never touches the
// render pipeline, so a failed/retried publish never re-spends on assets.
// ============================================

export function getYouTubeOAuthClient() {
  if (!config.youtubeClientId || !config.youtubeClientSecret) {
    throw new Error("YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET not configured");
  }
  const client = new google.auth.OAuth2(
    config.youtubeClientId,
    config.youtubeClientSecret,
    config.youtubeRedirectUri
  );
  if (config.youtubeRefreshToken) {
    client.setCredentials({ refresh_token: config.youtubeRefreshToken });
  }
  return client;
}

/** Publish an already-rendered reel to YouTube as a Short. Updates `reel.youtube`. */
export async function publishReelToYouTube(reelId: string): Promise<void> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  if (!reel.outputUrl) throw new Error("Reel has no rendered video yet");
  if (!config.youtubeRefreshToken) {
    throw new Error(
      "YOUTUBE_REFRESH_TOKEN not configured — run scripts/youtube-authorize.ts first"
    );
  }

  const previousPublish = {
    videoId: reel.youtube?.videoId,
    url: reel.youtube?.url,
    publishedAt: reel.youtube?.publishedAt,
    thumbnailStatus: reel.youtube?.thumbnailStatus,
    thumbnailError: reel.youtube?.thumbnailError,
  };

  reel.youtube = { ...previousPublish, status: "uploading" };
  await reel.save();

  try {
    const review = await ensureReelReviewPackage(reelId);
    const auth = getYouTubeOAuthClient();
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
          categoryId: config.youtubeCategoryId,
        },
        status: {
          privacyStatus: config.youtubePrivacyStatus,
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
      thumbnailStatus,
      thumbnailError,
      publishedAt: new Date(),
    };
    await reel.save();
    console.log(`📤 Published reel ${reelId} to YouTube: ${reel.youtube.url}`);
  } catch (error: unknown) {
    reel.youtube = { ...previousPublish, status: "failed", error: getErrorMessage(error) };
    await reel.save();
    throw error;
  }
}
