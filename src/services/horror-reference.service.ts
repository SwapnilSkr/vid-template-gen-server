import { createHash } from "node:crypto";
import { Types } from "mongoose";
import {
  HorrorReference,
  Reel,
  type IHorrorReference,
  type HorrorReferenceStatus,
} from "../models";
import { getErrorMessage } from "../types";

interface GutendexBook {
  id: number;
  title: string;
  authors?: { name?: string }[];
  subjects?: string[];
  languages?: string[];
  download_count?: number;
  formats?: Record<string, string>;
}

interface GutendexResponse {
  results?: GutendexBook[];
  next?: string | null;
}

export interface HorrorReferenceScoutResult {
  scanned: number;
  upserted: number;
  skipped: number;
  skippedExisting: number;
  skippedUsed: number;
  errors: { sourceUrl: string; error: string }[];
}

export interface HorrorReferenceScoutOptions {
  limit?: number;
  refreshExisting?: boolean;
  includeUsed?: boolean;
}

export interface ListHorrorReferencesInput {
  status?: HorrorReferenceStatus;
  genre?: string;
  limit?: number;
}

export interface HorrorReferencePromptSeed {
  id: string;
  title: string;
  author?: string;
  sourceUrl: string;
  license: "public_domain" | "unknown";
  promptBrief: string;
  excerpt: string;
}

const GUTENDEX_HORROR_URL =
  "https://gutendex.com/books/?topic=horror&languages=en&mime_type=text%2Fplain";
const GUTENDEX_REFERENCE_URLS = [
  GUTENDEX_HORROR_URL,
  "https://gutendex.com/books/?topic=ghost&languages=en&mime_type=text%2Fplain",
  "https://gutendex.com/books/?topic=supernatural&languages=en&mime_type=text%2Fplain",
  "https://gutendex.com/books/?topic=gothic&languages=en&mime_type=text%2Fplain",
  "https://gutendex.com/books/?topic=occult&languages=en&mime_type=text%2Fplain",
];

function cleanText(text: string): string {
  return text
    .replace(/\r/g, "\n")
    .replace(/\*\*\* START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[\s\S]*?\*\*\*/i, "")
    .replace(/\*\*\* END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[\s\S]*/i, "")
    .replace(/Produced by[\s\S]{0,700}?\n\n/i, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function excerptForPrompt(text: string): string {
  const cleaned = cleanText(text);
  const storyStart = [
    /\bCHAPTER\s+(?:I|1|ONE)\b/i,
    /\bI\.\s+[A-Z][A-Za-z' -]{3,}/,
    /\bTHE\s+[A-Z][A-Z' -]{4,}\b/,
  ]
    .map((pattern) => cleaned.search(pattern))
    .filter((index) => index > 0)
    .sort((a, b) => a - b)[0];
  const body = storyStart ? cleaned.slice(storyStart) : cleaned;
  const paragraphs = cleaned
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 80 && !/^(chapter|contents|preface)\b/i.test(p));
  const excerpt = paragraphs.slice(0, 8).join("\n\n");
  if (excerpt.length >= 500) return excerpt.slice(0, 4200);
  return body.replace(/\s+/g, " ").trim().slice(0, 4200);
}

function textUrl(book: GutendexBook): string | undefined {
  const formats = book.formats ?? {};
  return (
    formats["text/plain; charset=utf-8"] ??
    formats["text/plain; charset=us-ascii"] ??
    formats["text/plain"] ??
    Object.entries(formats).find(([mime]) => mime.startsWith("text/plain"))?.[1]
  );
}

function genreTagsFor(book: GutendexBook): string[] {
  const haystack = `${book.title} ${(book.subjects ?? []).join(" ")}`.toLowerCase();
  const tags = new Set<string>(["classic_horror"]);
  if (/ghost|apparition|spirit|spectre|haunt/.test(haystack)) tags.add("ghost");
  if (/vampire|dracula/.test(haystack)) tags.add("vampire");
  if (/weird|supernatural|occult|strange/.test(haystack)) tags.add("weird");
  if (/mystery|detective|murder/.test(haystack)) tags.add("mystery");
  if (/psychological|madness|insanity|dream/.test(haystack)) tags.add("psychological");
  if (/gothic|castle|monk|abbey/.test(haystack)) tags.add("gothic");
  return [...tags];
}

function scoreReference(book: GutendexBook, excerpt: string): number {
  const subjects = (book.subjects ?? []).join(" ").toLowerCase();
  const horrorSubject = /horror|ghost|supernatural|occult|gothic|weird/.test(subjects) ? 30 : 0;
  const excerptFit = excerpt.length > 1200 ? 20 : excerpt.length > 500 ? 10 : 0;
  const downloads = Math.min(Math.log10((book.download_count ?? 0) + 10) * 8, 32);
  const shortTitle = book.title.length < 90 ? 8 : 0;
  return Math.round(horrorSubject + excerptFit + downloads + shortTitle);
}

function promptBrief(book: GutendexBook, excerpt: string): string {
  const author = book.authors?.[0]?.name;
  const subjects = (book.subjects ?? []).slice(0, 5).join("; ");
  return [
    `Public-domain horror reference: "${book.title}"${author ? ` by ${author}` : ""}.`,
    subjects ? `Subjects: ${subjects}.` : "",
    "Use this for atmosphere, escalation shape, sensory texture, and dread mechanics only.",
    "Do not copy plot events, character names, setting, or phrasing. Create a modern original short-form story.",
    `Reference excerpt:\n${excerpt.slice(0, 2200)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "vid-template-gen horror-reference-scout" },
  });
  if (!res.ok) throw new Error(`Fetch ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { Accept: "text/plain", "User-Agent": "vid-template-gen horror-reference-scout" },
  });
  if (!res.ok) throw new Error(`Text fetch ${res.status}: ${await res.text()}`);
  return res.text();
}

export async function scoutHorrorReferences(
  input: number | HorrorReferenceScoutOptions = 20
): Promise<HorrorReferenceScoutResult> {
  const options = typeof input === "number" ? { limit: input } : input;
  const limit = options.limit ?? 20;
  const result: HorrorReferenceScoutResult = {
    scanned: 0,
    upserted: 0,
    skipped: 0,
    skippedExisting: 0,
    skippedUsed: 0,
    errors: [],
  };
  const usedUrls = options.includeUsed ? new Set<string>() : await usedReferenceUrls();
  const seenExternalIds = new Set<string>();

  for (const startUrl of GUTENDEX_REFERENCE_URLS) {
    let next: string | null | undefined = startUrl;
    while (next && result.scanned < limit) {
    const page: GutendexResponse = await fetchJson<GutendexResponse>(next);
    next = page.next;
    for (const book of page.results ?? []) {
      if (result.scanned >= limit) break;
      const sourceUrl = `https://www.gutenberg.org/ebooks/${book.id}`;
      const externalId = `gutenberg:${book.id}`;
      try {
        if (seenExternalIds.has(externalId)) {
          result.skippedExisting++;
          continue;
        }
        seenExternalIds.add(externalId);
        if (usedUrls.has(sourceUrl)) {
          result.skippedUsed++;
          continue;
        }
        const exists = await HorrorReference.exists({ externalId });
        if (exists && !options.refreshExisting) {
          result.skippedExisting++;
          continue;
        }
        result.scanned++;
        const url = textUrl(book);
        if (!url || !book.languages?.includes("en")) {
          result.skipped++;
          continue;
        }
        const excerpt = excerptForPrompt(await fetchText(url));
        if (excerpt.length < 500) {
          result.skipped++;
          continue;
        }
        const update = {
          source: "project_gutenberg" as const,
          sourceUrl,
          externalId,
          title: book.title,
          author: book.authors?.[0]?.name,
          language: book.languages?.[0],
          license: "public_domain" as const,
          status: "candidate" as const,
          subjects: book.subjects ?? [],
          genreTags: genreTagsFor(book),
          downloads: book.download_count,
          textUrl: url,
          excerpt,
          promptBrief: promptBrief(book, excerpt),
          sourceTextHash: textHash(excerpt),
          sourceTextChars: excerpt.length,
          qualityScore: scoreReference(book, excerpt),
          lastScrapedAt: new Date(),
        };
        await HorrorReference.findOneAndUpdate(
          { externalId: update.externalId },
          { $set: update, $setOnInsert: { usedInReelIds: [] } },
          { upsert: true, new: true }
        );
        result.upserted++;
      } catch (error: unknown) {
        result.errors.push({ sourceUrl, error: getErrorMessage(error) });
      }
    }
  }
  }

  return result;
}

export async function listHorrorReferences(
  input: ListHorrorReferencesInput = {}
): Promise<IHorrorReference[]> {
  const filter: Record<string, unknown> = {};
  if (input.status) filter.status = input.status;
  if (input.genre) filter.genreTags = input.genre;
  const used = await usedReferenceUrls();
  if (used.size) filter.sourceUrl = { $nin: [...used] };
  return HorrorReference.find(filter)
    .sort({ qualityScore: -1, downloads: -1, updatedAt: -1 })
    .limit(Math.min(input.limit ?? 50, 100));
}

async function usedReferenceUrls(): Promise<Set<string>> {
  const reels = await Reel.find(
    { "horrorReference.sourceUrl": { $exists: true, $ne: "" } },
    { "horrorReference.sourceUrl": 1 }
  ).lean();
  return new Set(
    reels
      .map((reel) => reel.horrorReference?.sourceUrl)
      .filter((url): url is string => Boolean(url))
  );
}

export async function pickHorrorReferenceSeed(
  genre?: string,
  referenceId?: string
): Promise<HorrorReferencePromptSeed | undefined> {
  // Explicit pick from the Studio/create form — use it directly, bypassing the
  // "unused" rotation (the user deliberately chose this reference).
  if (referenceId && Types.ObjectId.isValid(referenceId)) {
    const picked = await HorrorReference.findById(referenceId);
    if (picked) return toReferenceSeed(picked);
  }

  const used = await usedReferenceUrls();
  const filter: Record<string, unknown> = {
    status: { $in: ["candidate", "approved"] },
    license: "public_domain",
  };
  if (genre) filter.genreTags = { $in: [genre, "classic_horror"] };

  const refs = await HorrorReference.find(filter)
    .sort({ qualityScore: -1, downloads: -1, updatedAt: -1 })
    .limit(25);
  const ref = refs.find((candidate) => !used.has(candidate.sourceUrl));
  if (!ref) return undefined;
  return toReferenceSeed(ref);
}

function toReferenceSeed(ref: IHorrorReference): HorrorReferencePromptSeed {
  return {
    id: ref._id.toString(),
    title: ref.title,
    author: ref.author,
    sourceUrl: ref.sourceUrl,
    license: ref.license,
    promptBrief: ref.promptBrief,
    excerpt: ref.excerpt,
  };
}

export async function markHorrorReferenceUsed(referenceId: string | undefined, reelId: string): Promise<void> {
  if (!referenceId || !Types.ObjectId.isValid(referenceId)) return;
  await HorrorReference.findByIdAndUpdate(referenceId, {
    $addToSet: { usedInReelIds: reelId },
  });
}
