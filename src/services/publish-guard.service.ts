import { Reel } from "../models";
import { config } from "../config";
import { recordOperationLog } from "./operation-log.service";

// ============================================================
// Per-platform daily publish guards.
//
// The 2025–2026 IG/YouTube recommendation retunes penalise accounts that burst
// automated uploads, and each platform has a hard API cap besides. These guards
// count this account's OWN successful publishes in the last rolling 24h from the
// reel documents (no extra store needed) and refuse to exceed a conservative
// per-platform limit. A limit of 0 disables the guard for that platform.
// ============================================================

export type PublishPlatform = "youtube" | "instagram" | "facebook" | "threads";

const DAY_MS = 24 * 60 * 60 * 1000;

function limitFor(platform: PublishPlatform): number {
  switch (platform) {
    case "youtube":
      return config.youtubeDailyLimit;
    case "instagram":
      return config.instagramDailyLimit;
    case "facebook":
      return config.facebookDailyLimit;
    case "threads":
      return config.threadsDailyLimit;
  }
}

async function countPublishedSince(platform: PublishPlatform, since: Date, channelId?: string): Promise<number> {
  if (platform === "youtube") {
    // YouTube's cap is account-wide (uploads/day), not per-channel.
    return Reel.countDocuments({
      "youtube.status": "published",
      "youtube.publishedAt": { $gte: since },
    });
  }
  const elem: Record<string, unknown> = { status: "published", publishedAt: { $gte: since } };
  if (channelId) elem.channelId = channelId;
  return Reel.countDocuments({ [platform]: { $elemMatch: elem } });
}

/**
 * Throw if publishing now would exceed the platform's conservative daily guard.
 * Call at the start of a publish so a throttled account fails fast with a clear
 * message instead of tripping the platform's own hard cap mid-upload.
 */
export async function assertDailyPublishLimit(
  platform: PublishPlatform,
  channelId?: string,
): Promise<void> {
  const limit = limitFor(platform);
  if (!limit || limit <= 0) return; // guard disabled
  const since = new Date(Date.now() - DAY_MS);
  const count = await countPublishedSince(platform, since, channelId);
  if (count >= limit) {
    recordOperationLog({
      scope: "system",
      level: "warn",
      event: "publish.daily_limit_reached",
      message: `Refusing to publish: ${platform} daily guard reached`,
      metadata: { platform, channelId, count, limit },
    });
    throw new Error(
      `Daily ${platform} publish guard reached (${count}/${limit} in the last 24h). ` +
        `Raise ${platform.toUpperCase()}_DAILY_LIMIT or wait before publishing more.`,
    );
  }
}
