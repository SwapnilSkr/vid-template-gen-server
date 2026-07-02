import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import { config } from "../config";
import { resolveModels } from "../config/models";
import { TrendInsight, type ITrendInsight } from "../models";
import { listTrendReferences } from "./trend-reference.service";
import { getErrorMessage } from "../types";

// ============================================
// Distills raw TrendReference rows into a short cached per-genre "winning
// pattern" digest — the compact context that script/thumbnail prompts read
// instead of raw reference dumps (keeps context small, cost near-zero: one
// cheap LLM call per genre per scout run, then unlimited free reads).
// ============================================

const openrouter = createOpenRouter({ apiKey: config.openRouterApiKey });
const MIN_SAMPLE = 3; // not enough signal below this — skip rather than hallucinate a pattern
const DIGEST_CHAR_CAP = 1200; // hard cap so downstream prompts stay bounded

/** Re-summarize the top trend references for one niche/genre into a bullet digest. */
export async function refreshTrendInsight(
  niche: string,
  genre: string
): Promise<ITrendInsight | null> {
  const refs = await listTrendReferences({
    niche,
    genre,
    platform: "youtube_shorts",
    limit: 12,
  });
  if (refs.length < MIN_SAMPLE) return null;

  const sample = refs
    .map((r, i) => {
      const views = r.metrics?.views ?? 0;
      const channel = r.channelTitle ? ` (${r.channelTitle})` : "";
      return `${i + 1}. "${r.title ?? "untitled"}" — ${views.toLocaleString()} views${channel}`;
    })
    .join("\n");

  const prompt = `You are analyzing top-performing YouTube Shorts titles for a Reddit-story video niche.

TOP PERFORMERS (by views):
${sample}

Distill 4-6 short bullet points describing the WINNING PATTERNS across these titles — hook structure, curiosity-gap technique, wording style, length, punctuation. Be concrete and specific (e.g. "opens with a question the viewer must judge", not "engaging titles"). No preamble, no numbering beyond the bullets themselves.

OUTPUT: plain bullet list only, "- " prefix each line, max 6 lines.`;

  try {
    const llm = resolveModels("cheap").llm;
    const { text } = await generateText({ model: openrouter(llm), prompt });
    const digest = text.trim().slice(0, DIGEST_CHAR_CAP);

    return await TrendInsight.findOneAndUpdate(
      { niche, genre },
      { digest, sampleSize: refs.length },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (error: unknown) {
    console.error(`🧠 trend-insight: ${niche}/${genre} failed: ${getErrorMessage(error)}`);
    return null;
  }
}

/** Refresh the digest for every given genre (called after a scout run). */
export async function refreshAllTrendInsights(
  genres: string[],
  niche = "reddit"
): Promise<ITrendInsight[]> {
  const out: ITrendInsight[] = [];
  for (const genre of genres) {
    const insight = await refreshTrendInsight(niche, genre);
    if (insight) out.push(insight);
  }
  return out;
}

/** Cheap cached read for script/thumbnail prompts — no LLM call. */
export async function getTrendDigest(niche: string, genre?: string): Promise<string | undefined> {
  if (!genre) return undefined;
  const insight = await TrendInsight.findOne({ niche, genre });
  return insight?.digest;
}
