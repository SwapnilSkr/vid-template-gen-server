import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import { config } from "../config";
import { resolveModels, type Tier } from "../config/models";
import { getErrorMessage } from "../types";
import { reportLlmUsage, type LlmUsageCallback } from "./reel-script.service";
import { recordOperationLog } from "./operation-log.service";
import {
  cleanRedditBody,
  continuationCue,
  fetchPostByUrl,
  parseRedditListing,
  redditFetchJson,
  titleOverlap,
  type RedditContinuation,
  type RedditListingJson,
  type RedditPost,
} from "./story.service";

const openrouter = createOpenRouter({ apiKey: config.openRouterApiKey });

// ============================================
// Followup/update discovery — finds the OP's later updates for a Reddit story
// from two sources (embedded links in the body and the author's other posts),
// then has an LLM adjudicate which are genuine
// continuations. A confidence >= config.updateAiConfidence auto-includes; below
// that we fall back to deterministic signals (embedded link / title mirror /
// update cue). Manual (user-pasted) links are always included. All additive —
// the existing verbatim thread path (story.service.resolveRedditStoryThread)
// consumes the included candidates through combinePostWithContinuations.
// ============================================

export type UpdateSignal =
  | "embedded_link"
  | "author_match"
  | "title_mirror"
  | "update_cue"
  | "temporal_after"
  | "manual";

export type UpdateDecision = "include" | "candidate" | "rejected";

export interface UpdateCandidate {
  key: string; // dedupe: resolved permalink
  kind: "embedded_link" | "author_post" | "manual";
  title: string;
  body: string;
  url: string;
  createdUtc: number;
  matchedSignals: UpdateSignal[];
  signalScore: number;
  aiConfidence?: number;
  aiReason?: string;
  decision: UpdateDecision;
}

export interface UpdateDiscovery {
  method: "ai" | "signals" | "hybrid";
  candidates: UpdateCandidate[];
  scannedAt: number;
}

const SIGNAL_WEIGHT: Record<UpdateSignal, number> = {
  manual: 6,
  embedded_link: 5,
  title_mirror: 2,
  update_cue: 2,
  temporal_after: 1,
  author_match: 1,
};

function signalScore(signals: UpdateSignal[]): number {
  return signals.reduce((sum, s) => sum + (SIGNAL_WEIGHT[s] ?? 0), 0);
}

/** A candidate is a "strong" match on deterministic signals alone. */
function hasStrongSignal(signals: UpdateSignal[]): boolean {
  const has = (s: UpdateSignal) => signals.includes(s);
  return (
    has("manual") ||
    has("embedded_link") ||
    (has("title_mirror") && (has("update_cue") || has("temporal_after")))
  );
}

// ---- embedded links ----

const REDDIT_LINK_RE =
  /https?:\/\/(?:www\.|old\.)?reddit\.com\/[^\s)"'<>]+/gi;

/**
 * Reddit URLs in a post body, prioritising ones next to an edit/update marker
 * (`Edit 2: ... https://...`). Returns unique URLs, edit-marked ones first.
 */
export function extractRedditUpdateLinks(body: string): string[] {
  const marked = new Set<string>();
  const plain = new Set<string>();
  // Scan line by line so we can tell whether an edit/update marker precedes a link.
  for (const line of body.split(/\n+/)) {
    const isMarked = /\b(edit\s*\d*|update\s*\d*|eta)\b\s*[:\-–]/i.test(line);
    const matches = line.match(REDDIT_LINK_RE) ?? [];
    for (const raw of matches) {
      const url = raw.replace(/[.,);]+$/, "");
      (isMarked ? marked : plain).add(url);
    }
  }
  // Also catch inline "update: https://..." even without a line break before it.
  for (const m of body.matchAll(/\b(?:edit|update|eta)\s*\d*\s*[:\-–]\s*(https?:\/\/[^\s)"'<>]+)/gi)) {
    const url = m[1].replace(/[.,);]+$/, "");
    if (/reddit\.com/i.test(url)) marked.add(url);
  }
  return [...marked, ...[...plain].filter((u) => !marked.has(u))];
}

// ---- candidate collection ----

async function collectEmbeddedLinkCandidates(post: RedditPost): Promise<UpdateCandidate[]> {
  const urls = extractRedditUpdateLinks(post.body);
  const out: UpdateCandidate[] = [];
  for (const url of urls) {
    try {
      const resolved = await fetchPostByUrl(url); // handles /comments and /s/ share links
      if (!resolved || resolved.url === post.url) continue;
      const signals: UpdateSignal[] = ["embedded_link"];
      if (continuationCue(`${resolved.title}\n${resolved.body}`)) signals.push("update_cue");
      if (resolved.author?.toLowerCase() === post.author.toLowerCase()) signals.push("author_match");
      out.push({
        key: resolved.url,
        kind: "embedded_link",
        title: resolved.title || "Linked update",
        body: cleanRedditBody(resolved.body),
        url: resolved.url,
        createdUtc: resolved.createdUtc,
        matchedSignals: signals,
        signalScore: signalScore(signals),
        decision: "candidate",
      });
    } catch (error: unknown) {
      console.warn(`  embedded update link skipped (${url}): ${getErrorMessage(error)}`);
      recordOperationLog({
        scope: "external",
        level: "warn",
        event: "reddit.embedded_update_skipped",
        message: "Could not inspect an embedded Reddit update link",
        metadata: { url },
        error,
      });
    }
  }
  return out;
}

async function collectAuthorPostCandidates(post: RedditPost): Promise<UpdateCandidate[]> {
  if (!post.author || post.author === "[deleted]") return [];
  const json = (await redditFetchJson(
    `/user/${encodeURIComponent(post.author)}/submitted?sort=new&limit=50&raw_json=1`
  )) as RedditListingJson;
  return parseRedditListing(json, post.subreddit)
    .filter((c) => c.url !== post.url)
    .filter((c) => c.createdUtc > post.createdUtc)
    .filter((c) => c.createdUtc - post.createdUtc < 60 * 60 * 24 * 120)
    .map((c): UpdateCandidate => {
      const signals: UpdateSignal[] = ["author_match", "temporal_after"];
      if (titleOverlap(post.title, c.title) >= 2) signals.push("title_mirror");
      if (continuationCue(`${c.title}\n${c.body}`)) signals.push("update_cue");
      return {
        key: c.url,
        kind: "author_post",
        title: c.title,
        body: cleanRedditBody(c.body),
        url: c.url,
        createdUtc: c.createdUtc,
        matchedSignals: signals,
        signalScore: signalScore(signals),
        decision: "candidate",
      };
    });
}

/** Resolve user-pasted followup URLs into force-included manual candidates. */
export async function resolveManualUpdates(
  urls: string[],
  post?: RedditPost
): Promise<UpdateCandidate[]> {
  const out: UpdateCandidate[] = [];
  for (const url of urls) {
    if (!url?.trim()) continue;
    try {
      const resolved = await fetchPostByUrl(url.trim());
      if (!resolved) {
        console.warn(`  manual update link did not resolve: ${url}`);
        recordOperationLog({
          scope: "external",
          level: "warn",
          event: "reddit.manual_update_unresolved",
          message: "A manually supplied Reddit update link could not be resolved",
          metadata: { url },
        });
        continue;
      }
      if (post && resolved.url === post.url) continue;
      out.push({
        key: resolved.url,
        kind: "manual",
        title: resolved.title || "Manual update",
        body: cleanRedditBody(resolved.body),
        url: resolved.url,
        createdUtc: resolved.createdUtc,
        matchedSignals: ["manual"],
        signalScore: signalScore(["manual"]),
        decision: "include",
      });
    } catch (error: unknown) {
      console.warn(`  manual update link failed (${url}): ${getErrorMessage(error)}`);
      recordOperationLog({
        scope: "external",
        level: "warn",
        event: "reddit.manual_update_failed",
        message: "A manually supplied Reddit update link failed during resolution",
        metadata: { url },
        error,
      });
    }
  }
  return out;
}

// ---- LLM adjudication ----

interface AiVerdict {
  key: string;
  isUpdate: boolean;
  confidence: number;
  reason?: string;
}

function extractJsonArray<T>(text: string): T {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error("No JSON array in model response");
  return JSON.parse(m[0]) as T;
}

async function adjudicate(
  post: RedditPost,
  candidates: UpdateCandidate[],
  tier: Tier,
  onLlmUsage?: LlmUsageCallback
): Promise<Map<string, AiVerdict>> {
  const llm = resolveModels(tier).llm;
  const numbered = candidates
    .map(
      (c, i) =>
        `#${i + 1} [id=${c.key}] (${c.kind}) title: ${c.title}\nexcerpt: ${c.body.slice(0, 300)}`
    )
    .join("\n\n");
  const prompt = `You decide whether each CANDIDATE is a genuine later UPDATE / follow-up to the SAME first-person story as the ORIGINAL — same author, same situation, continuing or resolving it. A different unrelated post by the same person is NOT an update.

ORIGINAL
title: ${post.title}
excerpt: ${post.body.slice(0, 400)}

CANDIDATES
${numbered}

For EACH candidate output an object: { "key": "<id>", "isUpdate": true|false, "confidence": 0.0-1.0, "reason": "short" }.
confidence is how sure you are it continues THIS story.

OUTPUT JSON ARRAY ONLY, one object per candidate, in order.`;

  const { text, usage } = await generateText({ model: openrouter(llm), prompt });
  reportLlmUsage(onLlmUsage, "Update adjudication", llm, usage);
  const parsed = extractJsonArray<AiVerdict[]>(text);
  const byKey = new Map<string, AiVerdict>();
  parsed.forEach((v, i) => {
    const key = v.key && candidates.some((c) => c.key === v.key) ? v.key : candidates[i]?.key;
    if (key) byKey.set(key, { ...v, key });
  });
  return byKey;
}

function decideCandidate(
  candidate: UpdateCandidate,
  verdict: AiVerdict | undefined,
  aiAvailable: boolean,
  threshold: number
): UpdateDecision {
  if (candidate.kind === "manual") return "include";
  if (aiAvailable) {
    if (verdict?.isUpdate && (verdict.confidence ?? 0) >= threshold) return "include";
    if (hasStrongSignal(candidate.matchedSignals)) return "candidate";
    if (candidate.matchedSignals.includes("embedded_link")) return "candidate";
    return "rejected";
  }
  // No LLM verdict — deterministic signals only.
  if (hasStrongSignal(candidate.matchedSignals)) return "include";
  if (candidate.matchedSignals.some((s) => s !== "author_match")) return "candidate";
  return "rejected";
}

/**
 * Discover the OP's later updates for a story. Unions embedded links and author
 * posts; adjudicates with an LLM (fallback to signals); merges
 * any precomputed candidates in `opts.existing` (e.g. manual links) by key.
 */
export async function discoverStoryUpdates(
  post: RedditPost,
  opts: {
    tier?: Tier;
    onLlmUsage?: LlmUsageCallback;
    existing?: UpdateCandidate[];
  } = {}
): Promise<UpdateDiscovery> {
  const tier = opts.tier ?? "value";
  const threshold = config.updateAiConfidence;

  // Updates come from the OP's PROFILE (their later posts) + links they put in
  // the post body. We deliberately do NOT mine the original post's comments —
  // OP replies there are asides, not the follow-up story, and pull in noise.
  const [embedded, authorPosts] = await Promise.all([
    collectEmbeddedLinkCandidates(post).catch((e: unknown) => {
      console.warn(`  embedded-link discovery failed: ${getErrorMessage(e)}`);
      recordOperationLog({ scope: "external", level: "warn", event: "reddit.embedded_discovery_fallback", message: "Embedded-link update discovery failed; continuing without those candidates", error: e });
      return [] as UpdateCandidate[];
    }),
    collectAuthorPostCandidates(post).catch((e: unknown) => {
      console.warn(`  author-post discovery failed: ${getErrorMessage(e)}`);
      recordOperationLog({ scope: "external", level: "warn", event: "reddit.author_discovery_fallback", message: "Author-profile update discovery failed; continuing without those candidates", error: e });
      return [] as UpdateCandidate[];
    }),
  ]);

  // Dedupe by key, keeping the highest-signal source (embedded > author).
  const byKey = new Map<string, UpdateCandidate>();
  for (const c of [...(opts.existing ?? []), ...embedded, ...authorPosts]) {
    const existing = byKey.get(c.key);
    if (!existing) {
      byKey.set(c.key, c);
    } else {
      // merge signals, keep the stronger kind/decision
      const merged = new Set<UpdateSignal>([...existing.matchedSignals, ...c.matchedSignals]);
      existing.matchedSignals = [...merged];
      existing.signalScore = signalScore(existing.matchedSignals);
      if (existing.kind !== "manual" && c.kind === "manual") {
        existing.kind = "manual";
        existing.decision = "include";
      }
    }
  }
  const candidates = [...byKey.values()].sort((a, b) => a.createdUtc - b.createdUtc);

  if (candidates.length === 0) {
    return { method: "signals", candidates: [], scannedAt: Date.now() };
  }

  // Adjudicate only the non-manual candidates; manual are user-asserted includes.
  const toJudge = candidates.filter((c) => c.kind !== "manual");
  let verdicts = new Map<string, AiVerdict>();
  let aiAvailable = false;
  if (toJudge.length > 0) {
    try {
      verdicts = await adjudicate(post, toJudge, tier, opts.onLlmUsage);
      aiAvailable = verdicts.size > 0;
    } catch (error: unknown) {
      console.warn(`  update adjudication failed, using signals: ${getErrorMessage(error)}`);
      recordOperationLog({
        scope: "external",
        level: "warn",
        event: "openrouter.update_adjudication_fallback",
        message: "Update adjudication failed; using deterministic update signals",
        metadata: { candidateCount: toJudge.length },
        error,
      });
    }
  }

  for (const c of candidates) {
    const verdict = verdicts.get(c.key);
    if (verdict) {
      c.aiConfidence = verdict.confidence;
      c.aiReason = verdict.reason;
    }
    c.decision = decideCandidate(c, verdict, aiAvailable, threshold);
  }

  const hasManual = candidates.some((c) => c.kind === "manual");
  const method: UpdateDiscovery["method"] = aiAvailable
    ? hasManual
      ? "hybrid"
      : "ai"
    : "signals";
  return { method, candidates, scannedAt: Date.now() };
}

/** Candidates currently included in the story body (decision === "include"). */
export function includedUpdateKeys(discovery: UpdateDiscovery | undefined): string[] {
  if (!discovery) return [];
  return discovery.candidates.filter((c) => c.decision === "include").map((c) => c.key);
}

/** Map included candidates to the RedditContinuation shape combinePostWithContinuations expects. */
export function updatesToContinuations(
  discovery: UpdateDiscovery | undefined,
  includedKeys?: string[]
): RedditContinuation[] {
  if (!discovery) return [];
  const keys = new Set(includedKeys ?? includedUpdateKeys(discovery));
  return discovery.candidates
    .filter((c) => keys.has(c.key))
    .map((c) => ({
      title: c.title,
      body: c.body,
      url: c.url,
      source: "author_post",
      createdUtc: c.createdUtc,
    }));
}
