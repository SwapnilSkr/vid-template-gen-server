import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import { config } from "../config";
import { resolveModels, type Tier } from "../config/models";
import { Story, type IStory, type StorySource } from "../models/story.model";
import { Reel } from "../models/reel.model";
import { getErrorMessage } from "../types";
import { getTrendDigest } from "./trend-insight.service";
import { reportLlmUsage, type LlmUsageCallback } from "./reel-script.service";

const openrouter = createOpenRouter({ apiKey: config.openRouterApiKey });

// ============================================
// Story engine — keeps a bank of fresh, non-repeating Reddit-style stories.
// Sourcing modes are pluggable: "llm" (original), "hybrid" (reddit-seeded
// rewrite), "verbatim" (real reddit post). A scheduled top-up job fills the
// bank; the gameplay reel pipeline draws from it. See docs.
// ============================================

export interface StoryDraft {
  title: string;
  body: string;
  theme?: string;
  genre?: string;
  subreddit?: string;
  author?: string;
  upvotes?: number;
  comments?: number;
  ageHours?: number;
  seedTitle?: string;
  seedUrl?: string;
  partNumber?: number;
  partCount?: number;
}

export interface StoryPartDraft extends StoryDraft {
  source: StorySource;
  partNumber: number;
  partCount: number;
}

type RedditSort = "top" | "hot" | "new";
type RedditTimeRange = "day" | "week" | "month" | "year" | "all";

interface RedditGenre {
  id: string;
  label: string;
  angle: string;
  subreddits: string[];
  sort?: RedditSort;
  timeRange?: RedditTimeRange;
  minWords?: number;
  maxWords?: number;
  keywords?: string[];
  avoidKeywords?: string[];
  weight?: number;
}

/**
 * Theme bank — each maps a flavour to a source subreddit + an angle prompt.
 * `weight` biases random pick() (higher = picked more often); default 1.
 * Curated + expanded 2026-07-01 from a trending-niches pass (see
 * docs/architecture/reddit-themes.md): AITA-style "make the viewer judge"
 * moral-dilemma framing is the strongest completion/watch-time driver, so
 * those themes carry extra weight. Dropped/replaced weak-volume sources
 * (r/EntitledPeople, r/antiwork, r/survivinginfidelity) with higher-volume
 * subs that still fit the same angle.
 */
export const THEMES: { id: string; subreddit: string; angle: string; weight?: number }[] = [
  // --- family / relationship drama ---
  { id: "twisted_family", subreddit: "r/AmItheAsshole", angle: "a twisted, complicated family conflict with a shocking reveal", weight: 2 },
  { id: "monster_in_law", subreddit: "r/JUSTNOMIL", angle: "an overbearing mother/monster-in-law crossing a serious line" },
  { id: "inheritance_war", subreddit: "r/AmItheAsshole", angle: "a family inheritance or will dispute that turns ruthless" },
  { id: "sibling_betrayal", subreddit: "r/AmItheAsshole", angle: "a sibling betrayal involving money, secrets or loyalty" },
  { id: "parenting_nightmare", subreddit: "r/insaneparents", angle: "a parent whose control crosses into disturbing territory" },
  { id: "relationship_advice", subreddit: "r/relationship_advice", angle: "a messy relationship dilemma begging for outside judgment" },
  { id: "cheating_karma", subreddit: "r/AmItheAsshole", angle: "infidelity uncovered and karma delivered" },

  // --- weddings ---
  { id: "wedding_drama", subreddit: "r/weddingshaming", angle: "someone sabotaging or hijacking a wedding" },
  { id: "wedding_invite_drama", subreddit: "r/AmItheAsshole", angle: "someone uninvited or humiliated over a wedding guest list" },

  // --- revenge / justice ---
  { id: "petty_revenge", subreddit: "r/pettyrevenge", angle: "a satisfying, precise act of petty revenge" },
  { id: "pro_revenge", subreddit: "r/ProRevenge", angle: "a long-game, devastating revenge plot years in the making" },
  { id: "nuclear_revenge", subreddit: "r/NuclearRevenge", angle: "an over-the-top, scorched-earth revenge that goes nuclear" },
  { id: "malicious_compliance", subreddit: "r/MaliciousCompliance", angle: "following the rules exactly to hilarious/vindicating effect" },

  // --- entitled people ---
  { id: "entitled_parents", subreddit: "r/entitledparents", angle: "an entitled parent demanding the impossible and facing consequences" },
  { id: "choosing_beggars", subreddit: "r/ChoosingBeggars", angle: "an absurdly entitled lowball demand exposed publicly" },
  { id: "neighbor_wars", subreddit: "r/NeighborsFromHell", angle: "an escalating feud with a nightmare neighbor" },
  { id: "roommate_horror", subreddit: "r/AmItheAsshole", angle: "a roommate whose behavior escalates from annoying to unhinged" },

  // --- workplace / customer service ---
  { id: "workplace_justice", subreddit: "r/MaliciousCompliance", angle: "a toxic boss/coworker getting their comeuppance" },
  { id: "tech_support_horror", subreddit: "r/talesfromtechsupport", angle: "an impossible customer/IT ticket that breaks the support agent" },
  { id: "retail_hell", subreddit: "r/TalesFromRetail", angle: "a nightmare customer encounter in retail" },

  // --- confessions / self-inflicted chaos / judgment-bait ---
  { id: "tifu", subreddit: "r/tifu", angle: "an embarrassing self-inflicted disaster that spirals out of control" },
  { id: "off_my_chest", subreddit: "r/offmychest", angle: "a raw, anonymous confession the narrator needs to get off their chest" },
  { id: "confession", subreddit: "r/confession", angle: "a shocking personal secret revealed for the first time" },
  { id: "am_i_the_villain", subreddit: "r/AmItheAsshole", angle: "a story where the narrator slowly reveals they were the villain all along" },
  { id: "am_i_overreacting", subreddit: "r/AmIOverreacting", angle: "a viral toss-up dilemma where the reader has to pick a side", weight: 2 },
];

export const REDDIT_GENRES: Record<string, RedditGenre> = {
  aita_family: {
    id: "aita_family",
    label: "AITA / Family Judgment",
    angle: "a family or relationship moral dilemma where viewers must pick a side",
    subreddits: ["r/AmItheAsshole", "r/AITAH", "r/AmIOverreacting", "r/amiwrong"],
    keywords: ["aita", "family", "mom", "dad", "sister", "brother", "wife", "husband", "wedding", "inheritance"],
    avoidKeywords: ["meta", "update request", "mod"],
    weight: 3,
  },
  relationship_drama: {
    id: "relationship_drama",
    label: "Relationship Drama",
    angle: "a messy relationship conflict with betrayal, boundaries, or a shocking reveal",
    subreddits: ["r/relationship_advice", "r/relationships", "r/TwoHotTakes", "r/AmIOverreacting"],
    keywords: ["boyfriend", "girlfriend", "wife", "husband", "partner", "cheating", "ex", "boundary"],
    avoidKeywords: ["minor", "underage"],
    weight: 2,
  },
  wedding_drama: {
    id: "wedding_drama",
    label: "Wedding Drama",
    angle: "a wedding conflict involving family pressure, invitations, money, outfits, or sabotage",
    subreddits: ["r/weddingshaming", "r/weddingdrama", "r/AmItheAsshole", "r/AITAH", "r/bridezillas"],
    keywords: ["wedding", "bride", "groom", "bridesmaid", "invite", "dress", "ceremony"],
    weight: 2,
  },
  petty_revenge: {
    id: "petty_revenge",
    label: "Petty Revenge",
    angle: "a satisfying petty revenge story with a clean setup and payoff",
    subreddits: ["r/pettyrevenge", "r/RegularRevenge", "r/MaliciousCompliance"],
    keywords: ["revenge", "petty", "neighbor", "coworker", "boss", "parking"],
    weight: 2,
  },
  pro_revenge: {
    id: "pro_revenge",
    label: "Pro / Nuclear Revenge",
    angle: "a long-game revenge story with serious consequences and a final payoff",
    subreddits: ["r/ProRevenge", "r/NuclearRevenge", "r/pettyrevenge"],
    timeRange: "month",
    minWords: 180,
    maxWords: 1600,
  },
  malicious_compliance: {
    id: "malicious_compliance",
    label: "Malicious Compliance",
    angle: "someone follows the rules exactly and turns authority against itself",
    subreddits: ["r/MaliciousCompliance", "r/talesfromtechsupport", "r/TalesFromRetail"],
    keywords: ["boss", "manager", "policy", "rule", "customer", "ticket"],
    weight: 2,
  },
  entitled_people: {
    id: "entitled_people",
    label: "Entitled People",
    angle: "an entitled person demands the impossible and faces consequences",
    subreddits: ["r/entitledparents", "r/EntitledPeople", "r/ChoosingBeggars", "r/IDontWorkHereLady"],
    keywords: ["entitled", "demanded", "free", "customer", "parent", "kid"],
    weight: 2,
  },
  choosing_beggars: {
    id: "choosing_beggars",
    label: "Choosing Beggars",
    angle: "an absurd demand from someone asking for free or discounted help",
    subreddits: ["r/ChoosingBeggars", "r/EntitledPeople", "r/assholetax"],
    keywords: ["free", "discount", "pay", "cash", "rent", "wishlist", "fund"],
  },
  workplace_justice: {
    id: "workplace_justice",
    label: "Workplace Justice",
    angle: "a toxic boss, coworker, or workplace policy backfires",
    subreddits: ["r/antiwork", "r/MaliciousCompliance", "r/talesfromtechsupport", "r/TalesFromRetail", "r/Serverlife"],
    keywords: ["boss", "manager", "coworker", "shift", "fired", "quit", "customer"],
    avoidKeywords: ["union organizing advice"],
  },
  customer_service: {
    id: "customer_service",
    label: "Customer Service Hell",
    angle: "a nightmare customer or support request spirals into a memorable story",
    subreddits: ["r/TalesFromRetail", "r/talesfromtechsupport", "r/TalesFromYourServer", "r/IDontWorkHereLady"],
    keywords: ["customer", "client", "server", "retail", "support", "ticket"],
  },
  confession: {
    id: "confession",
    label: "Confession / Off My Chest",
    angle: "a personal confession or heavy realization with emotional stakes",
    subreddits: ["r/confession", "r/offmychest", "r/TrueOffMyChest", "r/self"],
    keywords: ["confession", "secret", "guilt", "never told", "years ago"],
    avoidKeywords: ["suicide", "self harm"],
  },
  tifu: {
    id: "tifu",
    label: "TIFU",
    angle: "a self-inflicted mistake that escalates into an embarrassing or chaotic payoff",
    subreddits: ["r/tifu", "r/stories", "r/CasualConversation"],
    keywords: ["tifu", "today", "accidentally", "mistake", "embarrassing"],
  },
  updates: {
    id: "updates",
    label: "Best Updates",
    angle: "an update-heavy advice story with setup, consequences, and resolution",
    subreddits: ["r/BestofRedditorUpdates", "r/BestofBoRU"],
    timeRange: "month",
    minWords: 240,
    maxWords: 2200,
    keywords: ["update", "original", "oop", "final"],
    avoidKeywords: ["concluded: inconclusive", "ongoing"],
    weight: 2,
  },
  neighbors: {
    id: "neighbors",
    label: "Neighbor Wars",
    angle: "an escalating feud with a neighbor, HOA, parking, noise, or property line",
    subreddits: ["r/NeighborsFromHell", "r/fuckHOA", "r/pettyrevenge", "r/legaladvice"],
    keywords: ["neighbor", "hoa", "parking", "noise", "yard", "property"],
  },
};

// ---- Reddit (app-only OAuth; read-only) ----

let cachedToken: { token: string; expires: number } | null = null;

async function redditToken(): Promise<string> {
  if (!config.redditClientId || !config.redditClientSecret) {
    throw new Error(
      "Reddit modes need REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET (create a free app at reddit.com/prefs/apps). Use mode 'llm' to run without Reddit."
    );
  }
  if (cachedToken && cachedToken.expires > Date.now() + 30_000) return cachedToken.token;

  const basic = Buffer.from(`${config.redditClientId}:${config.redditClientSecret}`).toString("base64");
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": config.redditUserAgent,
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Reddit auth ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

interface RedditPost {
  id: string;
  title: string;
  body: string;
  url: string;
  subreddit: string;
  author: string;
  ups: number;
  comments: number;
  ageHours: number;
  createdUtc: number;
}

interface RedditContinuation {
  title: string;
  body: string;
  url: string;
  source: "op_comment" | "author_post";
  createdUtc: number;
}

interface RedditListingJson {
  data?: {
    children?: {
      data?: {
        id?: string;
        title?: string;
        selftext?: string;
        permalink?: string;
        subreddit_name_prefixed?: string;
        author?: string;
        ups?: number;
        num_comments?: number;
        created_utc?: number;
      };
    }[];
  };
}

function parseRedditListing(j: RedditListingJson, subreddit: string): RedditPost[] {
  return (j.data?.children ?? [])
    .map((c) => ({
      id: c.data?.id ?? "",
      title: c.data?.title ?? "",
      body: cleanRedditBody(c.data?.selftext ?? ""),
      url: c.data?.permalink ? `https://reddit.com${c.data.permalink}` : "",
      subreddit: c.data?.subreddit_name_prefixed ?? subreddit,
      author: c.data?.author ?? "unknown",
      ups: c.data?.ups ?? 0,
      comments: c.data?.num_comments ?? 0,
      ageHours: Math.max(1, Math.round((Date.now() / 1000 - (c.data?.created_utc ?? Date.now() / 1000)) / 3600)),
      createdUtc: c.data?.created_utc ?? 0,
    }))
    .filter((p) => {
      const body = p.body.trim().toLowerCase();
      return (
        Boolean(p.title && p.url) &&
        Boolean(p.id) &&
        p.body.length > 200 &&
        p.body.length < 12_000 &&
        body !== "[removed]" &&
        body !== "[deleted]" &&
        wordCount(p.body) >= 60
      );
    });
}

async function fetchPublicRedditPosts(
  subreddit: string,
  limit: number,
  t: RedditTimeRange,
  sort: RedditSort
): Promise<RedditPost[]> {
  const sub = subreddit.replace(/^r\//, "");
  const path = sort === "top" ? `top.json?t=${t}&` : `${sort}.json?`;
  const res = await fetch(
    `https://www.reddit.com/r/${sub}/${path}limit=${limit}&raw_json=1`,
    { headers: { "User-Agent": config.redditUserAgent } }
  );
  if (!res.ok) throw new Error(`Reddit public fetch ${res.status}: ${await res.text()}`);
  return parseRedditListing((await res.json()) as RedditListingJson, subreddit);
}

interface RedditCommentNode {
  kind?: string;
  data?: {
    body?: string;
    author?: string;
    permalink?: string;
    created_utc?: number;
    score?: number;
    replies?: "" | { data?: { children?: RedditCommentNode[] } };
  };
}

interface RedditCommentsJsonListing {
  data?: { children?: RedditCommentNode[] };
}

function isRemovedText(body: string): boolean {
  const normalized = body.trim().toLowerCase();
  return normalized === "[removed]" || normalized === "[deleted]";
}

function flattenComments(nodes: RedditCommentNode[] = []): RedditCommentNode[] {
  const out: RedditCommentNode[] = [];
  for (const node of nodes) {
    if (node.kind === "more") continue;
    out.push(node);
    const replies = node.data?.replies;
    if (replies && typeof replies === "object") {
      out.push(...flattenComments(replies.data?.children ?? []));
    }
  }
  return out;
}

function continuationCue(text: string): boolean {
  return /\b(update|edit|final update|mini update|part\s*(?:two|three|four|\d+)|continued|continuation|follow[ -]?up|for everyone asking|since people asked|in the comments|comment update)\b/i.test(text);
}

function significantTitleWords(title: string): Set<string> {
  const stop = new Set(["aita", "aitah", "update", "final", "part", "with", "that", "this", "from", "have", "after", "before", "because", "about"]);
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3 && !stop.has(word))
      .slice(0, 10)
  );
}

function titleOverlap(a: string, b: string): number {
  const aw = significantTitleWords(a);
  const bw = significantTitleWords(b);
  let count = 0;
  for (const word of aw) if (bw.has(word)) count++;
  return count;
}

async function redditFetchJson(path: string): Promise<unknown> {
  const token = await redditToken();
  const res = await fetch(`https://oauth.reddit.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": config.redditUserAgent },
  });
  if (!res.ok) {
    const detail = await res.text();
    if (res.status === 403 || res.status === 429) {
      const [pathname, query] = path.split("?", 2);
      const jsonPath = pathname.endsWith(".json") ? pathname : `${pathname}.json`;
      const publicRes = await fetch(`https://www.reddit.com${jsonPath}${query ? `?${query}` : ""}`, {
        headers: { "User-Agent": config.redditUserAgent },
      });
      if (!publicRes.ok) {
        throw new Error(
          `Reddit fetch ${res.status}: ${detail}; public fallback ${publicRes.status}: ${await publicRes.text()}`
        );
      }
      return publicRes.json();
    }
    throw new Error(`Reddit fetch ${res.status}: ${detail}`);
  }
  return res.json();
}

async function fetchOpCommentContinuations(post: RedditPost): Promise<RedditContinuation[]> {
  if (!post.id || !post.author || post.author === "[deleted]") return [];
  const json = (await redditFetchJson(`/comments/${post.id}?limit=500&sort=qa&raw_json=1`)) as [
    unknown,
    RedditCommentsJsonListing,
  ];
  const comments = flattenComments(json[1]?.data?.children ?? []);
  return comments
    .filter((node) => node.data?.author?.toLowerCase() === post.author.toLowerCase())
    .map((node): RedditContinuation | undefined => {
      const body = cleanRedditBody(node.data?.body ?? "");
      if (wordCount(body) < 25 || isRemovedText(body)) return undefined;
      if (!continuationCue(body) && wordCount(body) < 70) return undefined;
      return {
        title: "OP comment update",
        body,
        url: node.data?.permalink ? `https://reddit.com${node.data.permalink}` : post.url,
        source: "op_comment",
        createdUtc: node.data?.created_utc ?? post.createdUtc,
      };
    })
    .filter((item): item is RedditContinuation => Boolean(item))
    .sort((a, b) => a.createdUtc - b.createdUtc)
    .slice(0, 4);
}

async function fetchAuthorPostContinuations(post: RedditPost): Promise<RedditContinuation[]> {
  if (!post.author || post.author === "[deleted]") return [];
  const json = (await redditFetchJson(
    `/user/${encodeURIComponent(post.author)}/submitted?sort=new&limit=50&raw_json=1`
  )) as RedditListingJson;
  return parseRedditListing(json, post.subreddit)
    .filter((candidate) => candidate.url !== post.url)
    .filter((candidate) => candidate.createdUtc > post.createdUtc)
    .filter((candidate) => candidate.createdUtc - post.createdUtc < 60 * 60 * 24 * 120)
    .filter((candidate) => {
      const combined = `${candidate.title}\n${candidate.body}`;
      return continuationCue(combined) || titleOverlap(post.title, candidate.title) >= 2;
    })
    .map((candidate) => ({
      title: candidate.title,
      body: candidate.body,
      url: candidate.url,
      source: "author_post" as const,
      createdUtc: candidate.createdUtc,
    }))
    .sort((a, b) => a.createdUtc - b.createdUtc)
    .slice(0, 3);
}

function combinePostWithContinuations(post: RedditPost, continuations: RedditContinuation[]): RedditPost {
  if (!continuations.length) return post;
  const unique = new Map<string, RedditContinuation>();
  for (const continuation of continuations) {
    const key = `${continuation.source}:${continuation.url}:${continuation.body.slice(0, 80)}`;
    unique.set(key, continuation);
  }
  const ordered = [...unique.values()].sort((a, b) => a.createdUtc - b.createdUtc);
  const body = [
    post.body,
    ...ordered.map((item) => `${item.title.toLowerCase().includes("update") ? item.title : "Update"}: ${item.body}`),
  ].join("\n\n");
  const latest = ordered[ordered.length - 1];
  return {
    ...post,
    body,
    comments: post.comments + ordered.length,
    url: latest?.url ?? post.url,
  };
}

async function resolveRedditStoryThread(post: RedditPost): Promise<RedditPost> {
  const [comments, authorPosts] = await Promise.all([
    fetchOpCommentContinuations(post).catch((error: unknown) => {
      console.warn(`  reddit comments skipped for ${post.url}: ${getErrorMessage(error)}`);
      return [];
    }),
    fetchAuthorPostContinuations(post).catch((error: unknown) => {
      console.warn(`  reddit author updates skipped for u/${post.author}: ${getErrorMessage(error)}`);
      return [];
    }),
  ]);
  return combinePostWithContinuations(post, [...comments, ...authorPosts]);
}

async function fetchRedditPosts(
  subreddit: string,
  limit = 25,
  t: RedditTimeRange = "week",
  sort: RedditSort = "top"
): Promise<RedditPost[]> {
  const token = await redditToken();
  const sub = subreddit.replace(/^r\//, "");
  const path = sort === "top" ? `top?t=${t}&` : `${sort}?`;
  const res = await fetch(
    `https://oauth.reddit.com/r/${sub}/${path}limit=${limit}&raw_json=1`,
    { headers: { Authorization: `Bearer ${token}`, "User-Agent": config.redditUserAgent } }
  );
  if (!res.ok) {
    const detail = await res.text();
    if (res.status === 403 || res.status === 429) {
      console.warn(`  reddit oauth fetch ${res.status} for ${subreddit}; trying public JSON fallback`);
      try {
        return await fetchPublicRedditPosts(subreddit, limit, t, sort);
      } catch (fallbackError: unknown) {
        throw new Error(`Reddit fetch ${res.status}: ${detail}; fallback failed: ${getErrorMessage(fallbackError)}`);
      }
    }
    throw new Error(`Reddit fetch ${res.status}: ${detail}`);
  }
  return parseRedditListing((await res.json()) as RedditListingJson, subreddit);
}

// ---- dedupe ----

/** Normalized premise key: lowercased significant words of the title. */
function premiseKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 8)
    .sort()
    .join("-");
}

async function isDuplicate(title: string, seedUrl?: string, excludeStoryId?: string): Promise<boolean> {
  if (seedUrl) {
    const seedFilter = excludeStoryId ? { seedUrl, _id: { $ne: excludeStoryId } } : { seedUrl };
    if ((await Story.exists(seedFilter)) || (await isSeedUrlUsedByLiveReel(seedUrl))) return true;
  }
  const premiseFilter = excludeStoryId
    ? { premiseKey: premiseKey(title), _id: { $ne: excludeStoryId } }
    : { premiseKey: premiseKey(title) };
  return !!(await Story.exists(premiseFilter));
}

function reelSeedExclusionFilter(excludeReelIds?: string[]): Record<string, unknown> {
  if (!excludeReelIds?.length) return {};
  if (excludeReelIds.length === 1) return { _id: { $ne: excludeReelIds[0] } };
  return { _id: { $nin: excludeReelIds } };
}

async function isSeedUrlUsedByLiveReel(
  seedUrl?: string,
  excludeReelId?: string | string[]
): Promise<boolean> {
  if (!seedUrl) return false;
  const excludeReelIds = Array.isArray(excludeReelId)
    ? excludeReelId
    : excludeReelId
      ? [excludeReelId]
      : undefined;
  const filter = {
    "redditStory.seedUrl": seedUrl,
    ...reelSeedExclusionFilter(excludeReelIds),
  };
  return !!(await Reel.exists(filter));
}

function normalizeRedditUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

function parseRedditPostId(url: string): string | null {
  const match = url.trim().match(/\/comments\/([a-z0-9]+)/i);
  return match?.[1] ?? null;
}

async function fetchPostByUrl(url: string): Promise<RedditPost | null> {
  const postId = parseRedditPostId(url);
  if (!postId) return null;
  try {
    const json = (await redditFetchJson(`/comments/${postId}?limit=1&raw_json=1`)) as [
      RedditListingJson,
      unknown,
    ];
    const posts = parseRedditListing(json[0], "");
    return posts[0] ?? null;
  } catch (error: unknown) {
    console.warn(`  reddit post fetch failed for ${url}: ${getErrorMessage(error)}`);
    return null;
  }
}

/** Re-check dedupe guards before reserving or materializing a story. */
export async function assertStoryAvailable(
  title: string,
  seedUrl?: string,
  opts?: { excludeStoryId?: string; excludeReelId?: string; excludeReelIds?: string[] }
): Promise<void> {
  if (await isDuplicate(title, seedUrl, opts?.excludeStoryId)) {
    throw new Error("This story is no longer available");
  }
  const excludeReelIds = opts?.excludeReelIds ?? (opts?.excludeReelId ? [opts.excludeReelId] : undefined);
  if (seedUrl && (await isSeedUrlUsedByLiveReel(seedUrl, excludeReelIds))) {
    throw new Error("This Reddit post is already used by another reel");
  }
}

// ---- LLM helpers ----

/** Weighted random pick (used for THEMES, where `weight` biases selection). */
function pickWeighted<T extends { weight?: number }>(a: T[]): T {
  const total = a.reduce((sum, item) => sum + (item.weight ?? 1), 0);
  let r = Math.random() * total;
  for (const item of a) {
    r -= item.weight ?? 1;
    if (r <= 0) return item;
  }
  return a[a.length - 1];
}

function themeToGenre(theme: (typeof THEMES)[number]): RedditGenre {
  return {
    id: theme.id,
    label: theme.id,
    angle: theme.angle,
    subreddits: [theme.subreddit],
    weight: theme.weight,
  };
}

function pickGenre(genreId?: string): RedditGenre {
  if (genreId) {
    const genre = REDDIT_GENRES[genreId];
    if (!genre) {
      throw new Error(
        `Unknown reddit genre "${genreId}". Available: ${Object.keys(REDDIT_GENRES).join(", ")}`
      );
    }
    return genre;
  }
  return pickWeighted(Object.values(REDDIT_GENRES));
}

function containsAny(text: string, terms: string[] | undefined): boolean {
  if (!terms?.length) return false;
  const haystack = text.toLowerCase();
  return terms.some((term) => {
    const needle = term.toLowerCase().trim();
    if (!needle) return false;
    if (needle.includes(" ")) return haystack.includes(needle);
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}([^a-z0-9]|$)`, "i").test(haystack);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function genreAllowsPost(post: RedditPost, genre: RedditGenre): boolean {
  const words = wordCount(post.body);
  if (words < (genre.minWords ?? 90)) return false;
  if (words > (genre.maxWords ?? 1800)) return false;
  const combined = `${post.title}\n${post.body}`;
  if (containsAny(combined, genre.avoidKeywords)) return false;
  if (genre.keywords?.length && !containsAny(combined, genre.keywords)) return false;
  return true;
}

function scorePost(post: RedditPost, genre: RedditGenre): number {
  const words = wordCount(post.body);
  const combined = `${post.title}\n${post.body}`;
  const engagement = Math.log10(post.ups + 10) * 10 + Math.log10(post.comments + 5) * 6;
  const wordFit = words >= 140 && words <= 900 ? 12 : words >= 90 && words <= 1400 ? 6 : 0;
  const keywordFit = containsAny(combined, genre.keywords) ? 10 : 0;
  const titleHook = /aita|aitah|update|found out|cheat|wedding|revenge|entitled|boss|wife|husband/i.test(post.title)
    ? 8
    : 0;
  const updateFit = /(^|\s)(edit|update|final update|more later|i'?ll update)\b/i.test(post.body) ? 6 : 0;
  const freshnessPenalty = post.ageHours > 24 * 90 ? -4 : 0;

  return engagement + wordFit + keywordFit + titleHook + updateFit + freshnessPenalty;
}

async function fetchGenrePosts(genre: RedditGenre, limitPerSubreddit = 35): Promise<RedditPost[]> {
  const all: RedditPost[] = [];
  for (const subreddit of genre.subreddits) {
    try {
      const posts = await fetchRedditPosts(
        subreddit,
        limitPerSubreddit,
        genre.timeRange ?? "week",
        genre.sort ?? "top"
      );
      all.push(...posts.filter((post) => genreAllowsPost(post, genre)));
    } catch (error: unknown) {
      console.warn(`  reddit fetch skipped ${subreddit}: ${getErrorMessage(error)}`);
    }
  }

  return all.sort((a, b) => scorePost(b, genre) - scorePost(a, genre));
}

async function storyUnavailableReason(title: string, seedUrl?: string): Promise<string | undefined> {
  if (seedUrl && (await isSeedUrlUsedByLiveReel(seedUrl))) {
    return "Already used on another reel";
  }
  if (seedUrl && (await Story.exists({ seedUrl }))) {
    return "Already in story bank";
  }
  if (await Story.exists({ premiseKey: premiseKey(title) })) {
    return "Similar story already banked";
  }
  return undefined;
}

function bankDocToPost(doc: IStory, genre: RedditGenre): RedditPost {
  return {
    id: doc._id.toString(),
    title: doc.title,
    body: doc.body,
    url: doc.seedUrl ?? `bank://${doc._id}`,
    subreddit: doc.subreddit ?? genre.subreddits[0] ?? "r/unknown",
    author: doc.author ?? "anonymous",
    ups: doc.upvotes ?? 0,
    comments: doc.comments ?? 0,
    ageHours: doc.ageHours ?? 0,
    createdUtc: Math.floor(doc.createdAt.getTime() / 1000),
  };
}

async function resolvePostForSeries(
  genre: RedditGenre,
  opts: { selectedSeedUrl?: string; selectedStoryId?: string; excludeReelIds?: string[] }
): Promise<RedditPost> {
  if (opts.selectedSeedUrl) {
    let post = await fetchPostByUrl(opts.selectedSeedUrl);
    if (!post) {
      const posts = await fetchGenrePosts(genre, 50);
      const target = normalizeRedditUrl(opts.selectedSeedUrl);
      post = posts.find((p) => normalizeRedditUrl(p.url) === target) ?? null;
    }
    if (!post) throw new Error(`Could not load Reddit post: ${opts.selectedSeedUrl}`);
    await assertStoryAvailable(post.title, post.url, { excludeReelIds: opts.excludeReelIds });
    return post;
  }

  if (opts.selectedStoryId) {
    const doc = await Story.findById(opts.selectedStoryId);
    if (!doc) throw new Error("Story not found");
    await assertStoryAvailable(doc.title, doc.seedUrl, {
      excludeStoryId: doc._id.toString(),
      excludeReelIds: opts.excludeReelIds,
    });
    if (doc.seedUrl) {
      let post = await fetchPostByUrl(doc.seedUrl);
      if (!post) {
        const posts = await fetchGenrePosts(genre, 50);
        const target = normalizeRedditUrl(doc.seedUrl);
        post = posts.find((p) => normalizeRedditUrl(p.url) === target) ?? null;
      }
      if (post) return post;
    }
    return bankDocToPost(doc, genre);
  }

  return pickRedditPost(genre);
}

function parseSeriesParts(parts?: string): number | "auto" | undefined {
  if (!parts || parts === "off") return undefined;
  if (parts === "auto") return "auto";
  const n = Number(parts);
  return Number.isFinite(n) ? n : undefined;
}

function estimatePartsForWords(
  parts: number | "auto" | undefined,
  words: number
): number | undefined {
  if (parts === undefined) return undefined;
  return resolvePartCount(parts, words);
}

async function pickRedditPost(genre: RedditGenre): Promise<RedditPost> {
  const posts = await fetchGenrePosts(genre);
  if (!posts.length) throw new Error(`No usable posts for reddit genre ${genre.id}`);

  for (const post of posts) {
    if (!(await isDuplicate(post.title, post.url))) return post;
  }
  throw new Error(`No fresh unused posts for reddit genre ${genre.id}`);
}

function extractJson<T>(text: string): T {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("No JSON in model response");
  return JSON.parse(m[0]) as T;
}

async function llmStory(
  angle: string,
  tier: Tier,
  genreId?: string,
  seed?: RedditPost,
  onLlmUsage?: LlmUsageCallback,
): Promise<StoryDraft> {
  const llm = resolveModels(tier).llm;
  const seedBlock = seed
    ? `\nINSPIRATION (real post — use only as loose inspiration, do NOT copy specifics, names, or wording):\nTitle: ${seed.title}\nExcerpt: ${seed.body.slice(0, 600)}\n`
    : "";
  const digest = await getTrendDigest("reddit", genreId);
  const trendBlock = digest ? `\nCURRENT WINNING PATTERNS (from trending videos in this genre this week):\n${digest}\n` : "";
  const prompt = `You write viral Reddit-style short-form stories read aloud over gameplay footage.

FLAVOUR: ${angle}${seedBlock}${trendBlock}

RULES:
- The TITLE is a curiosity-gap hook (r/AITA / confession style), max ~14 words, no emojis.
- BODY: first person, conversational, 90-160 words, 5-10 short punchy sentences. Escalating tension, satisfying twist/payoff in the last sentence.
- Read naturally aloud: spell out numbers, no markdown, no headings, no emojis, no "edit:"/"update:".
- Must be ORIGINAL — invented people and details.

OUTPUT JSON ONLY: { "title": "...", "body": "..." }`;

  const { text, usage } = await generateText({ model: openrouter(llm), prompt });
  reportLlmUsage(onLlmUsage, "Reddit story", llm, usage);
  const parsed = extractJson<{ title: string; body: string }>(text);
  if (!parsed.title || !parsed.body) throw new Error("LLM story missing title/body");
  return parsed;
}

async function llmStorySeries(
  angle: string,
  tier: Tier,
  partCount: number,
  genreId?: string,
  seed?: RedditPost
): Promise<StoryDraft[]> {
  const llm = resolveModels(tier).llm;
  const seedBlock = seed
    ? `\nINSPIRATION (real post — use only as loose inspiration, do NOT copy specifics, names, or wording):\nTitle: ${seed.title}\nExcerpt: ${seed.body.slice(0, 1000)}\n`
    : "";
  const digest = await getTrendDigest("reddit", genreId);
  const trendBlock = digest ? `\nCURRENT WINNING PATTERNS (from trending videos in this genre this week):\n${digest}\n` : "";
  const cliffhangerSpec = `CLIFFHANGER REQUIREMENT (non-negotiable for every part except the last):
- The FINAL sentence of each non-final part is the retention hook. It MUST do one of: pose an urgent open question, stop mid-action right before something happens, tease a shocking reveal, or escalate the threat to a new level.
- It must make skipping to the next part feel unbearable. Never end a non-final part on a calm, resolved, or wrap-up line (no "anyway", "that was that", "the end", "more soon").
- The final part's last sentence delivers the payoff and may resolve.
- Before returning, RE-READ the last sentence of each non-final part and rewrite any that a viewer could comfortably stop on.`;
  const prompt = `You write serialized Reddit-style short-form stories read aloud over gameplay footage.

FLAVOUR: ${angle}${seedBlock}${trendBlock}

Create exactly ${partCount} parts of one continuous story.

RULES:
- Each part title is a curiosity-gap Reddit hook and must end with "Part N".
- Each part body is first person, conversational, 90-150 words, 5-9 punchy sentences.
- Part 1 sets up the conflict fast and ends on a strong cliffhanger.
- Middle parts escalate and end on unanswered consequences.
- Final part gives the reveal/payoff.
- Read naturally aloud: spell out numbers, no markdown, no headings, no emojis, no "edit:"/"update:".
- Must be ORIGINAL — invented people and details.

${cliffhangerSpec}

OUTPUT JSON ONLY:
{ "parts": [
  { "title": "... Part 1", "body": "..." },
  { "title": "... Part 2", "body": "..." }
] }`;

  const parseAndValidate = (text: string): StoryDraft[] => {
    const parsed = extractJson<{ parts: StoryDraft[] }>(text);
    if (!Array.isArray(parsed.parts) || parsed.parts.length !== partCount) {
      throw new Error("LLM series missing expected parts");
    }
    for (const part of parsed.parts) {
      if (!part.title || !part.body) throw new Error("LLM series part missing title/body");
    }
    return parsed.parts;
  };

  const { text } = await generateText({ model: openrouter(llm), prompt });
  let parts = parseAndValidate(text);

  // Cliffhanger scrutiny. Primary: an LLM judge rates every non-final ending and
  // rewrites the soft ones (catches subtle misses keyword checks can't see). If
  // the judge call fails, fall back to the free deterministic guard.
  try {
    parts = await judgeAndFixCliffhangers(parts, llm);
  } catch {
    const weak = parts.slice(0, -1).some((part) => endsFlat(part.body));
    if (weak) {
      try {
        const retry = await generateText({
          model: openrouter(llm),
          prompt: `${prompt}

The previous draft ended a non-final part on a flat, resolvable line. Regenerate ALL parts; every non-final part must end on an urgent cliffhanger the viewer cannot stop on.`,
        });
        parts = parseAndValidate(retry.text);
      } catch {
        // Keep the first draft if the repair pass also fails.
      }
    }
  }
  return parts;
}

const firstSentence = (body: string): string => splitSentences(body)[0]?.trim() ?? "";

/**
 * LLM "retention editor" pass: scores each NON-FINAL part's ending 1-5 as a
 * cliffhanger and rewrites any it scores <= 3, keeping the same events, length,
 * and handoff into the next part. Best-effort — the caller handles failures.
 */
async function judgeAndFixCliffhangers(parts: StoryDraft[], llm: string): Promise<StoryDraft[]> {
  if (parts.length < 2) return parts;
  const nonFinal = parts.slice(0, -1);
  const list = nonFinal
    .map(
      (part, i) =>
        `--- PART ${i + 1} of ${parts.length} ---\n${part.body}\n[The next part opens with: "${firstSentence(
          parts[i + 1].body
        )}"]`
    )
    .join("\n\n");
  const prompt = `You are a retention editor for serialized short-form videos. Rate how strong each NON-FINAL part's ENDING is as a cliffhanger, 1-5 (5 = the viewer physically cannot stop; 1 = calm/resolved). A 5 poses an urgent open question, stops mid-action right before impact, teases a shocking reveal, or escalates the threat to a new level.

For every part you score 3 or lower, rewrite its FULL body. Keep the same events and characters, stay first person and read-aloud (90-150 words, 5-9 sentences, no markdown, no emojis, no "edit:"/"update:"), keep it flowing naturally into the next part's opening shown in brackets — but end on a 5-level cliffhanger. Leave parts scored 4 or 5 untouched (omit their body).

${list}

OUTPUT JSON ONLY:
{ "verdicts": [ { "part": 1, "score": 3, "body": "rewritten full body — omit when score >= 4" } ] }`;

  const { text } = await generateText({ model: openrouter(llm), prompt });
  const parsed = extractJson<{ verdicts?: EndingVerdict[] }>(text);
  return applyEndingVerdicts(parts, parsed.verdicts ?? []);
}

type EndingVerdict = { part?: number; score?: number; body?: string };

/**
 * Splice the judge's rewrites back into the series: apply a rewrite only when the
 * verdict targets a NON-FINAL part, scores it soft (<= 3), and returns a
 * substantial body. Pure so it can be unit-tested without an LLM call.
 */
function applyEndingVerdicts(parts: StoryDraft[], verdicts: EndingVerdict[]): StoryDraft[] {
  const fixed = parts.map((part) => ({ ...part }));
  for (const verdict of verdicts) {
    const idx = (verdict.part ?? 0) - 1;
    if (idx < 0 || idx >= parts.length - 1) continue; // never rewrite the finale
    const rewrite = verdict.body?.trim();
    if (typeof verdict.score === "number" && verdict.score <= 3 && rewrite && wordCount(rewrite) >= 40) {
      fixed[idx] = { ...fixed[idx], body: rewrite };
    }
  }
  return fixed;
}

/** True when a body ends on a deflating / resolved line — a poor episode cliffhanger. */
function endsFlat(body: string): boolean {
  const sentences = splitSentences(body);
  const last = sentences[sentences.length - 1]?.trim() ?? "";
  if (wordCount(last) < 4) return true;
  return /\b(anyway|so yeah|that'?s it|that was that|thanks for reading|the end|nothing (?:else )?happened|more soon|to be continued)\b/i.test(
    last
  );
}

/** Trim a verbatim reddit body to a narratable length at a sentence boundary. */
function trimBody(body: string, maxWords = 160): string {
  const clean = body.replace(/\s+/g, " ").replace(/&amp;/g, "&").trim();
  const words = clean.split(" ");
  if (words.length <= maxWords) return clean;
  const cut = words.slice(0, maxWords).join(" ");
  const lastStop = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"));
  return lastStop > 60 ? cut.slice(0, lastStop + 1) : cut + "...";
}

function cleanRedditBody(body: string): string {
  return body
    .replace(/&amp;/g, "&")
    .replace(/\r/g, "\n")
    .replace(/^>.*$/gm, "")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function splitSentences(text: string): string[] {
  return (
    text
      .match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g)
      ?.map((s) => s.trim())
      .filter(Boolean) ?? [text.trim()]
  );
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function resolvePartCount(requested: number | "auto" | undefined, words: number): number {
  if (typeof requested === "number") {
    // An explicit 1 (or lower) means "no split" — the whole story in one reel.
    if (requested <= 1) return 1;
    return Math.min(Math.max(Math.round(requested), 2), 4);
  }
  if (words < 220) return 1;
  return Math.min(Math.max(Math.ceil(words / 145), 2), 4);
}

function titleWithPart(title: string, partNumber: number): string {
  const stripped = title.replace(/\s+part\s+\d+\s*$/i, "").trim();
  return `${stripped} Part ${partNumber}`;
}

function fallbackCutAfter(sentences: string[], partCount: number): number[] {
  const totalWords = sentences.reduce((sum, s) => sum + wordCount(s), 0);
  const cuts: number[] = [];
  let sentenceIndex = 0;
  let runningWords = 0;

  for (let part = 1; part < partCount; part++) {
    const target = (totalWords * part) / partCount;
    while (sentenceIndex < sentences.length - 1 && runningWords < target) {
      runningWords += wordCount(sentences[sentenceIndex]);
      sentenceIndex++;
    }
    cuts.push(sentenceIndex);
  }

  return cuts;
}

/** Running word total after each sentence (cum[i] = words through sentence i). */
function cumulativeWords(sentences: string[]): number[] {
  const cum: number[] = [];
  let running = 0;
  for (const s of sentences) {
    running += wordCount(s);
    cum.push(running);
  }
  return cum;
}

/**
 * Heuristic strength of a sentence as an episode-ENDING hook. Verbatim can't
 * invent a cliffhanger — this only ranks the endings the story already offers,
 * so a cut can be nudged onto the strongest one nearby. `next` is the sentence
 * the FOLLOWING part would open on (cutting right before an "Edit/Update" is gold).
 */
function cliffhangerScore(sentence: string, next?: string): number {
  const s = sentence.trim();
  const words = wordCount(s);
  let score = 0;
  if (/[?]["'’)\]]*$/.test(s)) score += 3; // leaves an open question
  if (/(\.\.\.|…)["'’)\]]*$/.test(s)) score += 2; // trails off mid-tension
  if (next && /^\s*(edit|update|final update|part\s*\d)\b/i.test(next)) score += 4; // land right before the payoff
  if (
    /\b(but then|then i|that'?s when|suddenly|until|little did|what happened next|turned out|turns out|realized|found out|next thing|never (?:expected|thought|imagined)|everything changed|out of nowhere|the moment|come to find)\b/i.test(
      s
    )
  )
    score += 2; // escalation / reveal cue
  if (
    /\b(police|cops|lawyer|lawsuit|court|judge|gun|knife|blood|hospital|dead|died|dying|divorce|fired|evicted|pregnant|cheating|affair|threat|threatened|911|emergency|scream|screamed|arrested|restraining order|custody)\b/i.test(
      s
    )
  )
    score += 1; // raised stakes
  if (words < 5) score -= 2; // too short to land a beat
  if (/\b(anyway|so yeah|that'?s it|thanks for reading|tl;?dr|to be continued)\b/i.test(s)) score -= 3; // deflates tension
  return score;
}

/**
 * Nudge each cut onto the strongest cliffhanger within a word-balance window,
 * preserving order/validity. `margin` guards how much better a nearby ending
 * must be before we move: a small margin (fallback) chases hooks aggressively;
 * a larger one (post-LLM) only rescues parts the model ended on a flat line.
 */
function refineCutsForCliffhangers(sentences: string[], cuts: number[], margin: number): number[] {
  const n = sentences.length;
  if (n <= 2 || cuts.length === 0) return cuts;
  const cum = cumulativeWords(sentences);
  const total = cum[n - 1] ?? 0;
  const partCount = cuts.length + 1;
  const slack = (total / partCount) * 0.4; // a boundary may drift ±40% of one part's words
  const refined: number[] = [];
  let prev = 0;
  for (let i = 0; i < cuts.length; i++) {
    const remaining = cuts.length - i - 1;
    const maxK = n - 1 - remaining; // leave one sentence for every later part + the finale
    const origK = Math.min(Math.max(cuts[i], prev + 1), maxK);
    const idealWords = cum[origK - 1] ?? 0;
    const origScore = cliffhangerScore(sentences[origK - 1], sentences[origK]);
    let bestK = origK;
    let bestScore = origScore;
    for (let k = prev + 1; k <= maxK; k++) {
      const endWords = cum[k - 1] ?? 0;
      if (Math.abs(endWords - idealWords) > slack) continue;
      const score = cliffhangerScore(sentences[k - 1], sentences[k]) - Math.abs(k - origK) * 0.01;
      if (score > bestScore + (k === origK ? 0 : margin)) {
        bestScore = score;
        bestK = k;
      }
    }
    refined.push(bestK);
    prev = bestK;
  }
  return refined;
}

function normalizeCuts(cuts: number[], sentenceCount: number, partCount: number): number[] {
  const valid = [...new Set(cuts)]
    .map((n) => Math.round(n))
    .filter((n) => n > 0 && n < sentenceCount)
    .sort((a, b) => a - b);
  if (valid.length >= partCount - 1) return valid.slice(0, partCount - 1);

  const filled = [...valid];
  for (let i = 1; i < partCount; i++) {
    const cut = Math.round((sentenceCount * i) / partCount);
    if (cut > 0 && cut < sentenceCount && !filled.includes(cut)) filled.push(cut);
  }
  return filled.sort((a, b) => a - b).slice(0, partCount - 1);
}

async function selectVerbatimCuts(
  title: string,
  sentences: string[],
  partCount: number,
  tier: Tier
): Promise<number[]> {
  // Fallback: balance by words, then chase the strongest nearby hook aggressively.
  const fallback = normalizeCuts(
    refineCutsForCliffhangers(sentences, fallbackCutAfter(sentences, partCount), 0.5),
    sentences.length,
    partCount
  );
  // Not enough sentences to place partCount-1 distinct interior cuts.
  if (sentences.length <= partCount) return fallback;

  const llm = resolveModels(tier).llm;
  const totalWords = sentences.reduce((sum, s) => sum + wordCount(s), 0);
  const targetWords = Math.max(1, Math.round(totalWords / partCount));
  const minWords = Math.round(targetWords * 0.6);
  const maxWords = Math.round(targetWords * 1.5);

  // Annotate each sentence with the running word total so the model can balance
  // parts while still being free to cut anywhere (not just near word targets).
  let running = 0;
  const numbered = sentences
    .map((s, i) => {
      running += wordCount(s);
      return `${i + 1}. [${running}w] ${s}`;
    })
    .join("\n");

  const prompt = `You are splitting a verbatim first-person Reddit story into ${partCount} sequential short-video parts (each becomes its own 55-75s reel).

Title: ${title}

The whole story is ${totalWords} words. Aim for about ${targetWords} words per part. Each sentence below is prefixed with its cumulative word count in [ ].

Sentences:
${numbered}

Choose exactly ${partCount - 1} cut points. A cut point N means a part ENDS after sentence N, and the next part begins at sentence N+1.

Priorities, in order:
1. END EVERY PART ON A CLIFFHANGER. The final sentence of a part is the retention hook — it should leave a question open, introduce a threat, escalate the stakes, tease a reveal, or land right before an "Edit/Update". Never end a part mid-thought or on a throwaway line.
2. Keep parts watchable — ideally each part between ~${minWords} and ~${maxWords} words. Balance matters, but a strong ending beats perfect balance.

Cut points must be strictly increasing integers between 1 and ${sentences.length - 1}, and there must be exactly ${partCount - 1} of them.

OUTPUT JSON ONLY: { "cutAfter": [${Array.from({ length: partCount - 1 }, () => "number").join(", ")}] }`;

  try {
    const { text } = await generateText({ model: openrouter(llm), prompt });
    const parsed = extractJson<{ cutAfter: number[] }>(text);
    const valid = normalizeCuts(parsed.cutAfter, sentences.length, partCount);
    if (valid.length !== partCount - 1) return fallback;
    // Trust the model's cliffhangers, but rescue any part it ended on a flat line.
    return normalizeCuts(
      refineCutsForCliffhangers(sentences, valid, 1.5),
      sentences.length,
      partCount
    );
  } catch {
    return fallback;
  }
}

function buildVerbatimParts(
  post: RedditPost,
  subreddit: string,
  sentences: string[],
  cuts: number[]
): StoryPartDraft[] {
  const ranges = [0, ...cuts, sentences.length];
  const partCount = ranges.length - 1;
  return Array.from({ length: partCount }, (_, i) => ({
    title: titleWithPart(post.title, i + 1),
    body: sentences.slice(ranges[i], ranges[i + 1]).join(" "),
    source: "verbatim",
    partNumber: i + 1,
    partCount,
    subreddit,
    author: post.author,
    upvotes: post.ups,
    comments: post.comments,
    ageHours: post.ageHours,
    seedTitle: post.title,
    seedUrl: post.url,
  }));
}

// ---- public API ----

/**
 * Generate ONE story draft via the chosen sourcing mode.
 *  llm      — original from a theme angle
 *  hybrid   — real reddit post as inspiration, rewritten original
 *  verbatim — real reddit post, trimmed, near word-for-word
 */
export async function generateStory(
  mode: StorySource = "llm",
  opts: { themeId?: string; genre?: string; tier?: Tier; onLlmUsage?: LlmUsageCallback } = {}
): Promise<StoryDraft & { source: StorySource }> {
  const tier = opts.tier ?? "value";
  const onLlmUsage = opts.onLlmUsage;
  const theme = opts.themeId ? THEMES.find((t) => t.id === opts.themeId)! : undefined;
  const genre = theme ? themeToGenre(theme) : pickGenre(opts.genre);

  if (mode === "llm") {
    const s = await llmStory(genre.angle, tier, genre.id, undefined, onLlmUsage);
    return { ...s, source: "llm", theme: theme?.id, genre: genre.id, subreddit: genre.subreddits[0] };
  }

  // hybrid / verbatim need a real post
  const post = await pickRedditPost(genre);

  if (mode === "verbatim") {
    const threadedPost = await resolveRedditStoryThread(post);
    return {
      title: threadedPost.title,
      body: trimBody(threadedPost.body),
      source: "verbatim",
      theme: theme?.id,
      genre: genre.id,
      subreddit: threadedPost.subreddit,
      author: threadedPost.author,
      upvotes: threadedPost.ups,
      comments: threadedPost.comments,
      ageHours: threadedPost.ageHours,
      seedTitle: post.title,
      seedUrl: post.url,
    };
  }

  // hybrid
  const s = await llmStory(genre.angle, tier, genre.id, post, onLlmUsage);
  return {
    ...s,
    source: "hybrid",
    theme: theme?.id,
    genre: genre.id,
    subreddit: post.subreddit,
    author: post.author,
    upvotes: post.ups,
    comments: post.comments,
    ageHours: post.ageHours,
    seedTitle: post.title,
    seedUrl: post.url,
  };
}

/**
 * Generate a multi-reel Reddit story. For verbatim, the parts are original
 * Reddit text only; the LLM may choose cut points but never writes continuation.
 */
export async function generateStorySeries(
  mode: StorySource = "llm",
  opts: {
    topic?: string;
    themeId?: string;
    genre?: string;
    tier?: Tier;
    parts?: number | "auto";
    selectedStoryId?: string;
    selectedSeedUrl?: string;
    excludeReelIds?: string[];
  } = {}
): Promise<StoryPartDraft[]> {
  const tier = opts.tier ?? "value";
  const theme = opts.themeId ? THEMES.find((t) => t.id === opts.themeId)! : undefined;
  const genre = theme ? themeToGenre(theme) : pickGenre(opts.genre);
  const requestedParts = opts.parts;

  if (mode === "llm") {
    const partCount = typeof requestedParts === "number" ? resolvePartCount(requestedParts, 300) : 2;
    const angle = opts.topic?.trim() ? opts.topic.trim() : genre.angle;
    const parts = await llmStorySeries(angle, tier, partCount, genre.id);
    return parts.map((part, i) => ({
      ...part,
      title: titleWithPart(part.title, i + 1),
      source: "llm",
      theme: theme?.id,
      genre: genre.id,
      subreddit: genre.subreddits[0],
      partNumber: i + 1,
      partCount,
    }));
  }

  const post = await resolvePostForSeries(genre, {
    selectedSeedUrl: opts.selectedSeedUrl,
    selectedStoryId: opts.selectedStoryId,
    excludeReelIds: opts.excludeReelIds,
  });

  if (mode === "hybrid") {
    // "auto" adapts to the richness of the seed thread (longer source → more
    // episodes) instead of always defaulting to 2. Floor at 2: hybrid rewrites
    // can expand a short seed, and a "series" should stay multi-part. Explicit
    // 2-4 pass through unchanged.
    const seedWords = wordCount(cleanRedditBody(post.body));
    const partCount = Math.max(2, resolvePartCount(requestedParts, seedWords));
    const parts = await llmStorySeries(genre.angle, tier, partCount, genre.id, post);
    return parts.map((part, i) => ({
      ...part,
      title: titleWithPart(part.title, i + 1),
      source: "hybrid",
      theme: theme?.id,
      genre: genre.id,
      subreddit: post.subreddit,
      author: post.author,
      upvotes: post.ups,
      comments: post.comments,
      ageHours: post.ageHours,
      seedTitle: post.title,
      seedUrl: post.url,
      partNumber: i + 1,
      partCount,
    }));
  }

  const threadedPost = await resolveRedditStoryThread(post);
  const body = cleanRedditBody(threadedPost.body);
  const words = wordCount(body);
  const partCount = resolvePartCount(requestedParts, words);
  // An explicit "1 (no split)" keeps the WHOLE story untruncated; auto-collapse
  // (a naturally short story) still trims to a narratable length.
  const keepFullBody = requestedParts === 1;
  const singleBody = keepFullBody ? body : trimBody(body);
  if (partCount === 1) {
    return [
      {
        title: threadedPost.title,
        body: singleBody,
        source: "verbatim",
        theme: theme?.id,
        genre: genre.id,
        subreddit: threadedPost.subreddit,
        author: threadedPost.author,
        upvotes: threadedPost.ups,
        comments: threadedPost.comments,
        ageHours: threadedPost.ageHours,
        seedTitle: post.title,
        seedUrl: post.url,
        partNumber: 1,
        partCount: 1,
      },
    ];
  }

  const sentences = splitSentences(body);
  const resolvedPartCount = Math.min(partCount, Math.max(sentences.length, 1));
  if (resolvedPartCount === 1) {
    return [
      {
        title: threadedPost.title,
        body: singleBody,
        source: "verbatim",
        theme: theme?.id,
        genre: genre.id,
        subreddit: threadedPost.subreddit,
        author: threadedPost.author,
        upvotes: threadedPost.ups,
        comments: threadedPost.comments,
        ageHours: threadedPost.ageHours,
        seedTitle: post.title,
        seedUrl: post.url,
        partNumber: 1,
        partCount: 1,
      },
    ];
  }

  const cuts = await selectVerbatimCuts(threadedPost.title, sentences, resolvedPartCount, tier);
  return buildVerbatimParts(threadedPost, threadedPost.subreddit, sentences, cuts).map((part) => ({
    ...part,
    theme: theme?.id,
    genre: genre.id,
    seedTitle: post.title,
    seedUrl: post.url,
  }));
}

/** Generate + dedupe + save up to `count` fresh stories into the bank. */
export async function topUpStoryBank(
  count = 10,
  mode: StorySource = "llm",
  tier: Tier = "value"
): Promise<number> {
  let saved = 0;
  let attempts = 0;
  const maxAttempts = count * 4;
  while (saved < count && attempts < maxAttempts) {
    attempts++;
    try {
      const draft = await generateStory(mode, { tier });
      if (await isDuplicate(draft.title, draft.seedUrl)) continue;
      await Story.create({ ...draft, premiseKey: premiseKey(draft.title), used: false });
      saved++;
      console.log(`📚 Story banked [${mode}]: "${draft.title}"`);
    } catch (e: unknown) {
      console.warn(`  story gen failed: ${getErrorMessage(e)}`);
      if (mode !== "llm") break; // reddit misconfig → stop early
    }
  }
  console.log(`✅ Banked ${saved}/${count} stories (${mode}).`);
  return saved;
}

/**
 * Take the next unused story from the bank (marks it used). If the bank is
 * empty, generates one on the fly in the given mode.
 */
export async function takeNextStory(
  mode: StorySource = "llm",
  tier: Tier = "value",
  onLlmUsage?: LlmUsageCallback,
  opts: { genre?: string; source?: StorySource } = {}
): Promise<StoryDraft & { source: StorySource; storyId?: string }> {
  const filter: Record<string, unknown> = { used: false };
  if (opts.genre) filter.genre = opts.genre;
  if (opts.source) filter.source = opts.source;
  const candidates = await Story.find(filter).sort({ createdAt: 1 }).limit(25);
  let doc: IStory | null = null;
  for (const candidate of candidates) {
    if (await isSeedUrlUsedByLiveReel(candidate.seedUrl)) continue;
    doc = await Story.findOneAndUpdate(
      { _id: candidate._id, used: false },
      { used: true, usedAt: new Date() },
      { new: true }
    );
    if (doc) break;
  }
  if (doc) {
    return {
      title: doc.title,
      body: doc.body,
      source: doc.source,
      subreddit: doc.subreddit,
      author: doc.author,
      upvotes: doc.upvotes,
      comments: doc.comments,
      ageHours: doc.ageHours,
      seedTitle: doc.seedTitle,
      seedUrl: doc.seedUrl,
      storyId: doc._id.toString(),
    };
  }
  // bank empty → generate now
  const draft = await generateStory(mode, { genre: opts.genre, tier, onLlmUsage });
  const created = await Story.create({
    ...draft,
    premiseKey: premiseKey(draft.title),
    used: true,
    usedAt: new Date(),
  });
  return { ...draft, storyId: created._id.toString() };
}

export async function markStoryReel(storyId: string | undefined, reelId: string): Promise<void> {
  if (!storyId) return;
  await Story.findByIdAndUpdate(storyId, { reelId });
}

/** Bank stats for monitoring the farm. */
export async function storyBankStats(): Promise<{ ready: number; used: number }> {
  const [ready, used] = await Promise.all([
    Story.countDocuments({ used: false }),
    Story.countDocuments({ used: true }),
  ]);
  return { ready, used };
}

export interface RedditCandidate {
  title: string;
  seedTitle: string;
  seedUrl: string;
  body: string;
  subreddit: string;
  author: string;
  upvotes: number;
  comments: number;
  ageHours: number;
  excerpt: string;
  score: number;
  wordCount: number;
  estimatedParts?: number;
  unavailable?: boolean;
  unavailableReason?: string;
}

/** Live Reddit posts scored for browse/select — includes unavailable seeds with reasons. */
export async function listRedditCandidates(
  genreId: string | undefined,
  source: StorySource,
  opts: {
    limit?: number;
    excludeUrls?: string[];
    parts?: number | "auto";
  } = {}
): Promise<{ items: RedditCandidate[]; hasMore: boolean }> {
  if (source === "llm") {
    return { items: [], hasMore: false };
  }
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  const exclude = new Set((opts.excludeUrls ?? []).map(normalizeRedditUrl));
  const genre = pickGenre(genreId);
  const posts = await fetchGenrePosts(genre, 35);
  const fresh: RedditCandidate[] = [];

  for (const post of posts) {
    if (exclude.has(normalizeRedditUrl(post.url))) continue;
    const unavailableReason = await storyUnavailableReason(post.title, post.url);
    const words = wordCount(post.body);
    fresh.push({
      title: post.title,
      seedTitle: post.title,
      seedUrl: post.url,
      body: post.body,
      subreddit: post.subreddit,
      author: post.author,
      upvotes: post.ups,
      comments: post.comments,
      ageHours: post.ageHours,
      excerpt: post.body.slice(0, 280),
      score: scorePost(post, genre),
      wordCount: words,
      estimatedParts: estimatePartsForWords(opts.parts, words),
      unavailable: Boolean(unavailableReason),
      unavailableReason,
    });
    if (fresh.length >= limit + 1) break;
  }

  const hasMore = fresh.length > limit;
  return { items: fresh.slice(0, limit), hasMore };
}

export interface StoryBankBrowseItem {
  id: string;
  title: string;
  body: string;
  source: StorySource;
  genre?: string;
  subreddit?: string;
  author?: string;
  upvotes?: number;
  comments?: number;
  ageHours?: number;
  seedTitle?: string;
  seedUrl?: string;
  createdAt: Date;
  estimatedParts?: number;
  unavailable?: boolean;
  unavailableReason?: string;
}

/** Unused banked stories — includes entries blocked by live-reel seeds as unavailable. */
export async function listStoryBank(
  opts: {
    genre?: string;
    source?: StorySource;
    limit?: number;
    offset?: number;
    sort?: "newest" | "oldest";
    parts?: number | "auto";
  } = {}
): Promise<{ items: StoryBankBrowseItem[]; total: number; hasMore: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const filter: Record<string, unknown> = { used: false };
  if (opts.genre) filter.genre = opts.genre;
  if (opts.source) filter.source = opts.source;

  const sortDir = opts.sort === "oldest" ? 1 : -1;
  const docs = await Story.find(filter).sort({ createdAt: sortDir }).skip(offset).limit(limit + 25);
  const items: StoryBankBrowseItem[] = [];

  for (const doc of docs) {
    const onLiveReel = await isSeedUrlUsedByLiveReel(doc.seedUrl);
    const words = wordCount(doc.body);
    items.push({
      id: doc._id.toString(),
      title: doc.title,
      body: doc.body,
      source: doc.source,
      genre: doc.genre,
      subreddit: doc.subreddit,
      author: doc.author,
      upvotes: doc.upvotes,
      comments: doc.comments,
      ageHours: doc.ageHours,
      seedTitle: doc.seedTitle,
      seedUrl: doc.seedUrl,
      createdAt: doc.createdAt,
      unavailable: onLiveReel,
      unavailableReason: onLiveReel ? "Seed already on another reel" : undefined,
      estimatedParts: estimatePartsForWords(opts.parts, words),
    });
    if (items.length >= limit + 1) break;
  }

  const hasMore = items.length > limit || docs.length > limit;
  const total = await Story.countDocuments(filter);
  return { items: items.slice(0, limit), total, hasMore };
}

/** Atomically reserve one unused bank story (re-checks live-reel seed guard). */
export async function loadAndReserveBankStory(
  storyId: string
): Promise<StoryDraft & { source: StorySource; storyId: string }> {
  const doc = await Story.findOneAndUpdate(
    { _id: storyId, used: false },
    { used: true, usedAt: new Date() },
    { new: true }
  );
  if (!doc) throw new Error("Story not found or already used");
  try {
    await assertStoryAvailable(doc.title, doc.seedUrl, { excludeStoryId: doc._id.toString() });
  } catch (error: unknown) {
    await Story.findByIdAndUpdate(doc._id, { used: false, $unset: { usedAt: "" } });
    throw error;
  }
  return {
    title: doc.title,
    body: doc.body,
    source: doc.source,
    genre: doc.genre,
    subreddit: doc.subreddit,
    author: doc.author,
    upvotes: doc.upvotes,
    comments: doc.comments,
    ageHours: doc.ageHours,
    seedTitle: doc.seedTitle,
    seedUrl: doc.seedUrl,
    storyId: doc._id.toString(),
  };
}

/**
 * Materialize a story from a Reddit permalink.
 * `seedOnly` (hybrid) returns metadata without LLM rewrite — defer to plan time.
 */
export async function materializeFromSeed(
  seedUrl: string,
  source: StorySource,
  genre?: string,
  tier: Tier = "value",
  opts: { seedOnly?: boolean; onLlmUsage?: LlmUsageCallback; excludeReelId?: string } = {}
): Promise<StoryDraft & { source: StorySource }> {
  if (source === "llm") {
    throw new Error("Cannot materialize a Reddit seed with llm source");
  }

  let post = await fetchPostByUrl(seedUrl);
  const resolvedGenre = pickGenre(genre);
  if (!post) {
    const posts = await fetchGenrePosts(resolvedGenre, 50);
    const target = normalizeRedditUrl(seedUrl);
    post = posts.find((p) => normalizeRedditUrl(p.url) === target) ?? null;
  }
  if (!post) throw new Error(`Could not load Reddit post: ${seedUrl}`);

  if (opts.seedOnly && source === "hybrid") {
    await assertStoryAvailable(post.title, post.url, { excludeReelId: opts.excludeReelId });
    return {
      title: post.title,
      body: "",
      source: "hybrid",
      genre: resolvedGenre.id,
      subreddit: post.subreddit,
      author: post.author,
      upvotes: post.ups,
      comments: post.comments,
      ageHours: post.ageHours,
      seedTitle: post.title,
      seedUrl: post.url,
    };
  }

  await assertStoryAvailable(post.title, post.url, { excludeReelId: opts.excludeReelId });

  if (source === "verbatim") {
    const threadedPost = await resolveRedditStoryThread(post);
    return {
      title: threadedPost.title,
      body: trimBody(threadedPost.body),
      source: "verbatim",
      genre: resolvedGenre.id,
      subreddit: threadedPost.subreddit,
      author: threadedPost.author,
      upvotes: threadedPost.ups,
      comments: threadedPost.comments,
      ageHours: threadedPost.ageHours,
      seedTitle: post.title,
      seedUrl: post.url,
    };
  }

  const threadedPost = await resolveRedditStoryThread(post).catch(() => post);
  const rewritten = await llmStory(resolvedGenre.angle, tier, resolvedGenre.id, threadedPost, opts.onLlmUsage);
  return {
    ...rewritten,
    source: "hybrid",
    genre: resolvedGenre.id,
    subreddit: post.subreddit,
    author: post.author,
    upvotes: post.ups,
    comments: post.comments,
    ageHours: post.ageHours,
    seedTitle: post.title,
    seedUrl: post.url,
  };
}
