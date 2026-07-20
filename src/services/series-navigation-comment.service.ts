import { Reel, type IReel } from "../models";
import { getErrorMessage } from "../types";
import { buildVerifiedSeriesNavigationText, type CommentPlatform, type SeriesNavigationKind } from "./post-comment.service";
import { postYouTubeSeriesNavigationComment } from "./youtube-publish.service";
import { postInstagramSeriesNavigationComment } from "./instagram-publish.service";
import { postFacebookSeriesNavigationComment } from "./facebook-publish.service";
import { postThreadsSeriesNavigationReply } from "./threads-publish.service";
import { recordOperationLog } from "./operation-log.service";

type SeriesPlatform = CommentPlatform;

interface PublishedDestination {
  mediaId: string;
  url?: string;
  navigationStatus?: string;
}

interface NavigationPlan {
  source: IReel;
  target: IReel;
  sourceDestination: PublishedDestination;
  targetDestination: PublishedDestination;
  kind: SeriesNavigationKind;
}

function destinationFor(reel: IReel, platform: SeriesPlatform, channelId: string): PublishedDestination | undefined {
  if (platform === "youtube") {
    const publish = reel.youtube;
    if (publish?.status !== "published" || publish.channelId !== channelId || !publish.videoId) return undefined;
    return { mediaId: publish.videoId, url: publish.url, navigationStatus: publish.seriesNavigationStatus };
  }
  const publish = platform === "instagram"
    ? reel.instagram.find((item) => item.channelId === channelId && item.status === "published")
    : platform === "facebook"
      ? reel.facebook.find((item) => item.channelId === channelId && item.status === "published")
      : reel.threads.find((item) => item.channelId === channelId && item.status === "published");
  const mediaId = platform === "facebook"
    ? (publish as IReel["facebook"][number] | undefined)?.videoId
    : (publish as IReel["instagram"][number] | IReel["threads"][number] | undefined)?.mediaId;
  if (!publish || !mediaId) return undefined;
  return { mediaId, url: publish.url, navigationStatus: publish.seriesNavigationStatus };
}

function nextPlan(source: IReel, target: IReel, platform: SeriesPlatform, channelId: string, kind: SeriesNavigationKind = "next_part"): NavigationPlan | undefined {
  const sourceDestination = destinationFor(source, platform, channelId);
  const targetDestination = destinationFor(target, platform, channelId);
  if (!sourceDestination || !targetDestination || sourceDestination.navigationStatus === "posted") return undefined;
  return { source, target, sourceDestination, targetDestination, kind };
}

async function post(platform: SeriesPlatform, channelId: string, mediaId: string, text: string): Promise<string> {
  if (platform === "youtube") return postYouTubeSeriesNavigationComment(channelId, mediaId, text);
  if (platform === "instagram") return postInstagramSeriesNavigationComment(channelId, mediaId, text);
  if (platform === "facebook") return postFacebookSeriesNavigationComment(channelId, mediaId, text);
  return postThreadsSeriesNavigationReply(channelId, mediaId, text);
}

async function updatePlanStatus(
  plan: NavigationPlan,
  platform: SeriesPlatform,
  channelId: string,
  status: "pending" | "posted" | "failed",
  patch: Record<string, unknown> = {},
): Promise<void> {
  if (platform === "youtube") {
    await Reel.updateOne({ _id: plan.source._id }, {
      $set: {
        "youtube.seriesNavigationStatus": status,
        ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [`youtube.${key}`, value])),
      },
    });
    return;
  }
  const field = platform;
  await Reel.updateOne(
    { _id: plan.source._id, [`${field}.channelId`]: channelId },
    {
      $set: {
        [`${field}.$.seriesNavigationStatus`]: status,
        ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [`${field}.$.${key}`, value])),
      },
    },
  );
}

async function executePlan(plan: NavigationPlan, platform: SeriesPlatform, channelId: string): Promise<void> {
  await updatePlanStatus(plan, platform, channelId, "pending", {
    seriesNavigationTargetReelId: plan.target._id.toString(),
    seriesNavigationCommentError: undefined,
  });
  const targetPart = plan.kind === "series_complete" ? 1 : plan.target.partNumber ?? 1;
  const text = buildVerifiedSeriesNavigationText(platform, targetPart, plan.targetDestination.url, plan.kind);
  try {
    const commentId = await post(platform, channelId, plan.sourceDestination.mediaId, text);
    await updatePlanStatus(plan, platform, channelId, "posted", {
      seriesNavigationCommentId: commentId,
      seriesNavigationCommentError: undefined,
      seriesNavigationTargetReelId: plan.target._id.toString(),
    });
    recordOperationLog({
      scope: "external",
      event: "series_navigation_comment_posted",
      message: "Posted a verified live-part navigation comment on an own post",
      reelId: plan.source._id.toString(),
      metadata: { platform, channelId, sourcePart: plan.source.partNumber, targetPart, targetUrl: plan.targetDestination.url, kind: plan.kind },
    });
  } catch (error) {
    const message = getErrorMessage(error);
    await updatePlanStatus(plan, platform, channelId, "failed", { seriesNavigationCommentError: message });
    recordOperationLog({
      scope: "external",
      level: "warn",
      event: "series_navigation_comment_failed",
      message: "A live part was verified, but its navigation comment could not be posted",
      reelId: plan.source._id.toString(),
      metadata: { platform, channelId, sourcePart: plan.source.partNumber, targetPart, kind: plan.kind },
      error,
    });
  }
}

/**
 * Run after a part publishes. It never predicts publication: both source and
 * target must be marked published on the same connected account. Publishing
 * Part 2 back-fills Part 1's link; publishing Part 3 does the same for Part 2.
 */
export async function reconcileSeriesNavigationComments(
  reelId: string,
  platform: SeriesPlatform,
  channelId: string,
): Promise<{ posted: number; skipped: number }> {
  const current = await Reel.findById(reelId);
  if (!current?.seriesId || !current.partNumber || !current.partCount || current.partCount <= 1) return { posted: 0, skipped: 0 };
  const series = await Reel.find({ seriesId: current.seriesId }).sort({ partNumber: 1 });
  const byPart = new Map(series.map((reel) => [reel.partNumber, reel]));
  const plans: NavigationPlan[] = [];
  const previous = byPart.get(current.partNumber - 1);
  const next = byPart.get(current.partNumber + 1);
  if (previous) {
    const plan = nextPlan(previous, current, platform, channelId);
    if (plan) plans.push(plan);
  }
  if (next) {
    const plan = nextPlan(current, next, platform, channelId);
    if (plan) plans.push(plan);
  }
  if (current.partNumber === current.partCount) {
    const first = byPart.get(1);
    if (first) {
      const plan = nextPlan(current, first, platform, channelId, "series_complete");
      if (plan) plans.push(plan);
    }
  }
  for (const plan of plans) await executePlan(plan, platform, channelId);
  return { posted: plans.length, skipped: 0 };
}
