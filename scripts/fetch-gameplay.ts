// Fetch Creative Commons (CC-BY) licensed gameplay footage from YouTube for
// the background clip pool — searches via YouTube Data API v3 restricted to
// videoLicense=creativeCommon (only uploads explicitly marked reusable, with
// attribution) — the same method already used to source the Minecraft clips
// in server/storage/gameplay/. Downloads with the vendored yt-dlp, then runs
// each source through the existing ingest pipeline (crop to 9:16, strip
// audio, segment into ~75s loops, upload to S3, cache locally).
//
// Usage:
//   bun scripts/fetch-gameplay.ts "<search query>" [maxResults]
//   bun scripts/fetch-gameplay.ts "subway surfers gameplay" 5
//   bun scripts/fetch-gameplay.ts "temple run gameplay no commentary" 5
//
// Needs YOUTUBE_DATA_API_KEY in env. Appends an attribution record (channel,
// title, source URL, license) to server/storage/gameplay/ATTRIBUTION.json —
// CC-BY still requires crediting the creator even though reuse is permitted.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config } from "../src/config";
import { ingestGameplaySource } from "../src/services/gameplay-ingest.service";

const YT_API_BASE = "https://www.googleapis.com/youtube/v3";
const YT_DLP_BIN = resolve(import.meta.dir, "../bin/yt-dlp");
const ATTRIBUTION_PATH = join(config.gameplayDir, "ATTRIBUTION.json");

interface Candidate {
  videoId: string;
  title: string;
  channelTitle: string;
}

interface AttributionRecord {
  videoId: string;
  title: string;
  channelTitle: string;
  url: string;
  license: "creativeCommon";
  downloadedAt: string;
}

async function searchCcVideos(query: string, maxResults: number): Promise<Candidate[]> {
  if (!config.youtubeDataApiKey) {
    throw new Error("YOUTUBE_DATA_API_KEY not configured — get one from Google Cloud Console");
  }
  const params = new URLSearchParams({
    part: "snippet",
    type: "video",
    videoLicense: "creativeCommon", // only CC-BY licensed uploads — reuse explicitly permitted
    videoDuration: "medium", // 4-20 min — enough footage to chop into several loop segments
    order: "relevance",
    maxResults: String(maxResults),
    q: query,
    key: config.youtubeDataApiKey,
  });
  const res = await fetch(`${YT_API_BASE}/search?${params}`);
  if (!res.ok) throw new Error(`YouTube search failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as {
    items?: { id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string } }[];
  };
  return (json.items ?? [])
    .filter((i): i is Required<typeof i> => Boolean(i.id?.videoId))
    .map((i) => ({
      videoId: i.id.videoId as string,
      title: i.snippet?.title ?? "untitled",
      channelTitle: i.snippet?.channelTitle ?? "unknown",
    }));
}

function downloadVideo(videoId: string, outPath: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(YT_DLP_BIN, [
      "-f",
      "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/b",
      "-o",
      outPath,
      "--no-playlist",
      `https://www.youtube.com/watch?v=${videoId}`,
    ]);
    proc.on("error", reject);
    proc.on("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`yt-dlp exited ${code} for ${videoId}`))
    );
  });
}

async function appendAttribution(record: AttributionRecord): Promise<void> {
  let existing: AttributionRecord[] = [];
  try {
    existing = JSON.parse(await readFile(ATTRIBUTION_PATH, "utf-8"));
  } catch {
    // first write — file doesn't exist yet
  }
  existing.push(record);
  await writeFile(ATTRIBUTION_PATH, JSON.stringify(existing, null, 2));
}

const query = process.argv[2];
const maxResults = parseInt(process.argv[3] || "5", 10);
if (!query) {
  console.error('Usage: bun scripts/fetch-gameplay.ts "<search query>" [maxResults]');
  process.exit(1);
}

await mkdir(config.gameplayDir, { recursive: true });

const candidates = await searchCcVideos(query, maxResults);
console.log(`Found ${candidates.length} CC-licensed video(s) for "${query}"`);

let totalSegments = 0;
for (const candidate of candidates) {
  const rawPath = join(config.gameplayDir, `_raw_${candidate.videoId}.mp4`);
  try {
    console.log(`⬇️  Downloading: "${candidate.title}" (${candidate.channelTitle})`);
    await downloadVideo(candidate.videoId, rawPath);

    console.log("🎮 Ingesting...");
    const clips = await ingestGameplaySource(rawPath);
    totalSegments += clips.length;
    for (const clip of clips) console.log(`   → ${clip.url}`);

    await appendAttribution({
      videoId: candidate.videoId,
      title: candidate.title,
      channelTitle: candidate.channelTitle,
      url: `https://www.youtube.com/watch?v=${candidate.videoId}`,
      license: "creativeCommon",
      downloadedAt: new Date().toISOString(),
    });
  } catch (error: unknown) {
    console.warn(`  skip (${candidate.videoId}): ${error instanceof Error ? error.message : error}`);
  } finally {
    await rm(rawPath, { force: true }).catch(() => {});
  }
}

console.log(`\n✅ Ingested ${totalSegments} gameplay segment(s) from ${candidates.length} source video(s).`);
console.log(`   Attribution log: ${ATTRIBUTION_PATH}`);
process.exit(0);
