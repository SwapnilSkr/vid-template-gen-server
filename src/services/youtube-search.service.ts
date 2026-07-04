import { config } from "../config";

const YT_API_BASE = "https://www.googleapis.com/youtube/v3";

export interface YoutubeSearchResult {
  videoId: string;
  title: string;
  channelTitle: string;
  thumbnailUrl?: string;
  description?: string;
  publishedAt?: string;
  durationSec?: number;
  viewCount?: number;
}

function parseIsoDuration(iso?: string): number | undefined {
  if (!iso) return undefined;
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return undefined;
  const hours = parseInt(match[1] || "0", 10);
  const minutes = parseInt(match[2] || "0", 10);
  const seconds = parseInt(match[3] || "0", 10);
  return hours * 3600 + minutes * 60 + seconds;
}

export async function searchYoutubeVideos(
  query: string,
  maxResults = 12
): Promise<YoutubeSearchResult[]> {
  if (!config.youtubeDataApiKey) {
    throw new Error("YOUTUBE_DATA_API_KEY is not configured");
  }

  const searchParams = new URLSearchParams({
    part: "snippet",
    type: "video",
    order: "relevance",
    maxResults: String(Math.min(maxResults, 25)),
    q: query,
    key: config.youtubeDataApiKey,
  });

  const searchRes = await fetch(`${YT_API_BASE}/search?${searchParams}`);
  if (!searchRes.ok) {
    throw new Error(`YouTube search failed (${searchRes.status}): ${await searchRes.text()}`);
  }

  const searchJson = (await searchRes.json()) as {
    items?: {
      id?: { videoId?: string };
      snippet?: {
        title?: string;
        channelTitle?: string;
        description?: string;
        publishedAt?: string;
        thumbnails?: { medium?: { url?: string }; high?: { url?: string } };
      };
    }[];
  };

  const items = (searchJson.items ?? []).filter((item) => item.id?.videoId);
  const videoIds = items.map((item) => item.id!.videoId as string);
  if (videoIds.length === 0) return [];

  const videoParams = new URLSearchParams({
    part: "contentDetails,statistics",
    id: videoIds.join(","),
    key: config.youtubeDataApiKey,
  });
  const videoRes = await fetch(`${YT_API_BASE}/videos?${videoParams}`);
  if (!videoRes.ok) {
    throw new Error(`YouTube videos.list failed (${videoRes.status}): ${await videoRes.text()}`);
  }

  const videoJson = (await videoRes.json()) as {
    items?: {
      id?: string;
      contentDetails?: { duration?: string };
      statistics?: { viewCount?: string };
    }[];
  };
  const detailsById = new Map(
    (videoJson.items ?? []).map((item) => [item.id, item] as const)
  );

  return items.map((item) => {
    const videoId = item.id!.videoId as string;
    const details = detailsById.get(videoId);
    return {
      videoId,
      title: item.snippet?.title ?? "Untitled",
      channelTitle: item.snippet?.channelTitle ?? "Unknown channel",
      thumbnailUrl:
        item.snippet?.thumbnails?.high?.url ?? item.snippet?.thumbnails?.medium?.url,
      description: item.snippet?.description,
      publishedAt: item.snippet?.publishedAt,
      durationSec: parseIsoDuration(details?.contentDetails?.duration),
      viewCount: details?.statistics?.viewCount
        ? parseInt(details.statistics.viewCount, 10)
        : undefined,
    };
  });
}

export async function getYoutubeVideoMetadata(videoId: string): Promise<YoutubeSearchResult> {
  if (!config.youtubeDataApiKey) {
    throw new Error("YOUTUBE_DATA_API_KEY is not configured");
  }

  const params = new URLSearchParams({
    part: "snippet,contentDetails,statistics",
    id: videoId,
    key: config.youtubeDataApiKey,
  });
  const res = await fetch(`${YT_API_BASE}/videos?${params}`);
  if (!res.ok) {
    throw new Error(`YouTube videos.list failed (${res.status}): ${await res.text()}`);
  }

  const json = (await res.json()) as {
    items?: {
      id?: string;
      snippet?: {
        title?: string;
        channelTitle?: string;
        description?: string;
        publishedAt?: string;
        thumbnails?: { medium?: { url?: string }; high?: { url?: string } };
      };
      contentDetails?: { duration?: string };
      statistics?: { viewCount?: string };
    }[];
  };

  const item = json.items?.[0];
  if (!item?.id) throw new Error(`YouTube video not found: ${videoId}`);

  return {
    videoId: item.id,
    title: item.snippet?.title ?? "Untitled",
    channelTitle: item.snippet?.channelTitle ?? "Unknown channel",
    thumbnailUrl:
      item.snippet?.thumbnails?.high?.url ?? item.snippet?.thumbnails?.medium?.url,
    description: item.snippet?.description,
    publishedAt: item.snippet?.publishedAt,
    durationSec: parseIsoDuration(item.contentDetails?.duration),
    viewCount: item.statistics?.viewCount
      ? parseInt(item.statistics.viewCount, 10)
      : undefined,
  };
}
