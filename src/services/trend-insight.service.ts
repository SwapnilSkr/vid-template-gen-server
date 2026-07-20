import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, Output } from "ai";
import { z } from "zod";
import { config } from "../config";
import { resolveModels } from "../config/models";
import { TrendInsight, type ITrendInsight } from "../models";
import { listTrendReferences } from "./trend-reference.service";
import { getErrorMessage } from "../types";
import { isEnglishText } from "../utils";
import { TREND_RESEARCH_VERSION } from "./trend-research.constants";

// ============================================
// Distills raw TrendReference rows into a short cached per-genre "winning
// pattern" digest (+ reusable hook templates) — the compact context that
// script/thumbnail prompts read instead of raw reference dumps (keeps
// context small, cost near-zero: one cheap LLM call per genre per scout
// run, then unlimited free reads).
//
// Non-English titles are filtered out before summarization (script-based
// heuristic, see isEnglishText) — reels are always English-narrated, so a
// foreign-heavy sample would risk leaking non-English phrasing into the
// digest/hooks that feed the script and thumbnail prompts. Raw
// TrendReference rows are left untouched for dashboard browsing; only the
// prompt-facing digest is English-gated.
// ============================================

const openrouter = createOpenRouter({ apiKey: config.openRouterApiKey });
const MIN_SAMPLE = 3; // not enough signal below this — skip rather than hallucinate a pattern
const SAMPLE_SIZE = 12; // how many (English-filtered) references feed the digest prompt
const FETCH_MULTIPLIER = 4; // over-fetch raw refs so filtering still leaves enough English samples
const DIGEST_CHAR_CAP = 1200; // hard cap so downstream prompts stay bounded
const MAX_HOOKS = 6;
const HOOK_CHAR_CAP = 120; // each hook stays short enough to drop straight into a script prompt

const trendInsightSchema = z.object({
  digest: z
    .string()
    .describe("4-6 bullet points as a single string; prefix each line with '- '"),
  hooks: z
    .array(z.string())
    .max(MAX_HOOKS)
    .describe("Reusable hook-line templates with [placeholder] slots"),
  evidence: z.object({
    titlePatterns: z.array(z.string()).max(5),
    hookTypes: z.array(z.string()).max(5),
    keywordPhrases: z.array(z.string()).max(8),
    cautions: z.array(z.string()).max(4),
    confidence: z.enum(["low", "medium", "high"]),
  }),
});

/** Flatten YouTube title/channel text so quotes and line breaks don't break the prompt. */
function sanitizeTrendSampleText(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/"/g, "'").trim();
}

/** Re-summarize the top trend references for one niche/genre into a bullet
 * digest + reusable hook templates. */
export async function refreshTrendInsight(
  niche: string,
  genre: string
): Promise<ITrendInsight | null> {
  const rawRefs = await listTrendReferences({
    niche,
    genre,
    platform: "youtube_shorts",
    limit: SAMPLE_SIZE * FETCH_MULTIPLIER,
  });
  const refs = rawRefs.filter((r) => isEnglishText(r.title ?? "")).slice(0, SAMPLE_SIZE);
  if (refs.length < MIN_SAMPLE) return null;

  const now = Date.now();
  const sample = refs
    .map((r, i) => {
      const views = r.metrics?.views ?? 0;
      const title = sanitizeTrendSampleText(r.title ?? "untitled");
      const channel = r.channelTitle ? ` (${sanitizeTrendSampleText(r.channelTitle)})` : "";
      const ageHours = r.metrics?.postedAt ? Math.max(1, Math.round((now - r.metrics.postedAt.getTime()) / 3_600_000)) : undefined;
      const duration = r.metrics?.durationSec ? `, ${r.metrics.durationSec}s` : "";
      const velocity = ageHours ? `, ~${Math.round(views / Math.max(ageHours, 12))} views/hour observed` : "";
      return `${i + 1}. ${title} — ${views.toLocaleString()} views${velocity}${duration}${channel}`;
    })
    .join("\n");

  const prompt = `You are analyzing top-performing YouTube Shorts titles for a "${niche}" (${genre}) short-form video niche.

TOP PERFORMERS (by views):
${sample}

1. Distill 4-6 short bullet points describing the WINNING PATTERNS across these titles — hook structure, curiosity-gap technique, wording style, length, punctuation. Be concrete and specific (e.g. "opens with a question the viewer must judge", not "engaging titles").

2. Write ${MAX_HOOKS} REUSABLE HOOK-LINE TEMPLATES inspired by (not copied from) these titles — generic, topic-agnostic openers a scriptwriter could adapt to a brand-new story in this niche. Use a "[placeholder]" for the specific subject (e.g. "The [object] in my [place] was never supposed to [action]..."). Do not quote or closely paraphrase any single title verbatim.

3. Return evidence from this exact sample only. List observed title patterns, hook types, and natural keyword phrases. Add cautions whenever the sample is too small, overly repetitive, or its public view data cannot establish causation. Set confidence to low below 6 samples, medium for 6–14, and high only for 15+ varied samples. Do not claim to know retention, impressions, followers, or the creator's intent.

Everything you write MUST be in English, regardless of the language any source title happens to be in.`;

  try {
    const llm = resolveModels("cheap").llm;
    const { output } = await generateText({
      model: openrouter(llm),
      output: Output.object({ schema: trendInsightSchema }),
      prompt,
      maxRetries: 2,
    });
    if (!output) throw new Error("No structured output from model");

    const digest = (output.digest ?? "").trim().slice(0, DIGEST_CHAR_CAP);
    const hooks = (output.hooks ?? [])
      .filter((h): h is string => typeof h === "string" && h.trim().length > 0)
      .map((h) => h.trim().slice(0, HOOK_CHAR_CAP))
      .slice(0, MAX_HOOKS);
    if (!digest) throw new Error("Empty digest in model response");

    const evidence = {
      titlePatterns: (output.evidence?.titlePatterns ?? []).map((item) => item.trim().slice(0, 180)).filter(Boolean),
      hookTypes: (output.evidence?.hookTypes ?? []).map((item) => item.trim().slice(0, 80)).filter(Boolean),
      keywordPhrases: (output.evidence?.keywordPhrases ?? []).map((item) => item.trim().slice(0, 80)).filter(Boolean),
      cautions: (output.evidence?.cautions ?? []).map((item) => item.trim().slice(0, 180)).filter(Boolean),
      confidence: output.evidence?.confidence ?? "low",
      generatedAt: new Date(),
    };
    return await TrendInsight.findOneAndUpdate(
      { niche, genre, researchVersion: TREND_RESEARCH_VERSION },
      { digest, hooks, sampleSize: refs.length, evidence, researchVersion: TREND_RESEARCH_VERSION },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (error: unknown) {
    console.error(`🧠 trend-insight: ${niche}/${genre} failed: ${getErrorMessage(error)}`);
    return null;
  }
}

/** Refresh the digest for every given {niche, genre} pair (called after a scout run). */
export async function refreshAllTrendInsights(
  targets: { niche: string; genre: string }[]
): Promise<ITrendInsight[]> {
  const out: ITrendInsight[] = [];
  for (const { niche, genre } of targets) {
    const insight = await refreshTrendInsight(niche, genre);
    if (insight) out.push(insight);
  }
  return out;
}

export interface TrendInsightData {
  digest: string;
  hooks: string[];
  sampleSize: number;
  evidence?: ITrendInsight["evidence"];
}

/** Cheap cached read for script/thumbnail prompts — no LLM call. */
export async function getTrendInsight(niche: string, genre?: string): Promise<TrendInsightData | undefined> {
  if (!genre) return undefined;
  const insight = await TrendInsight.findOne({ niche, genre, researchVersion: TREND_RESEARCH_VERSION });
  if (!insight) return undefined;
  return { digest: insight.digest, hooks: insight.hooks ?? [], sampleSize: insight.sampleSize, evidence: insight.evidence };
}

/** Returns only evidence the current sample size can support. Platform default
 * rules remain authoritative when the external corpus is sparse. */
export async function getTrendCopyGuidance(niche: string, genre?: string): Promise<string> {
  const insight = await getTrendInsight(niche, genre);
  if (!insight || insight.sampleSize < 6 || insight.evidence?.confidence === "low") {
    return "EXTERNAL RESEARCH: insufficient comparable samples. Follow the default platform rules only; do not infer a genre-specific winning style.";
  }
  const highConfidence = insight.sampleSize >= 15 && insight.evidence?.confidence === "high";
  return `${highConfidence ? "HIGH" : "MEDIUM"}-CONFIDENCE EXTERNAL RESEARCH (${insight.sampleSize} comparable public samples):\n${insight.digest}\n${highConfidence ? "Adapt these observed patterns without copying any source wording." : "Treat these as optional prompts; platform defaults and story truth outrank them."}`;
}

/** Cheap cached read for thumbnail prompts — no LLM call. */
export async function getTrendDigest(niche: string, genre?: string): Promise<string | undefined> {
  const insight = await getTrendInsight(niche, genre);
  if (!insight || insight.sampleSize < 6 || insight.evidence?.confidence === "low") return undefined;
  return insight.digest;
}
