import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import { config } from "../config";
import { resolveModels, type Tier } from "../config/models";
import { Story, type StorySource } from "../models/story.model";
import { getErrorMessage } from "../types";
import { getTrendDigest } from "./trend-insight.service";

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
  title: string;
  body: string;
  url: string;
  subreddit: string;
  author: string;
  ups: number;
  comments: number;
  ageHours: number;
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
  if (!res.ok) throw new Error(`Reddit fetch ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as {
    data: {
      children: {
        data: {
          title: string;
          selftext: string;
          permalink: string;
          author: string;
          ups: number;
          num_comments: number;
          created_utc: number;
        };
      }[];
    };
  };
  return j.data.children
    .map((c) => ({
      title: c.data.title,
      body: cleanRedditBody(c.data.selftext),
      url: `https://reddit.com${c.data.permalink}`,
      subreddit,
      author: c.data.author,
      ups: c.data.ups,
      comments: c.data.num_comments,
      ageHours: Math.max(1, Math.round((Date.now() / 1000 - c.data.created_utc) / 3600)),
    }))
    .filter((p) => {
      const body = p.body.trim().toLowerCase();
      return (
        p.body.length > 200 &&
        p.body.length < 12_000 &&
        body !== "[removed]" &&
        body !== "[deleted]" &&
        wordCount(p.body) >= 60
      );
    });
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

async function isDuplicate(title: string, seedUrl?: string): Promise<boolean> {
  if (seedUrl && (await Story.exists({ seedUrl }))) return true;
  return !!(await Story.exists({ premiseKey: premiseKey(title) }));
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

async function pickRedditPost(genre: RedditGenre): Promise<RedditPost> {
  const posts = await fetchGenrePosts(genre);
  if (!posts.length) throw new Error(`No usable posts for reddit genre ${genre.id}`);

  for (const post of posts) {
    if (!(await Story.exists({ seedUrl: post.url }))) return post;
  }
  return posts[0];
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
  seed?: RedditPost
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

  const { text } = await generateText({ model: openrouter(llm), prompt });
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
  const prompt = `You write serialized Reddit-style short-form stories read aloud over gameplay footage.

FLAVOUR: ${angle}${seedBlock}${trendBlock}

Create exactly ${partCount} parts of one continuous story.

RULES:
- Each part title is a curiosity-gap Reddit hook and must end with "Part N".
- Each part body is first person, conversational, 90-150 words, 5-9 punchy sentences.
- Part 1 sets up the conflict and ends on a strong cliffhanger.
- Middle parts escalate and end on unanswered consequences.
- Final part gives the reveal/payoff.
- Read naturally aloud: spell out numbers, no markdown, no headings, no emojis, no "edit:"/"update:".
- Must be ORIGINAL — invented people and details.

OUTPUT JSON ONLY:
{ "parts": [
  { "title": "... Part 1", "body": "..." },
  { "title": "... Part 2", "body": "..." }
] }`;

  const { text } = await generateText({ model: openrouter(llm), prompt });
  const parsed = extractJson<{ parts: StoryDraft[] }>(text);
  if (!Array.isArray(parsed.parts) || parsed.parts.length !== partCount) {
    throw new Error("LLM series missing expected parts");
  }
  for (const part of parsed.parts) {
    if (!part.title || !part.body) throw new Error("LLM series part missing title/body");
  }
  return parsed.parts;
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
  if (typeof requested === "number") return Math.min(Math.max(Math.round(requested), 2), 4);
  if (words < 220) return 1;
  return Math.min(Math.max(Math.ceil(words / 145), 2), 4);
}

function titleWithPart(title: string, partNumber: number): string {
  const stripped = title.replace(/\s+part\s+\d+\s*$/i, "").trim();
  return `${stripped} Part ${partNumber}`;
}

function candidateCutAfter(sentences: string[], partCount: number): number[] {
  const totalWords = sentences.reduce((sum, s) => sum + wordCount(s), 0);
  const target = totalWords / partCount;
  const candidates: number[] = [];
  let runningWords = 0;

  for (let i = 0; i < sentences.length - 1; i++) {
    runningWords += wordCount(sentences[i]);
    const next = sentences[i + 1]?.toLowerCase() ?? "";
    const current = sentences[i].toLowerCase();
    const structural =
      /^(edit|update|final update|tl;dr|tldr)\b/i.test(next) ||
      /\b(update|edit|more later|i'll update|i will update)\b/i.test(current);
    const nearTarget = Math.abs(runningWords / target - Math.round(runningWords / target)) < 0.25;
    if (structural || nearTarget) candidates.push(i + 1);
  }

  return [...new Set(candidates)];
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
  const candidates = candidateCutAfter(sentences, partCount);
  const fallback = normalizeCuts(fallbackCutAfter(sentences, partCount), sentences.length, partCount);
  if (sentences.length < partCount * 3 || candidates.length < partCount - 1) return fallback;

  const llm = resolveModels(tier).llm;
  const numbered = sentences.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const prompt = `Choose cut points for a verbatim Reddit story series.

Title: ${title}

Sentences:
${numbered}

Pick exactly ${partCount - 1} cut points from these candidate sentence numbers:
${candidates.join(", ")}

Rules:
- A cut point means the part ends AFTER that sentence number.
- Prefer update/edit boundaries, cliffhangers, escalation, and unanswered consequences.
- Keep parts reasonably balanced for short videos.
- Do not rewrite text.

OUTPUT JSON ONLY: { "cutAfter": [number, number] }`;

  try {
    const { text } = await generateText({ model: openrouter(llm), prompt });
    const parsed = extractJson<{ cutAfter: number[] }>(text);
    const valid = normalizeCuts(
      parsed.cutAfter.filter((n) => candidates.includes(Math.round(n))),
      sentences.length,
      partCount
    );
    return valid.length === partCount - 1 ? valid : fallback;
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
  opts: { themeId?: string; genre?: string; tier?: Tier } = {}
): Promise<StoryDraft & { source: StorySource }> {
  const tier = opts.tier ?? "value";
  const theme = opts.themeId ? THEMES.find((t) => t.id === opts.themeId)! : undefined;
  const genre = theme ? themeToGenre(theme) : pickGenre(opts.genre);

  if (mode === "llm") {
    const s = await llmStory(genre.angle, tier, genre.id);
    return { ...s, source: "llm", theme: theme?.id, genre: genre.id, subreddit: genre.subreddits[0] };
  }

  // hybrid / verbatim need a real post
  const post = await pickRedditPost(genre);

  if (mode === "verbatim") {
    return {
      title: post.title,
      body: trimBody(post.body),
      source: "verbatim",
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

  // hybrid
  const s = await llmStory(genre.angle, tier, genre.id, post);
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
  opts: { topic?: string; themeId?: string; genre?: string; tier?: Tier; parts?: number | "auto" } = {}
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

  const post = await pickRedditPost(genre);

  if (mode === "hybrid") {
    const partCount = typeof requestedParts === "number" ? resolvePartCount(requestedParts, 300) : 2;
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

  const body = cleanRedditBody(post.body);
  const words = wordCount(body);
  const partCount = resolvePartCount(requestedParts, words);
  if (partCount === 1) {
    return [
      {
        title: post.title,
        body: trimBody(body),
        source: "verbatim",
        theme: theme?.id,
        genre: genre.id,
        subreddit: post.subreddit,
        author: post.author,
        upvotes: post.ups,
        comments: post.comments,
        ageHours: post.ageHours,
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
        title: post.title,
        body: trimBody(body),
        source: "verbatim",
        theme: theme?.id,
        genre: genre.id,
        subreddit: post.subreddit,
        author: post.author,
        upvotes: post.ups,
        comments: post.comments,
        ageHours: post.ageHours,
        seedTitle: post.title,
        seedUrl: post.url,
        partNumber: 1,
        partCount: 1,
      },
    ];
  }

  const cuts = await selectVerbatimCuts(post.title, sentences, resolvedPartCount, tier);
  return buildVerbatimParts(post, post.subreddit, sentences, cuts).map((part) => ({
    ...part,
    theme: theme?.id,
    genre: genre.id,
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
  tier: Tier = "value"
): Promise<StoryDraft & { source: StorySource; storyId?: string }> {
  const doc = await Story.findOneAndUpdate(
    { used: false },
    { used: true, usedAt: new Date() },
    { sort: { createdAt: 1 }, new: true }
  );
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
  const draft = await generateStory(mode, { tier });
  const created = await Story.create({
    ...draft,
    premiseKey: premiseKey(draft.title),
    used: true,
    usedAt: new Date(),
  });
  return { ...draft, storyId: created._id.toString() };
}

/** Bank stats for monitoring the farm. */
export async function storyBankStats(): Promise<{ ready: number; used: number }> {
  const [ready, used] = await Promise.all([
    Story.countDocuments({ used: false }),
    Story.countDocuments({ used: true }),
  ]);
  return { ready, used };
}
