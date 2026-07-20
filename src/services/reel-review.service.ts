import { Resvg } from "@resvg/resvg-js";
import ffmpeg from "fluent-ffmpeg";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { resolveModels } from "../config/models";
import {
  Reel,
  type IInstagramPublishSettings,
  type IInstagramPollSuggestion,
  type IFacebookPublishSettings,
  type IThreadsPublishSettings,
  type IReel,
  type IReelReviewPackage,
} from "../models";
import { getErrorMessage } from "../types";
import { recordOperationLog } from "./operation-log.service";
import { ensureDir, escapeFilterPath, applyOutputOptions, generateFilename } from "../utils";
import { generateText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateImage, type MediaUsageCallback } from "./openrouter-media.service";
import { type LlmUsageCallback, reportLlmUsage } from "./reel-script.service";
import {
  applyMeasuredCostsToReel,
  type MeasuredCostInput,
} from "./reel-cost.service";
import { deleteS3Urls, uploadImage } from "./s3.service";
import { renderRedditCard } from "./reddit-card.service";
import { pickGameplay } from "./reel-gameplay.service";
import { listTrendReferences } from "./trend-reference.service";
import { getTrendCopyGuidance, getTrendDigest } from "./trend-insight.service";
import { getOwnedAnalyticsGuidance } from "./owned-analytics.service";
import { getRecipe } from "../config/niche-styles";
import { fontFilePathByFamily, DEFAULT_BUNDLED_FONT_FAMILY } from "../config/fonts";
import { platformCopyRules } from "./platform-copy-rules.service";
import { refreshAutomaticOpeningCoverIfStale } from "./reel-shorts-cover.service";

export interface UpdateReelReviewInput {
  title?: string;
  description?: string;
  tags?: string[];
  thumbnailText?: string;
  thumbnailPrompt?: string;
  visibilityNotes?: string;
  status?: IReelReviewPackage["status"];
}

/**
 * Final review approval is the storage boundary for a reel. Keep every file
 * needed to publish the already-approved creative (the primary/destination
 * final MP4s and cover art), but remove reconstruction caches. This makes the
 * storage trade-off explicit: an approved reel can still be published, while
 * a later visual or narration re-render will need to regenerate the released
 * inputs instead of silently retaining paid assets forever.
 */
function reclaimApprovedRenderCaches(reel: IReel): string[] {
  const released = [
    reel.bodyVideoUrl,
    reel.assemblyVideoUrl,
    reel.subtitlesUrl,
    reel.titleAudioUrl,
    reel.partOutroAudioUrl,
    reel.outroAudioUrl,
    ...reel.scenes.flatMap((scene) => [scene.assetUrl, scene.audioUrl]),
    ...(reel.destinations ?? []).flatMap((destination) => [destination.outroAudioUrl]),
  ].filter((url): url is string => Boolean(url));

  reel.bodyVideoUrl = undefined;
  reel.assemblyVideoUrl = undefined;
  reel.subtitlesUrl = undefined;
  reel.titleAudioUrl = undefined;
  reel.partOutroAudioUrl = undefined;
  reel.outroAudioUrl = undefined;
  reel.outroAudioSignature = undefined;
  for (const scene of reel.scenes) {
    scene.assetUrl = undefined;
    scene.audioUrl = undefined;
  }
  for (const destination of reel.destinations ?? []) {
    destination.outroAudioUrl = undefined;
    destination.outroAudioSignature = undefined;
  }
  reel.markModified("scenes");
  reel.markModified("destinations");
  return [...new Set(released)];
}

const DEFAULT_REDDIT_TAGS = [
  "shorts",
  "redditstories",
  "aita",
  "storytime",
  "reddit",
];

const DEFAULT_HORROR_TAGS = [
  "shorts",
  "horror",
  "horrorstories",
  "scarystories",
  "creepypasta",
];

const openrouter = createOpenRouter({
  apiKey: config.openRouterApiKey,
});

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  return tags
    .map((tag) => tag.trim().replace(/^#/, "").toLowerCase())
    .filter(Boolean)
    .filter((tag) => {
      if (seen.has(tag)) return false;
      seen.add(tag);
      return true;
    })
    .slice(0, 15);
}

function reviewTagsForReel(reel: IReel): string[] {
  const nicheTags =
    reel.niche === "reddit"
      ? DEFAULT_REDDIT_TAGS
      : isHorrorNiche(reel.niche)
        ? DEFAULT_HORROR_TAGS
        : [reel.niche];
  return normalizeTags([
    reel.niche,
    reel.genre ?? "",
    reel.redditStory?.subreddit?.replace(/^r\//i, "") ?? "",
    ...nicheTags,
  ]);
}

function isHorrorNiche(niche: string): boolean {
  return niche.startsWith("horror");
}

function wrap(text: string, maxChars: number): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = (line + " " + word).trim();
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 5);
}

function buildTitle(reel: IReel): string {
  const recipe = getRecipe(reel.niche);
  const base = (reel.review?.title || reel.title || reel.hook || reel.topic || recipe.displayName).trim();
  if (reel.partNumber && reel.partCount && reel.partCount > 1) {
    return `${base} | Part ${reel.partNumber}`;
  }
  return base;
}

function storySeed(reel: IReel): string {
  if (reel.niche === "reddit" && reel.redditStory) {
    return [
      reel.redditStory.title,
      reel.redditStory.body,
      reel.partNumber && reel.partCount ? `Part ${reel.partNumber} of ${reel.partCount}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return [
    reel.title,
    reel.hook,
    reel.topic,
    ...reel.scenes.map((scene) => scene.narration).filter(Boolean),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function extractReviewJson(text: string): { title?: string; description?: string } {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return {};
  const parsed = JSON.parse(jsonMatch[0]) as unknown;
  if (!parsed || typeof parsed !== "object") return {};
  const record = parsed as Record<string, unknown>;
  return {
    title: typeof record.title === "string" ? record.title : undefined,
    description: typeof record.description === "string" ? record.description : undefined,
  };
}

function cleanTitle(title: string): string {
  return title
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

const HASHTAG_LINE_PATTERN = /^(?:\s*#[\p{L}\p{N}_]+\s*)+$/u;
const TRAILING_HASHTAGS_PATTERN = /(?:\s+#[\p{L}\p{N}_]+)+\s*$/u;

const YOUTUBE_HASHTAG_DISPLAY: Record<string, string> = {
  aita: "AITA",
  reddit: "Reddit",
  redditstories: "RedditStories",
  storytime: "Storytime",
  shorts: "Shorts",
  youtubeshorts: "YouTubeShorts",
  horror: "Horror",
  horrorstories: "HorrorStories",
  scarystories: "ScaryStories",
  creepypasta: "Creepypasta",
};

function hashtagToken(value: string): string | undefined {
  const token = value.trim().replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");
  return token || undefined;
}

/** YouTube hashtags are discoverability metadata: valid `#word` tokens on a
 * single trailing description line, never stuffed into the title. */
function formatYouTubeHashtags(tags: string[]): string[] {
  const seen = new Set<string>();
  return tags
    .map(hashtagToken)
    .filter((tag): tag is string => Boolean(tag))
    .map((tag) => tag.toLocaleLowerCase())
    .filter((tag) => {
      if (seen.has(tag)) return false;
      seen.add(tag);
      return true;
    })
    .map((tag) => `#${YOUTUBE_HASHTAG_DISPLAY[tag] ?? tag}`)
    .slice(0, 5);
}

/** Instagram tags intentionally use a distinct, lower-case convention. They
 * are appended as a final, separate line by `cleanInstagramCaption`. */
function formatInstagramHashtags(tags: string[]): string[] {
  const seen = new Set<string>();
  return tags
    .map(hashtagToken)
    .filter((tag): tag is string => Boolean(tag))
    .map((tag) => tag.toLocaleLowerCase())
    .filter((tag) => {
      if (seen.has(tag)) return false;
      seen.add(tag);
      return true;
    })
    .map((tag) => `#${tag}`);
}

function instagramTagsForReel(reel: IReel): string[] {
  const platformTags = reel.niche === "reddit"
    ? ["redditstories", "aita", "storytime", "redditdrama"]
    : isHorrorNiche(reel.niche)
      ? ["horrorstories", "scarystories", "creepypasta", "horrortok"]
      : [reel.niche, "storytime"];
  return normalizeTags([
    reel.genre ?? "",
    reel.redditStory?.subreddit?.replace(/^r\//i, "") ?? "",
    ...platformTags,
  ]).slice(0, INSTAGRAM_CAPTION_MAX_HASHTAGS);
}

function stripHashtagsFromText(value: string): string {
  const withoutBlock = value
    .trimEnd()
    .split("\n")
    .filter((line, index, lines) => {
      if (index !== lines.length - 1) return true;
      return !HASHTAG_LINE_PATTERN.test(line);
    })
    .join("\n")
    .trimEnd();
  return withoutBlock.replace(TRAILING_HASHTAGS_PATTERN, "").trim();
}

function withDescriptionHashtags(description: string, hashtags: string[]): string {
  const managed = hashtags.length ? hashtags.join(" ") : "";
  const body = stripHashtagsFromText(description);
  return managed ? `${body}${body ? "\n\n" : ""}${managed}` : body;
}

const INSTAGRAM_CAPTION_MAX_HASHTAGS = 5;
const INSTAGRAM_HASHTAG_PATTERN = /#[\p{L}\p{N}_]+/gu;

function instagramHashtagCount(caption: string): number {
  return (caption.match(INSTAGRAM_HASHTAG_PATTERN) ?? []).length;
}

function instagramFallbackCaption(reel: IReel, tags: string[]): string {
  const title = stripHashtagsFromText(buildTitle(reel)).slice(0, 220);
  const partCta =
    reel.partNumber && reel.partCount && reel.partNumber < reel.partCount
      ? `Follow for part ${reel.partNumber + 1}.`
      : "Follow for more stories.";
  const prompt = reel.niche === "reddit" ? "What would you have done?" : "Would you watch to the end?";
  return [title, prompt, partCta, formatInstagramHashtags(tags).slice(0, INSTAGRAM_CAPTION_MAX_HASHTAGS).join(" ")]
    .filter(Boolean)
    .join("\n\n");
}

function extractInstagramCaption(text: string): string | undefined {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as unknown;
      if (parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).caption === "string") {
        return (parsed as Record<string, string>).caption;
      }
      return undefined;
    } catch {
      // Fall through to a plain-text response. The final guardrail still caps tags.
    }
  }
  const plain = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/^caption\s*:\s*/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();
  return plain || undefined;
}

function trimCaptionBody(value: string, maximum: number): string {
  const compact = value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (compact.length <= maximum) return compact;
  return compact.slice(0, maximum).replace(/\s+\S*$/, "").trim();
}

/** Normalize AI output into a real Instagram caption: prose first, then one
 * final line of 3–5 lower-case tags. This does not process manual captions. */
function cleanInstagramCaption(value: string, fallback: string, tags: string[]): string {
  const generatedTags = formatInstagramHashtags(value.match(INSTAGRAM_HASHTAG_PATTERN) ?? []);
  const prohibited = new Set(["#fyp", "#viral", "#reels", "#explorepage", "#instagram", "#shorts"]);
  const selectedTags = [...new Set([
    ...generatedTags.filter((tag) => !prohibited.has(tag)),
    ...formatInstagramHashtags(tags),
  ])].slice(0, INSTAGRAM_CAPTION_MAX_HASHTAGS);
  const finalTags = selectedTags.length
    ? selectedTags
    : formatInstagramHashtags(tags).slice(0, INSTAGRAM_CAPTION_MAX_HASHTAGS);
  const maximumProseLength = Math.max(1, 700 - (finalTags.join(" ").length + 2));
  const prose = trimCaptionBody(value.replace(INSTAGRAM_HASHTAG_PATTERN, ""), maximumProseLength)
    || trimCaptionBody(fallback.replace(INSTAGRAM_HASHTAG_PATTERN, ""), maximumProseLength);
  return finalTags.length ? `${prose}\n\n${finalTags.join(" ")}`.trim() : prose;
}

export interface InstagramCaptionResult {
  caption: string;
  source: "ai" | "fallback";
  model?: string;
}

/** Generate platform-native copy from story material, not from YouTube metadata.
 * The output is normalized after the model returns so provider variation cannot
 * exceed the Instagram hashtag guardrail. */
async function buildInstagramCaption(
  reel: IReel,
  tags: string[],
  onLlmUsage?: LlmUsageCallback,
): Promise<InstagramCaptionResult> {
  const fallback = instagramFallbackCaption(reel, tags);
  const source = storySeed(reel).slice(0, 2_600);
  const model = resolveModels("cheap").llm;
  // Meta copy is informed only by its own first-party results. External
  // YouTube research must never be presented as Instagram evidence.
  const ownedEvidence = await getOwnedAnalyticsGuidance("instagram", reel.genre);
  if (!source || !config.openRouterApiKey) {
    recordOperationLog({
      scope: "system",
      level: "warn",
      event: "instagram.caption_ai_fallback",
      message: "Instagram caption AI was unavailable; saved a deterministic guarded draft",
      reelId: reel._id.toString(),
      metadata: { reason: !source ? "missing_source" : "missing_openrouter_key" },
    });
    return { caption: fallback, source: "fallback" };
  }

  const nicheLabel = reel.niche === "reddit" ? "Reddit story Reel" : isHorrorNiche(reel.niche) ? "horror Reel" : `${getRecipe(reel.niche).displayName} Reel`;
  const partInstruction =
    reel.partNumber && reel.partCount && reel.partCount > 1
      ? `This is part ${reel.partNumber} of ${reel.partCount}; make the CTA accurately point to the next part when one exists.`
      : "This is a standalone/final Reel; use a natural follow CTA only if it fits.";
  try {
    const { text, usage } = await generateText({
      model: openrouter(model),
      prompt: `Write the caption that appears under an Instagram Reel for this ${nicheLabel}.

SOURCE STORY:
${source}

Rules:
- Output JSON only: {"caption":"..."}.
- Write 2–3 short, mobile-readable paragraphs. The first line is a specific emotional hook; the middle gives only the essential setup/conflict; the last prose line is a natural question or light follow CTA.
- This is Instagram copy, not a title or transcript. Do not repeat the post title verbatim, use title labels, or mention AI, gameplay, video generation, captions, thumbnails, YouTube, likes, or "watch now".
- Do not invent facts, use spoiler language beyond this part, or use generic engagement bait such as "wait for it".
- Put exactly 3–5 relevant Instagram hashtags on their own final line. Each must be lower-case, start with #, contain no spaces, and be story/niche-specific. Never use #fyp, #viral, #reels, #explorepage, #instagram, or #shorts.
- Keep all prose and hashtags under 700 characters.
- ${partInstruction}

${platformCopyRules("instagram")}

${ownedEvidence ?? "OWNED INSTAGRAM PERFORMANCE: insufficient comparable posts. Follow the platform defaults only."}`,
    });
    reportLlmUsage(onLlmUsage, "Instagram caption", model, usage);
    const generatedCaption = extractInstagramCaption(text);
    if (!generatedCaption) throw new Error("Instagram caption model returned no caption");
    const caption = cleanInstagramCaption(generatedCaption, fallback, tags);
    return { caption, source: "ai", model };
  } catch (error: unknown) {
    console.warn(`Instagram caption generation failed, using fallback: ${getErrorMessage(error)}`);
    recordOperationLog({
      scope: "external",
      level: "warn",
      event: "instagram.caption_ai_fallback",
      message: "Instagram caption generation failed; saved a deterministic guarded draft",
      reelId: reel._id.toString(),
      error,
    });
    return { caption: fallback, source: "fallback" };
  }
}

/** Mutates the loaded reel so normal production can persist the generated copy
 * atomically with its review package and cost breakdown. */
export async function generateInstagramCaptionForReel(
  reel: IReel,
  onLlmUsage?: LlmUsageCallback,
): Promise<IInstagramPublishSettings> {
  const result = await buildInstagramCaption(reel, instagramTagsForReel(reel), onLlmUsage);
  const settings: IInstagramPublishSettings = {
    caption: result.caption,
    shareToFeed: reel.instagramSettings?.shareToFeed ?? true,
    source: result.source,
    generatedAt: new Date(),
    model: result.model,
    // Caption regeneration must never erase the independently editable native
    // poll draft.
    poll: reel.instagramSettings?.poll,
  };
  reel.instagramSettings = settings;
  reel.markModified("instagramSettings");
  recordOperationLog({
    scope: "system",
    event: "instagram.caption_generated",
    message: result.source === "ai" ? "Generated an Instagram-native caption" : "Saved a guarded Instagram caption fallback",
    reelId: reel._id.toString(),
    metadata: {
      source: result.source,
      model: result.model,
      length: settings.caption?.length ?? 0,
      hashtagCount: instagramHashtagCount(settings.caption ?? ""),
    },
  });
  return settings;
}

/** Generate the two non-Instagram Meta surfaces together, but keep their
 * saved fields separate so editing/publishing remains platform-native. */
export async function generateFacebookAndThreadsCopyForReel(
  reel: IReel,
  onLlmUsage?: LlmUsageCallback,
  options: { platforms?: ("facebook" | "threads")[] } = {},
): Promise<{ facebook: IFacebookPublishSettings; threads: IThreadsPublishSettings }> {
  const platforms = options.platforms?.length
    ? [...new Set(options.platforms)]
    : ["facebook", "threads"] as const;
  const generateFacebook = platforms.includes("facebook");
  const generateThreads = platforms.includes("threads");
  const model = resolveModels("cheap").llm;
  const source = storySeed(reel).slice(0, 2_600);
  const [facebookEvidence, threadsEvidence] = await Promise.all([
    getOwnedAnalyticsGuidance("facebook", reel.genre),
    getOwnedAnalyticsGuidance("threads", reel.genre),
  ]);
  const contentLabel = reel.niche === "reddit"
    ? "Reddit-story video"
    : isHorrorNiche(reel.niche)
      ? "horror story video"
      : `${getRecipe(reel.niche).displayName} video`;
  const fallbackFacebook = reel.review?.description ?? buildDescription(reel, reel.review?.title ?? buildTitle(reel));
  const fallbackThreads = reel.review?.title ?? buildTitle(reel);
  if (!source || !config.openRouterApiKey) {
    if (generateFacebook) {
      reel.facebookSettings = { ...(reel.facebookSettings ?? {}), description: fallbackFacebook, source: "fallback", generatedAt: new Date() };
      reel.markModified("facebookSettings");
    }
    if (generateThreads) {
      reel.threadsSettings = { ...(reel.threadsSettings ?? {}), text: fallbackThreads.slice(0, 500), source: "fallback", generatedAt: new Date() };
      reel.markModified("threadsSettings");
    }
    return { facebook: reel.facebookSettings ?? {}, threads: reel.threadsSettings ?? {} };
  }
  try {
    const { text, usage } = await generateText({
      model: openrouter(model),
      prompt: `Write ${generateFacebook && generateThreads ? "distinct Facebook Reels and Threads" : generateFacebook ? "Facebook Reels" : "Threads"} copy for this ${contentLabel}.

SOURCE STORY:
${source}

Output JSON only: ${generateFacebook && generateThreads ? '{"facebookDescription":"...","threadsText":"..."}' : generateFacebook ? '{"facebookDescription":"..."}' : '{"threadsText":"..."}'}.
${generateFacebook ? "- Facebook description: 1–2 concise, readable sentences of accurate context plus at most one real story question. Maximum 700 characters." : ""}
${generateThreads ? `- Threads text: independently understandable, opinionated premise plus one specific question. Maximum 500 characters.${generateFacebook ? " Do not copy the Facebook text." : ""}` : ""}
- Never invent facts, claim a part is live, use keyword/hashtag dumps, or use vote/like/comment bait.

${platformCopyRules("facebook")}

${platformCopyRules("threads")}

OWNED FACEBOOK PERFORMANCE (first-party, Facebook only):
${facebookEvidence ?? "Insufficient comparable Facebook posts. Follow the platform defaults only."}

OWNED THREADS PERFORMANCE (first-party, Threads only):
${threadsEvidence ?? "Insufficient comparable Threads posts. Follow the platform defaults only."}`,
    });
    reportLlmUsage(onLlmUsage, "Facebook & Threads copy", model, usage);
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    const parsed = json ? JSON.parse(json) as Record<string, unknown> : {};
    const facebookDescription = typeof parsed.facebookDescription === "string" ? trimCaptionBody(parsed.facebookDescription, 700) : fallbackFacebook;
    const threadsText = typeof parsed.threadsText === "string" ? trimCaptionBody(parsed.threadsText, 500) : fallbackThreads.slice(0, 500);
    if (generateFacebook) reel.facebookSettings = { ...(reel.facebookSettings ?? {}), description: facebookDescription || fallbackFacebook, source: "ai", generatedAt: new Date(), model };
    if (generateThreads) reel.threadsSettings = { ...(reel.threadsSettings ?? {}), text: threadsText || fallbackThreads.slice(0, 500), source: "ai", generatedAt: new Date(), model };
  } catch (error) {
    recordOperationLog({ scope: "external", level: "warn", event: "crosspost.copy_ai_fallback", message: "Facebook/Threads copy generation failed; saved guarded fallbacks", reelId: reel._id.toString(), error });
    if (generateFacebook) reel.facebookSettings = { ...(reel.facebookSettings ?? {}), description: fallbackFacebook, source: "fallback", generatedAt: new Date() };
    if (generateThreads) reel.threadsSettings = { ...(reel.threadsSettings ?? {}), text: fallbackThreads.slice(0, 500), source: "fallback", generatedAt: new Date() };
  }
  if (generateFacebook) reel.markModified("facebookSettings");
  if (generateThreads) reel.markModified("threadsSettings");
  return { facebook: reel.facebookSettings ?? {}, threads: reel.threadsSettings ?? {} };
}

export interface InstagramPollSuggestionResult {
  question: string;
  optionA: string;
  optionB: string;
  source: "ai" | "fallback";
  model?: string;
}

function fallbackInstagramPoll(reel: IReel): Omit<InstagramPollSuggestionResult, "source" | "model"> {
  if (isHorrorNiche(reel.niche)) {
    return { question: "Would you go inside?", optionA: "Absolutely not", optionB: "I would" };
  }
  if (reel.niche === "reddit") {
    return { question: "Who was more wrong?", optionA: "OP", optionB: "The other person" };
  }
  return { question: "What would you do?", optionA: "Walk away", optionB: "Hear them out" };
}

function compactPollText(value: string, maxLength: number): string {
  const compact = value
    .replace(/[\r\n]+/g, " ")
    .replace(/["“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length <= maxLength) return compact;
  return compact.slice(0, maxLength).replace(/\s+\S*$/, "").trim();
}

function extractInstagramPoll(text: string): Omit<InstagramPollSuggestionResult, "source" | "model"> | undefined {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return undefined;
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const question = typeof parsed.question === "string" ? compactPollText(parsed.question, 90) : "";
    const optionA = typeof parsed.optionA === "string" ? compactPollText(parsed.optionA, 30) : "";
    const optionB = typeof parsed.optionB === "string" ? compactPollText(parsed.optionB, 30) : "";
    return question && optionA && optionB && optionA.toLocaleLowerCase() !== optionB.toLocaleLowerCase()
      ? { question, optionA, optionB }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Native interactive polls are created in Instagram itself. This produces
 * only a short, editable question/options draft for the creator to paste. */
async function buildInstagramPollSuggestion(
  reel: IReel,
  onLlmUsage?: LlmUsageCallback,
): Promise<InstagramPollSuggestionResult> {
  const fallback = fallbackInstagramPoll(reel);
  const source = storySeed(reel).slice(0, 2_600);
  const model = resolveModels("cheap").llm;
  if (!source || !config.openRouterApiKey) {
    return { ...fallback, source: "fallback" };
  }
  try {
    const { text, usage } = await generateText({
      model: openrouter(model),
      prompt: `Create one native Instagram poll draft for this Reel. It will be entered manually in the Instagram app, so do not claim it can be attached by an API.

SOURCE STORY:
${source}

Rules:
- Output JSON only: {"question":"...","optionA":"...","optionB":"..."}.
- Question: 3–10 words, under 90 characters. Each option: 1–4 words, under 30 characters.
- Make it a specific, balanced dilemma from this part of the story; invite an opinion without spoiling a later part.
- Options must be distinct, clear on a phone, and never use hashtags, emojis, “yes/no” filler, “part 2”, or generic engagement bait.
- Do not invent facts or repeat the title verbatim.`,
    });
    reportLlmUsage(onLlmUsage, "Instagram poll suggestion", model, usage);
    const poll = extractInstagramPoll(text);
    if (!poll) throw new Error("Instagram poll model returned invalid options");
    return { ...poll, source: "ai", model };
  } catch (error: unknown) {
    console.warn(`Instagram poll generation failed, using fallback: ${getErrorMessage(error)}`);
    recordOperationLog({
      scope: "external",
      level: "warn",
      event: "instagram.poll_ai_fallback",
      message: "Instagram poll suggestion generation failed; saved a deterministic draft",
      reelId: reel._id.toString(),
      error,
    });
    return { ...fallback, source: "fallback" };
  }
}

/** Mutates the reel with creator-only poll copy. It is deliberately not read
 * by the Meta publishing worker because the API cannot create poll stickers. */
export async function generateInstagramPollSuggestionForReel(
  reel: IReel,
  onLlmUsage?: LlmUsageCallback,
): Promise<IInstagramPollSuggestion> {
  const result = await buildInstagramPollSuggestion(reel, onLlmUsage);
  const poll: IInstagramPollSuggestion = {
    question: result.question,
    optionA: result.optionA,
    optionB: result.optionB,
    source: result.source,
    generatedAt: new Date(),
    model: result.model,
  };
  reel.instagramSettings = {
    caption: reel.instagramSettings?.caption,
    shareToFeed: reel.instagramSettings?.shareToFeed ?? true,
    source: reel.instagramSettings?.source,
    generatedAt: reel.instagramSettings?.generatedAt,
    model: reel.instagramSettings?.model,
    poll,
  };
  reel.markModified("instagramSettings");
  recordOperationLog({
    scope: "system",
    event: "instagram.poll_suggestion_generated",
    message: result.source === "ai" ? "Generated an editable Instagram native-poll draft" : "Saved a fallback Instagram native-poll draft",
    reelId: reel._id.toString(),
    metadata: { source: result.source, model: result.model },
  });
  return poll;
}

async function buildReviewCopy(
  reel: IReel,
  tags: string[],
  onLlmUsage?: LlmUsageCallback,
): Promise<{ title: string; description: string }> {
  const hashtagStrings = formatYouTubeHashtags(tags);
  const baseFallbackTitle = stripHashtagsFromText(buildTitle(reel)).slice(0, 100);
  const fallbackTitle = baseFallbackTitle;
  const fallbackDescription = withDescriptionHashtags(buildDescription(reel, baseFallbackTitle), hashtagStrings);
  const source = storySeed(reel).slice(0, 2600);
  const [research, ownedEvidence] = await Promise.all([
    getTrendCopyGuidance(reel.niche, reel.genre),
    getOwnedAnalyticsGuidance("youtube", reel.genre),
  ]);
  if (!source || !config.openRouterApiKey) {
    return { title: fallbackTitle, description: fallbackDescription };
  }

  const nicheLabel =
    reel.niche === "reddit"
      ? "Reddit story / AITA short"
      : isHorrorNiche(reel.niche)
        ? "horror short"
        : getRecipe(reel.niche).displayName;

  try {
    const model = resolveModels("cheap").llm;
    const { text, usage } = await generateText({
      model: openrouter(model),
      prompt: `Write the YouTube Shorts metadata for this ${nicheLabel}.

SOURCE STORY:
${source}

Rules:
- Output JSON only: {"title":"...","description":"..."}.
- The title is the YouTube Shorts headline: 45–75 characters, specific to the central conflict or twist, spoken-natural, and curiosity-led without clickbait. It must contain no hashtags, emojis, quotation marks, or ALL CAPS.
- The description is 1–2 concise, searchable sentences that add context rather than repeat the title. It must contain no hashtags; the server appends a separate YouTube hashtag line.
- Avoid generic format words such as gameplay, AI, video generation, horror video, short-form, content, captions, thumbnail, Instagram, Reel, or "watch now".
- Do not invent facts not present in the source.
- Include accurate part context when this is one part of a series.
- Make it punchy, human, searchable, and platform-native — never templated filler.

${platformCopyRules("youtube")}

OWNED YOUTUBE PERFORMANCE — higher priority because this is our audience:
${ownedEvidence ?? "Insufficient comparable owned YouTube posts. Follow the platform defaults."}

EXTERNAL YOUTUBE RESEARCH — lower-priority cold-start packaging inspiration only:
${research}`,
    });
    reportLlmUsage(onLlmUsage, "Review copy", model, usage);

    const parsed = extractReviewJson(text);
    const baseTitle = parsed.title ? stripHashtagsFromText(cleanTitle(parsed.title)) : baseFallbackTitle;
    const baseDescription = parsed.description
      ? stripHashtagsFromText(parsed.description.trim()).slice(0, 500)
      : "";
    const title = baseTitle;
    const description = baseDescription
      ? withDescriptionHashtags(baseDescription, hashtagStrings)
      : fallbackDescription;
    return { title, description };
  } catch (error: unknown) {
    console.warn(`Review copy generation failed, using fallback: ${getErrorMessage(error)}`);
    recordOperationLog({
      scope: "external",
      level: "warn",
      event: "openrouter.review_copy_fallback",
      message: "Review copy generation failed; using deterministic title and description",
      error,
    });
    return { title: fallbackTitle, description: fallbackDescription };
  }
}

function fallbackThumbnailText(reel: IReel): string {
  if (isHorrorNiche(reel.niche)) return "DON'T GO INSIDE";
  if (reel.niche === "reddit") return "WHO'S REALLY WRONG?";
  return "THE TRUTH COMES OUT";
}

function cleanThumbnailText(value: string): string | undefined {
  const text = value
    .replace(/[\r\n]+/g, " ")
    .replace(/#[\p{L}\p{N}_]+/gu, "")
    .replace(/["“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  const bounded =
    text.length <= 60 ? text : text.slice(0, 60).replace(/\s+\S*$/, "").trim();
  return bounded || undefined;
}

function extractThumbnailText(text: string): string | undefined {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return undefined;
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    return typeof parsed.thumbnailText === "string" ? cleanThumbnailText(parsed.thumbnailText) : undefined;
  } catch {
    return undefined;
  }
}

/** Generate compact overlay copy separately from the long YouTube headline.
 * This call is intentionally metered on its own so the Cost panel can show
 * exactly what was spent to create the thumbnail hook. */
async function buildThumbnailText(
  reel: IReel,
  onLlmUsage?: LlmUsageCallback,
): Promise<string> {
  const fallback = fallbackThumbnailText(reel);
  const source = storySeed(reel).slice(0, 2_600);
  const model = resolveModels("cheap").llm;
  if (!source || !config.openRouterApiKey) return fallback;

  try {
    const { text, usage } = await generateText({
      model: openrouter(model),
      prompt: `Write the on-image text for a YouTube Shorts thumbnail.

SOURCE STORY:
${source}

Rules:
- Output JSON only: {"thumbnailText":"..."}.
- 3–7 punchy words, maximum 42 characters. It must express a conflict, accusation, reversal, or twist that makes the viewer curious.
- This is NOT the YouTube title and NOT the Reddit/title-card headline. Do not copy any run of 4 or more consecutive words from the source title or restate it in sentence form.
- No “Part 1/2”, hashtags, emojis, quotation marks, vague bait (“you won't believe”), labels, or generic format words.
- Keep it factually grounded in this story part and readable as large overlay text.`,
    });
    reportLlmUsage(onLlmUsage, "Thumbnail hook", model, usage);
    return extractThumbnailText(text) ?? fallback;
  } catch (error: unknown) {
    console.warn(`Thumbnail hook generation failed, using fallback: ${getErrorMessage(error)}`);
    recordOperationLog({
      scope: "external",
      level: "warn",
      event: "review.thumbnail_hook_ai_fallback",
      message: "Thumbnail hook generation failed; using a deterministic fallback",
      reelId: reel._id.toString(),
      error,
    });
    return fallback;
  }
}

/** Ensure the shared opening-cover/thumbnail hook exists without constructing
 * the larger YouTube review package. The caller persists the reel and records
 * the metered usage in its own plan or produce ledger. */
export async function ensureReelThumbnailHook(
  reel: IReel,
  onLlmUsage?: LlmUsageCallback,
): Promise<string> {
  const existing = cleanThumbnailText(reel.review?.thumbnailText ?? reel.thumbnailHook ?? "");
  if (existing) {
    if (reel.thumbnailHook !== existing) reel.thumbnailHook = existing;
    return existing;
  }

  const thumbnailHook = await buildThumbnailText(reel, onLlmUsage);
  reel.thumbnailHook = thumbnailHook;
  // First-time hook fill may stale an automatic opening cover headline.
  await refreshAutomaticOpeningCoverIfStale(reel);
  return thumbnailHook;
}

function buildDescription(reel: IReel, title: string): string {
  const part =
    reel.partNumber && reel.partCount && reel.partCount > 1
      ? `\n\nPart ${reel.partNumber} of ${reel.partCount}.`
      : "";
  if (reel.niche === "reddit") {
    const source = reel.redditStory?.subreddit ? `${reel.redditStory.subreddit} story` : "Reddit story";
    return `${title}\n\n${source}.${part}`.trim();
  }

  const recipe = getRecipe(reel.niche);
  return `${title}\n\n${recipe.displayName}.${part}`.trim();
}

async function buildThumbnailPrompt(reel: IReel): Promise<string> {
  const genre = reel.genre ? ` ${reel.genre.replace(/_/g, " ")}` : "";
  const digest = await getTrendDigest(reel.niche, reel.genre);
  const trendBlock = digest ? ` Reference these winning thumbnail/title patterns from top-performing videos in this genre: ${digest.replace(/\n/g, " ")}` : "";

  if (reel.niche === "reddit") {
    return `Clean cinematic background for a${genre} Reddit story: tense gameplay-inspired environment, red-orange accent, strong focal area and negative space. Image only: no text, lettering, captions, logos, badges, cards, borders, UI, collage, split-screen, or thumbnail graphics.${trendBlock}`;
  }

  if (isHorrorNiche(reel.niche)) {
    const medium = reel.niche === "horror_comic" ? "2D horror comic panel" : "dark cinematic photoreal scene";
    return `Clean background image for a${genre} horror story: ${medium}, single unsettling figure or silhouette half-lit, deep shadows, blood-red or sickly-green rim light, high contrast, unsettling composition and negative space. Image only: no text, lettering, captions, logos, badges, borders, UI, collage, split-screen, or thumbnail graphics.${trendBlock}`;
  }

  const recipe = getRecipe(reel.niche);
  return `Clean cinematic background for a "${recipe.displayName}"${genre} video: dramatic scene, strong focal point, high contrast and negative space. Image only: no text, lettering, captions, logos, badges, borders, UI, collage, split-screen, or thumbnail graphics.${trendBlock}`;
}

interface ThumbnailBrand {
  badgeText: string;
  badgeColor: string;
}

function thumbnailBrand(niche: string): ThumbnailBrand {
  if (niche === "reddit") return { badgeText: "REDDIT", badgeColor: "#ff4500" };
  if (isHorrorNiche(niche)) return { badgeText: niche === "horror_comic" ? "COMIC HORROR" : "HORROR", badgeColor: "#7f1d1d" };
  return { badgeText: getRecipe(niche).displayName.toUpperCase(), badgeColor: "#0f766e" };
}

async function buildVisibilityNotes(reel: IReel): Promise<string> {
  const refs = await listTrendReferences({
    niche: reel.niche,
    genre: reel.genre,
    platform: "youtube_shorts",
    status: "approved",
    limit: 3,
  });

  if (!refs.length) {
    return reel.niche === "reddit"
      ? "Use a curiosity-gap title, large readable thumbnail text, Reddit/card visual language, first-second hook, and Shorts tags."
      : "Use a curiosity-gap title, large readable thumbnail text, dramatic visual language, first-second hook, and Shorts tags.";
  }

  const notes = refs
    .map((ref, index) => `${index + 1}. ${ref.notes ?? ref.sourceUrl}`)
    .join(" ");
  return `Trend references applied: ${notes}`;
}

const THUMB_W = 1280;
const THUMB_H = 720; // YouTube thumbnail ratio (16:9)
type ThumbnailAspectRatio = "16:9" | "9:16" | "1:1";

function thumbnailSize(aspectRatio: ThumbnailAspectRatio = "16:9"): { width: number; height: number } {
  if (aspectRatio === "9:16") return { width: 1080, height: 1920 };
  if (aspectRatio === "1:1") return { width: 1080, height: 1080 };
  return { width: THUMB_W, height: THUMB_H };
}

/** Flat mockup thumbnail (no AI image) — the original design, kept as a
 * fallback when image generation fails or no prompt is available. Branding
 * (badge text/color, Reddit post-card mockup) varies by niche. */
async function renderFlatThumbnailPng(title: string, subtitle: string, niche: string): Promise<string> {
  await ensureDir(config.processingPath);
  const lines = wrap(title, 18);
  const titleSvg = lines
    .map((line, index) => `<tspan x="70" dy="${index === 0 ? 0 : 86}">${esc(line)}</tspan>`)
    .join("");
  const brand = thumbnailBrand(niche);
  const isReddit = niche === "reddit";

  const cardMockup = isReddit
    ? `<rect x="760" y="70" width="420" height="560" rx="34" fill="#f8fafc" opacity="0.95" filter="url(#shadow)"/>
  <circle cx="836" cy="150" r="34" fill="${brand.badgeColor}"/>
  <text x="836" y="162" text-anchor="middle" font-family="Arial" font-size="36" font-weight="700" fill="#fff">r</text>
  <text x="890" y="146" font-family="Arial" font-size="32" font-weight="700" fill="#111827">Reddit</text>
  <text x="890" y="184" font-family="Arial" font-size="24" fill="#64748b">storytime</text>
  <rect x="810" y="240" width="320" height="28" rx="14" fill="#cbd5e1"/>
  <rect x="810" y="302" width="268" height="28" rx="14" fill="#e2e8f0"/>
  <rect x="810" y="364" width="338" height="28" rx="14" fill="#cbd5e1"/>
  <rect x="810" y="504" width="150" height="52" rx="26" fill="${brand.badgeColor}"/>
  <text x="885" y="539" text-anchor="middle" font-family="Arial" font-size="25" font-weight="700" fill="#fff">AITA?</text>`
    : "";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${THUMB_W}" height="${THUMB_H}" viewBox="0 0 ${THUMB_W} ${THUMB_H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b0b0f"/>
      <stop offset="0.54" stop-color="#171923"/>
      <stop offset="1" stop-color="${brand.badgeColor}"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#000000" flood-opacity="0.34"/>
    </filter>
  </defs>
  <rect width="${THUMB_W}" height="${THUMB_H}" fill="url(#bg)"/>
  ${cardMockup}
  <rect x="48" y="80" width="622" height="560" rx="32" fill="#ffffff" filter="url(#shadow)"/>
  <text x="70" y="164" font-family="Arial" font-size="34" font-weight="700" fill="${brand.badgeColor}">${esc(brand.badgeText)} SHORTS</text>
  <text x="70" y="280" font-family="Arial" font-size="76" line-height="1" font-weight="900" fill="#111827">${titleSvg}</text>
  <text x="70" y="588" font-family="Arial" font-size="30" font-weight="700" fill="#475569">${esc(subtitle)}</text>
</svg>`;

  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: THUMB_W },
    font: { loadSystemFonts: true },
  }).render().asPng();
  const path = join(config.processingPath, generateFilename("thumbnail", "png"));
  await writeFile(path, png);
  return path;
}

/** Transparent text-overlay layer: bottom gradient for legibility + huge bold
 * hook text + a small niche badge — composited over the AI background. */
function renderThumbnailOverlaySvg(title: string, niche: string): Buffer {
  const lines = wrap(title, 16);
  const lineH = 84;
  const startY = THUMB_H - 70 - (lines.length - 1) * lineH;
  const brand = thumbnailBrand(niche);
  const textSvg = lines
    .map(
      (line, index) =>
        `<text x="64" y="${startY + index * lineH}" font-family="Arial" font-size="72" font-weight="900" fill="#ffffff" stroke="#000000" stroke-width="10" paint-order="stroke" stroke-linejoin="round">${esc(line)}</text>`
    )
    .join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${THUMB_W}" height="${THUMB_H}" viewBox="0 0 ${THUMB_W} ${THUMB_H}">
  <defs>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0.45" stop-color="#000000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.78"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${THUMB_W}" height="${THUMB_H}" fill="url(#fade)"/>
  <rect x="40" y="40" width="150" height="52" rx="26" fill="${brand.badgeColor}"/>
  <text x="115" y="75" text-anchor="middle" font-family="Arial" font-size="26" font-weight="700" fill="#ffffff">${esc(brand.badgeText)}</text>
  ${textSvg}
</svg>`;

  return new Resvg(svg, { fitTo: { mode: "width", value: THUMB_W } }).render().asPng();
}

function fitToThumbnailFrame(input: string, output: string): Promise<string> {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .outputOptions(["-vf", `scale=${THUMB_W}:${THUMB_H}:force_original_aspect_ratio=increase,crop=${THUMB_W}:${THUMB_H}`])
      .output(output)
      .on("end", () => resolve(output))
      .on("error", (err) => reject(new Error(`Thumbnail background fit failed: ${err.message}`)))
      .run();
  });
}

function overlayThumbnailText(background: string, overlay: string, output: string): Promise<string> {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(background)
      .input(overlay)
      .complexFilter(["[0:v][1:v]overlay=0:0"])
      .outputOptions(["-frames:v", "1"])
      .output(output)
      .on("end", () => resolve(output))
      .on("error", (err) => reject(new Error(`Thumbnail composite failed: ${err.message}`)))
      .run();
  });
}

/** Real AI thumbnail: generate a dramatic background from `thumbnailPrompt`,
 * composite the bold hook text + niche badge on top. Falls back to the flat
 * mockup design if image generation or compositing fails. */
async function renderThumbnailPng(
  title: string,
  subtitle: string,
  niche: string,
  thumbnailPrompt?: string,
  onImageUsage?: MediaUsageCallback
): Promise<string> {
  await ensureDir(config.processingPath);
  if (!thumbnailPrompt) return renderFlatThumbnailPng(title, subtitle, niche);

  const localFiles: string[] = [];
  try {
    const imageModel = resolveModels("cheap").image;
    const rawBgPath = await generateImage(
      thumbnailPrompt,
      "dramatic wide shot, high contrast, cinematic, clean image only, no text, lettering, logos, UI, borders, collage, or thumbnail graphics",
      { model: imageModel, outputDir: config.processingPath, onUsage: onImageUsage }
    );
    localFiles.push(rawBgPath);

    const fittedBgPath = join(config.processingPath, generateFilename("thumb_bg", "png"));
    await fitToThumbnailFrame(rawBgPath, fittedBgPath);
    localFiles.push(fittedBgPath);

    const overlayPath = join(config.processingPath, generateFilename("thumb_overlay", "png"));
    await writeFile(overlayPath, renderThumbnailOverlaySvg(title, niche));
    localFiles.push(overlayPath);

    const finalPath = join(config.processingPath, generateFilename("thumbnail", "png"));
    await overlayThumbnailText(fittedBgPath, overlayPath, finalPath);

    await Promise.all(localFiles.map((f) => unlink(f).catch(() => {})));
    return finalPath;
  } catch (error: unknown) {
    console.warn(`🖼️  AI thumbnail failed, falling back to flat design: ${getErrorMessage(error)}`);
    recordOperationLog({
      scope: "external",
      level: "warn",
      event: "review.thumbnail_flat_fallback",
      message: "AI review-thumbnail generation failed; using the flat thumbnail design",
      error,
    });
    await Promise.all(localFiles.map((f) => unlink(f).catch(() => {})));
    return renderFlatThumbnailPng(title, subtitle, niche);
  }
}

export interface ReelReviewUsageCallbacks {
  onReviewCopyUsage?: LlmUsageCallback;
  onThumbnailHookUsage?: LlmUsageCallback;
  onThumbnailImageUsage?: MediaUsageCallback;
}

function resolveReviewUsageCallbacks(
  usage?: MediaUsageCallback | ReelReviewUsageCallbacks,
): ReelReviewUsageCallbacks {
  if (!usage) return {};
  return typeof usage === "function" ? { onThumbnailImageUsage: usage } : usage;
}

export async function buildReelReviewPackage(
  reel: IReel,
  usage?: MediaUsageCallback | ReelReviewUsageCallbacks,
): Promise<IReelReviewPackage> {
  const callbacks = resolveReviewUsageCallbacks(usage);
  const tags = reviewTagsForReel(reel);
  // These independent editorial calls are intentionally parallel: all outputs
  // are persisted together, while each LLM usage callback remains a distinct
  // cost line in the ledger.
  const existingThumbnailText = cleanThumbnailText(reel.review?.thumbnailText ?? reel.thumbnailHook ?? "");
  const [{ title, description }, thumbnailText, thumbnailPrompt, visibilityNotes] = await Promise.all([
    buildReviewCopy(reel, tags, callbacks.onReviewCopyUsage),
    existingThumbnailText
      ? Promise.resolve(existingThumbnailText)
      : buildThumbnailText(reel, callbacks.onThumbnailHookUsage),
    buildThumbnailPrompt(reel),
    buildVisibilityNotes(reel),
  ]);
  const subtitle = reel.partNumber && reel.partCount ? `Part ${reel.partNumber} of ${reel.partCount}` : "Full story";
  const thumbnailUrl =
    reel.thumbnailMode === "ai"
      ? await renderAndUploadThumbnail(reel, thumbnailText, subtitle, thumbnailPrompt, callbacks.onThumbnailImageUsage)
      : undefined;

  reel.thumbnailHook = thumbnailText;

  return {
    title,
    description,
    tags,
    thumbnailText,
    thumbnailUrl,
    thumbnailPrompt,
    visibilityNotes,
    status: "ready",
    updatedAt: new Date(),
  };
}

async function renderAndUploadThumbnail(
  reel: IReel,
  thumbnailText: string,
  subtitle: string,
  thumbnailPrompt: string,
  onThumbnailImageUsage?: MediaUsageCallback
): Promise<string> {
  const thumbnailPath = await renderThumbnailPng(
    thumbnailText,
    subtitle,
    reel.niche,
    thumbnailPrompt,
    onThumbnailImageUsage
  );
  try {
    return await uploadImage(await readFile(thumbnailPath), "reels", `${reel._id}_thumbnail.png`);
  } finally {
    await unlink(thumbnailPath).catch(() => {});
  }
}

export async function ensureReelReviewPackage(reelId: string): Promise<IReelReviewPackage> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  const needsReview = !reel.review?.title || (reel.thumbnailMode === "ai" && !reel.review.thumbnailUrl);
  const needsThumbnailText = !reel.review?.thumbnailText?.trim();
  // A string (including an intentional empty one) means a human has already
  // made the Instagram-copy decision. Only genuinely unset settings get an AI
  // draft as part of the normal review package.
  const needsInstagramCaption = typeof reel.instagramSettings?.caption !== "string";
  const needsInstagramPoll = !reel.instagramSettings?.poll;
  if (needsReview || needsThumbnailText || needsInstagramCaption || needsInstagramPoll) {
    const measuredCosts: MeasuredCostInput[] = [];
    const callbacks: ReelReviewUsageCallbacks = {
      onReviewCopyUsage: (usage) => {
        measuredCosts.push({ label: usage.label, model: usage.model, costUsd: usage.costUsd, source: "actual" });
      },
      onThumbnailImageUsage: (usage) => {
        measuredCosts.push({
          label: "Thumbnail image",
          model: resolveModels("cheap").image,
          costUsd: usage.costUsd,
          source: usage.costUsd !== undefined ? "actual" : "estimated",
        });
      },
      onThumbnailHookUsage: (usage) => {
        measuredCosts.push({ label: usage.label, model: usage.model, costUsd: usage.costUsd, source: "actual" });
      },
    };
    if (needsReview) reel.review = await buildReelReviewPackage(reel, callbacks);
    else if (needsThumbnailText && reel.review) {
      reel.review.thumbnailText = await ensureReelThumbnailHook(reel, callbacks.onThumbnailHookUsage);
      reel.review.updatedAt = new Date();
      reel.markModified("review");
    }
    if (needsInstagramCaption) {
      await generateInstagramCaptionForReel(reel, (usage) => {
        measuredCosts.push({ label: usage.label, model: usage.model, costUsd: usage.costUsd, source: "actual" });
      });
    }
    if (needsInstagramPoll) {
      await generateInstagramPollSuggestionForReel(reel, (usage) => {
        measuredCosts.push({ label: usage.label, model: usage.model, costUsd: usage.costUsd, source: "actual" });
      });
    }
    applyMeasuredCostsToReel(reel, measuredCosts, "Review package");
    await reel.save();
  }
  if (!reel.review) throw new Error("Review package could not be created");
  return reel.review;
}

/** Paid, explicit re-generation for an already-reviewed Reel. It replaces only
 * the Instagram caption; YouTube title, description, tags, and thumbnails are
 * intentionally untouched. */
export async function regenerateInstagramCaption(reelId: string): Promise<IReel> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  const measuredCosts: MeasuredCostInput[] = [];
  await generateInstagramCaptionForReel(reel, (usage) => {
    measuredCosts.push({ label: usage.label, model: usage.model, costUsd: usage.costUsd, source: "actual" });
  });
  applyMeasuredCostsToReel(reel, measuredCosts, "Instagram caption");
  await reel.save();
  return reel;
}

/** Paid, explicit re-generation of the creator-only native Instagram poll
 * draft. It never changes the rendered reel, caption, or publish payload. */
export async function regenerateInstagramPollSuggestion(reelId: string): Promise<IReel> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  const measuredCosts: MeasuredCostInput[] = [];
  await generateInstagramPollSuggestionForReel(reel, (usage) => {
    measuredCosts.push({ label: usage.label, model: usage.model, costUsd: usage.costUsd, source: "actual" });
  });
  applyMeasuredCostsToReel(reel, measuredCosts, "Instagram poll suggestion");
  await reel.save();
  return reel;
}

/** Paid, explicit re-generation for one Meta cross-post surface. It never
 * changes the other platform's saved draft, YouTube metadata, or media. */
export async function regenerateCrossPostCopy(
  reelId: string,
  platform: "facebook" | "threads",
): Promise<IReel> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  const measuredCosts: MeasuredCostInput[] = [];
  await generateFacebookAndThreadsCopyForReel(reel, (usage) => {
    measuredCosts.push({ label: usage.label, model: usage.model, costUsd: usage.costUsd, source: "actual" });
  }, { platforms: [platform] });
  applyMeasuredCostsToReel(reel, measuredCosts, `${platform === "facebook" ? "Facebook" : "Threads"} copy`);
  recordOperationLog({
    scope: "system",
    event: `${platform}.copy_generated`,
    message: `Generated ${platform === "facebook" ? "Facebook Reels description" : "Threads post text"}`,
    reelId: reel._id.toString(),
    metadata: { model: resolveModels("cheap").llm },
  });
  await reel.save();
  return reel;
}

/** Paid, explicit thumbnail-copy regeneration. It does not render an image or
 * alter the YouTube title/description; the saved hook is used by the next AI
 * thumbnail render and as the default text in Thumbnail Studio. */
export async function regenerateThumbnailText(reelId: string): Promise<IReel> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  const measuredCosts: MeasuredCostInput[] = [];
  const thumbnailText = await buildThumbnailText(reel, (usage) => {
    measuredCosts.push({ label: usage.label, model: usage.model, costUsd: usage.costUsd, source: "actual" });
  });
  const current: IReelReviewPackage = reel.review ?? {
    tags: reviewTagsForReel(reel),
    status: "ready",
    updatedAt: new Date(),
  };
  reel.thumbnailHook = thumbnailText;
  reel.review = { ...current, thumbnailText, updatedAt: new Date() };
  reel.markModified("review");
  applyMeasuredCostsToReel(reel, measuredCosts, "Thumbnail hook");
  recordOperationLog({
    scope: "system",
    event: "review.thumbnail_hook_generated",
    message: "Generated a distinct, editable thumbnail hook",
    reelId: reel._id.toString(),
    metadata: { model: resolveModels("cheap").llm, length: thumbnailText.length },
  });
  await reel.save();
  return reel;
}

/** Paid, explicit re-generation for an already-reviewed Reel. It replaces
 * only the YouTube Shorts title and description. Upload tags, thumbnail,
 * Instagram caption, and every rendered output deliberately remain intact. */
export async function regenerateReelReviewCopy(reelId: string): Promise<IReel> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");

  // Completed reels normally have a review package. Keep this endpoint safe
  // for legacy records without silently rebuilding a thumbnail or Instagram
  // caption (both are separate paid/intentional actions).
  const savedTags = reel.review?.tags?.length ? [...reel.review.tags] : undefined;
  const tags = savedTags ? normalizeTags(savedTags) : reviewTagsForReel(reel);
  const current: IReelReviewPackage = reel.review ?? {
    tags: savedTags ?? tags,
    status: "ready",
    updatedAt: new Date(),
  };
  const measuredCosts: MeasuredCostInput[] = [];
  const { title, description } = await buildReviewCopy(reel, tags, (usage) => {
    measuredCosts.push({
      label: usage.label,
      model: usage.model,
      costUsd: usage.costUsd,
      source: "actual",
    });
  });

  reel.review = {
    ...current,
    title,
    description,
    // Never rewrite the user-managed upload-tag field as a side effect of
    // copy regeneration. `tags` above is only the normalized prompt input.
    tags: savedTags ?? tags,
    updatedAt: new Date(),
  };
  reel.markModified("review");
  applyMeasuredCostsToReel(reel, measuredCosts, "YouTube review copy");
  recordOperationLog({
    scope: "system",
    event: "youtube.review_copy_generated",
    message: "Generated YouTube Shorts title and description",
    reelId: reel._id.toString(),
    metadata: {
      model: config.openRouterModel,
      titleLength: title.length,
      descriptionLength: description.length,
      tagCount: (savedTags ?? tags).length,
    },
  });
  await reel.save();
  return reel;
}

export async function updateReelReview(
  reelId: string,
  input: UpdateReelReviewInput
): Promise<IReelReviewPackage> {
  if (input.title !== undefined && input.title.length > 100) throw new Error("YouTube titles are limited to 100 characters");
  if (input.description !== undefined && input.description.length > 5000) throw new Error("YouTube descriptions are limited to 5,000 characters");
  if (input.thumbnailText !== undefined && input.thumbnailText.length > 60) throw new Error("Thumbnail hook text is limited to 60 characters");
  const hashtagCount = `${input.title ?? ""} ${input.description ?? ""}`.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0;
  if (hashtagCount > 60) throw new Error("YouTube ignores all hashtags when a video contains more than 60");
  if (input.tags && input.tags.join(",").length > 500) throw new Error("YouTube upload tags are limited to 500 total characters");
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  const current = reel.review ?? (await buildReelReviewPackage(reel));
  const shouldReclaimCaches = input.status === "approved" && current.status !== "approved";
  reel.review = {
    ...current,
    ...input,
    tags: input.tags ? normalizeTags(input.tags) : current.tags,
    updatedAt: new Date(),
  };
  if (input.thumbnailText !== undefined) {
    reel.thumbnailHook = cleanThumbnailText(input.thumbnailText);
  }
  const releasedUrls = shouldReclaimCaches ? reclaimApprovedRenderCaches(reel) : [];
  await reel.save();
  if (shouldReclaimCaches) {
    const cleanup = await deleteS3Urls(releasedUrls);
    recordOperationLog({
      scope: "system",
      level: cleanup.failed ? "warn" : "info",
      event: "reel.approved_render_caches_reclaimed",
      message: cleanup.failed
        ? "Final approval preserved publishable outputs, but some rebuild caches could not be deleted"
        : "Final approval preserved publishable outputs and reclaimed rebuild caches",
      reelId: reel._id.toString(),
      metadata: {
        ...cleanup,
        retained: ["primary_final_video", "destination_final_videos", "review_thumbnail", "shorts_cover", "voice_variants"],
      },
    });
  }
  recordOperationLog({
    scope: "system",
    event: "youtube.review_metadata_saved",
    message: "Saved YouTube publishing metadata",
    reelId: reel._id.toString(),
    metadata: {
      titleLength: reel.review.title?.length ?? 0,
      descriptionLength: reel.review.description?.length ?? 0,
      thumbnailTextLength: reel.review.thumbnailText?.length ?? 0,
      tagCount: reel.review.tags.length,
    },
  });
  return reel.review;
}

export async function regenerateReelThumbnail(
  reelId: string,
  input: UpdateReelReviewInput = {}
): Promise<IReelReviewPackage> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");

  const current = reel.review ?? (await buildReelReviewPackage(reel));
  const nextReview: IReelReviewPackage = {
    ...current,
    ...input,
    tags: input.tags ? normalizeTags(input.tags) : current.tags,
    status: input.status ?? current.status,
    updatedAt: new Date(),
  };

  const title = (nextReview.title || buildTitle(reel)).slice(0, 100);
  const thumbnailText = cleanThumbnailText(nextReview.thumbnailText || title) || fallbackThumbnailText(reel);
  const subtitle = reel.partNumber && reel.partCount ? `Part ${reel.partNumber} of ${reel.partCount}` : "Full story";
  const thumbnailPrompt = nextReview.thumbnailPrompt || (await buildThumbnailPrompt(reel));
  nextReview.title = title;
  nextReview.thumbnailText = thumbnailText;
  nextReview.thumbnailPrompt = thumbnailPrompt;
  reel.thumbnailHook = thumbnailText;
  const measuredCosts: MeasuredCostInput[] = [];
  const thumbnailPath = await renderThumbnailPng(
    thumbnailText,
    subtitle,
    reel.niche,
    thumbnailPrompt,
    (usage) => {
      measuredCosts.push({
        label: "Thumbnail image",
        model: resolveModels("cheap").image,
        costUsd: usage.costUsd,
        source: usage.costUsd !== undefined ? "actual" : "estimated",
      });
    },
  );
  try {
    applyMeasuredCostsToReel(reel, measuredCosts, "Thumbnail regen");
    return await replaceReviewThumbnail(reel, nextReview, thumbnailPath);
  } finally {
    await unlink(thumbnailPath).catch(() => {});
  }
}

function thumbnailCompositeFilter({ width, height }: { width: number; height: number }): string {
  return `split=2[bg][fg];[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=28,eq=brightness=-0.08:saturation=0.85[back];[fg]scale=-2:${height}:force_original_aspect_ratio=decrease[front];[back][front]overlay=(W-w)/2:(H-h)/2`;
}

function extractVideoFrame(
  videoUrl: string,
  atSeconds: number,
  output: string,
  aspectRatio?: ThumbnailAspectRatio
): Promise<string> {
  const size = thumbnailSize(aspectRatio);
  return new Promise((resolve, reject) => {
    ffmpeg(videoUrl)
      .seekInput(Math.max(atSeconds, 0))
      .outputOptions([
        "-vframes", "1",
        "-vf",
        thumbnailCompositeFilter(size),
      ])
      .output(output)
      .on("end", () => resolve(output))
      .on("error", (err) => reject(new Error(`Frame extraction failed: ${err.message}`)))
      .run();
  });
}

function composeStillImageThumbnail(
  imageUrl: string,
  output: string,
  aspectRatio?: ThumbnailAspectRatio
): Promise<string> {
  const size = thumbnailSize(aspectRatio);
  return new Promise((resolve, reject) => {
    ffmpeg(imageUrl)
      .outputOptions([
        "-vframes",
        "1",
        "-vf",
        thumbnailCompositeFilter(size),
      ])
      .output(output)
      .on("end", () => resolve(output))
      .on("error", (err) => reject(new Error(`Still thumbnail render failed: ${err.message}`)))
      .run();
  });
}

/** Upload a composed thumbnail PNG to S3 as the review thumbnail and delete
 *  the object it replaces (if any) so superseded thumbnails never pile up. */
export async function replaceReviewThumbnail(
  reel: IReel,
  current: IReelReviewPackage,
  imagePath: string
): Promise<IReelReviewPackage> {
  const previousThumbnailUrl = current.thumbnailUrl;
  const thumbnailUrl = await uploadImage(await readFile(imagePath), "reels", `${reel._id}_thumbnail.png`);
  reel.review = { ...current, thumbnailUrl, updatedAt: new Date() };
  await reel.save();
  if (previousThumbnailUrl && previousThumbnailUrl !== thumbnailUrl) {
    await deleteS3Urls([previousThumbnailUrl]);
  }
  return reel.review;
}

/** Use a specific frame of the rendered video as the thumbnail instead of an
 * AI/flat design — handy when a genuine reaction/moment in the footage beats
 * a generated composite. */
export async function useReelFrameAsThumbnail(
  reelId: string,
  atSeconds: number,
  aspectRatio?: ThumbnailAspectRatio
): Promise<IReelReviewPackage> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  if (!reel.outputUrl) throw new Error("Reel has no rendered video yet");

  const current = reel.review ?? (await buildReelReviewPackage(reel));
  await ensureDir(config.processingPath);
  const framePath = join(config.processingPath, generateFilename("thumb_frame", "png"));

  try {
    await extractVideoFrame(reel.outputUrl, atSeconds, framePath, aspectRatio);
    return await replaceReviewThumbnail(reel, current, framePath);
  } finally {
    await unlink(framePath).catch(() => {});
  }
}

/** Use one of the generated scene stills directly as the thumbnail source.
 * This avoids burned captions/subtitles from the final rendered video. */
export async function useReelSceneImageAsThumbnail(
  reelId: string,
  sceneIndex: number,
  aspectRatio?: ThumbnailAspectRatio
): Promise<IReelReviewPackage> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");

  const scene = reel.scenes?.find((s) => s.index === sceneIndex);
  const draftScene = reel.editDraft?.sceneAssets.find((s) => s.index === sceneIndex);
  const imageSource = draftScene?.assetPath ?? draftScene?.assetUrl ?? scene?.assetUrl;
  if (!imageSource) throw new Error("Scene has no still image asset");

  const current = reel.review ?? (await buildReelReviewPackage(reel));
  await ensureDir(config.processingPath);
  const framePath = join(config.processingPath, generateFilename("thumb_scene", "png"));

  try {
    await composeStillImageThumbnail(imageSource, framePath, aspectRatio);
    return await replaceReviewThumbnail(reel, current, framePath);
  } finally {
    await unlink(framePath).catch(() => {});
  }
}

export async function previewReelFrameThumbnail(
  reelId: string,
  atSeconds: number,
  aspectRatio?: ThumbnailAspectRatio
): Promise<string> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  if (!reel.outputUrl) throw new Error("Reel has no rendered video yet");

  await ensureDir(config.processingPath);
  const framePath = join(config.processingPath, generateFilename("thumb_preview", "png"));
  try {
    await extractVideoFrame(reel.outputUrl, atSeconds, framePath, aspectRatio);
    const buffer = await readFile(framePath);
    return `data:image/png;base64,${buffer.toString("base64")}`;
  } finally {
    await unlink(framePath).catch(() => {});
  }
}

export interface ThumbnailSourceInput {
  sourceType: "frame" | "scene" | "saved";
  atSeconds?: number;
  sceneIndex?: number;
  aspectRatio?: ThumbnailAspectRatio;
  cleanGameplay?: boolean;
  includeTitleCard?: boolean;
  includeShortsCover?: boolean;
}

const CLEAN_GAMEPLAY_PREVIEW_CACHE_MAX = 48;
const cleanGameplayPreviewCache = new Map<string, string>();

function cleanGameplayPreviewKey(reel: IReel, input: ThumbnailSourceInput): string {
  const story = reel.redditStory;
  return [
    reel.gameplayKey,
    (input.atSeconds ?? 0).toFixed(1),
    input.aspectRatio ?? "9:16",
    story?.title ?? reel.title,
    story?.subreddit,
    story?.cardUsername ?? story?.author,
    story?.ageHours,
    story?.upvotes,
    story?.comments,
    input.includeTitleCard !== false,
    input.includeShortsCover === true ? reel.shortsCover?.imageUrl ?? "" : "",
  ].join("|");
}

/** Render an aspect-corrected background source for the client-side Thumbnail
 *  Studio canvas (returned as a data URL, nothing persisted). Routing remote
 *  images (scene stills, the saved S3 thumbnail) through the server keeps the
 *  editor canvas CORS-clean so it can export a PNG. */
export async function previewThumbnailSource(
  reelId: string,
  input: ThumbnailSourceInput
): Promise<string> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");

  await ensureDir(config.processingPath);
  const outPath = join(config.processingPath, generateFilename("thumb_source", "png"));
  try {
    if (input.sourceType === "frame") {
      if (input.cleanGameplay && reel.strategy === "gameplay_overlay") {
        const cacheKey = cleanGameplayPreviewKey(reel, input);
        const cached = cleanGameplayPreviewCache.get(cacheKey);
        if (cached) {
          // Refresh insertion order so frequently scrubbed frames survive.
          cleanGameplayPreviewCache.delete(cacheKey);
          cleanGameplayPreviewCache.set(cacheKey, cached);
          return cached;
        }
        await renderCleanGameplayTitlePreview(
          reel,
          input.atSeconds ?? 0,
          outPath,
          input.aspectRatio,
          input.includeTitleCard !== false,
          input.includeShortsCover === true,
        );
        const buffer = await readFile(outPath);
        const dataUrl = `data:image/png;base64,${buffer.toString("base64")}`;
        cleanGameplayPreviewCache.set(cacheKey, dataUrl);
        if (cleanGameplayPreviewCache.size > CLEAN_GAMEPLAY_PREVIEW_CACHE_MAX) {
          const oldest = cleanGameplayPreviewCache.keys().next().value;
          if (oldest) cleanGameplayPreviewCache.delete(oldest);
        }
        return dataUrl;
      } else {
        if (!reel.outputUrl) throw new Error("Reel has no rendered video yet");
        await extractVideoFrame(reel.outputUrl, input.atSeconds ?? 0, outPath, input.aspectRatio);
      }
    } else if (input.sourceType === "scene") {
      await composeStillImageThumbnail(sceneImageSource(reel, input.sceneIndex), outPath, input.aspectRatio);
    } else {
      const saved = reel.review?.thumbnailUrl;
      if (!saved) throw new Error("Reel has no saved thumbnail yet");
      await composeStillImageThumbnail(saved, outPath, input.aspectRatio);
    }
    const buffer = await readFile(outPath);
    return `data:image/png;base64,${buffer.toString("base64")}`;
  } finally {
    await unlink(outPath).catch(() => {});
  }
}

async function renderCleanGameplayTitlePreview(
  reel: IReel,
  atSeconds: number,
  output: string,
  aspectRatio?: ThumbnailAspectRatio,
  includeTitleCard = true,
  includeShortsCover = false,
): Promise<void> {
  if (!reel.gameplayKey) throw new Error("Reel has no original gameplay clip");
  const framePath = join(config.processingPath, generateFilename("clean_gameplay", "png"));
  const story = reel.redditStory;
  const count = (value: number | undefined): string | undefined => {
    if (!Number.isFinite(value)) return undefined;
    if (value! >= 1_000_000) return `${(value! / 1_000_000).toFixed(1)}m`;
    if (value! >= 1_000) return `${(value! / 1_000).toFixed(1)}k`;
    return String(Math.round(value!));
  };
  const card = includeTitleCard
    ? await renderRedditCard(story?.title ?? reel.title ?? "Reddit story", {
        subreddit: story?.subreddit,
        username: story?.cardUsername ?? (story?.author ? `u/${story.author.replace(/^u\//, "")}` : undefined),
        ageHours: story?.ageHours,
        upvotes: count(story?.upvotes),
        comments: count(story?.comments),
      })
    : undefined;
  const shortsCoverUrl = includeShortsCover ? reel.shortsCover?.imageUrl : undefined;
  try {
    // pickGameplay resolves to the existing local clip cache, downloading the
    // S3 object only once. Repeated timeline scrubs therefore seek local disk.
    const gameplay = await pickGameplay(reel.gameplayKey);
    await extractVideoFrame(gameplay.path, atSeconds, framePath, aspectRatio);
    const size = thumbnailSize(aspectRatio ?? "9:16");
    const x = card ? Math.round((size.width - card.width) / 2) : 0;
    await new Promise<void>((resolve, reject) => {
      const command = ffmpeg().input(framePath);
      if (card) command.input(card.path);
      if (shortsCoverUrl) command.input(shortsCoverUrl);
      const baseLabel = card ? "card" : "base";
      const filters = [
        card ? `[0:v][1:v]overlay=${x}:250[card]` : `[0:v]null[base]`,
      ];
      if (shortsCoverUrl) {
        const coverInput = card ? 2 : 1;
        filters.push(`[${baseLabel}][${coverInput}:v]overlay=0:0[cover]`);
      }
      command
        .complexFilter(filters, [shortsCoverUrl ? "cover" : baseLabel])
        .outputOptions(["-frames:v", "1"])
        .output(output)
        .on("end", () => resolve())
        .on("error", (error) => reject(new Error(`Clean gameplay preview failed: ${error.message}`)))
        .run();
    });
  } finally {
    await Promise.all((card ? [framePath, card.path] : [framePath]).map((path) => unlink(path).catch(() => {})));
  }
}

export type ThumbnailTextEffect =
  | "none"
  | "shadow"
  | "glow"
  | "neon"
  | "impact"
  | "pill"
  | "outline"
  | "pop"
  | "box";

export type ThumbnailPhotoLook =
  | "none"
  | "vivid"
  | "cinematic"
  | "noir"
  | "warm"
  | "cool"
  | "punch";

export interface CustomThumbnailInput {
  atSeconds: number;
  sourceType?: "frame" | "scene";
  sceneIndex?: number;
  text?: string;
  aspectRatio?: ThumbnailAspectRatio;
  xPct?: number;
  yPct?: number;
  widthPct?: number;
  align?: "left" | "center" | "right";
  lineHeight?: number;
  effect?: ThumbnailTextEffect;
  photoLook?: ThumbnailPhotoLook;
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  outlineColor?: string;
  outlineWidth?: number;
  position?: "top" | "middle" | "bottom";
  uppercase?: boolean;
}

function sceneImageSource(reel: IReel, sceneIndex: number | undefined): string {
  const index = sceneIndex ?? reel.scenes?.find((s) => s.assetUrl)?.index ?? 0;
  const scene = reel.scenes?.find((s) => s.index === index);
  const draftScene = reel.editDraft?.sceneAssets.find((s) => s.index === index);
  const imageSource = draftScene?.assetPath ?? draftScene?.assetUrl ?? scene?.assetUrl;
  if (!imageSource) throw new Error("Scene has no still image asset");
  return imageSource;
}

async function buildThumbnailSource(
  reel: IReel,
  input: CustomThumbnailInput,
  output: string
): Promise<string> {
  if (input.sourceType === "scene") {
    await composeStillImageThumbnail(sceneImageSource(reel, input.sceneIndex), output, input.aspectRatio);
    return output;
  }
  if (!reel.outputUrl) throw new Error("Reel has no rendered video yet");
  await extractVideoFrame(reel.outputUrl, input.atSeconds, output, input.aspectRatio);
  return output;
}

/** #RRGGBB → ffmpeg drawtext color (0xRRGGBB). Falls back to white. */
function hexToDrawColor(hex?: string, fallback = "0xFFFFFF"): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex ?? "");
  return m ? `0x${m[1].toUpperCase()}` : fallback;
}

/** Compose a thumbnail PNG at `outputPath` from the chosen source (video frame
 *  or scene still), flattening the text overlay in when text is present.
 *  Shared by the one-shot save/preview endpoints and Thumbnail Studio draft
 *  staging. Every intermediate file is deleted before returning. */
export async function composeThumbnailImage(
  reel: IReel,
  input: CustomThumbnailInput,
  outputPath: string
): Promise<string> {
  await ensureDir(config.processingPath);
  if (!input.text?.trim()) {
    return buildThumbnailSource(reel, input, outputPath);
  }
  const textPath = join(config.processingPath, generateFilename("thumb_text", "txt"));
  await writeFile(textPath, wrapThumbnailText(input), "utf-8");
  const drawtext = thumbnailDrawtext(input, textPath);
  try {
    if (input.sourceType === "scene") {
      await composeStillWithText(
        sceneImageSource(reel, input.sceneIndex),
        outputPath,
        drawtext,
        input
      );
    } else {
      if (!reel.outputUrl) throw new Error("Reel has no rendered video yet");
      await extractFrameWithText(
        reel.outputUrl,
        input.atSeconds,
        outputPath,
        drawtext,
        input
      );
    }
    return outputPath;
  } finally {
    await unlink(textPath).catch(() => {});
  }
}

/** Manual thumbnail: a chosen video frame + custom overlay caption text in a
 *  bundled font. A human alternative to the AI thumbnail — the user picks the
 *  frame, the words, the font, size, color, and vertical position. */
export async function useReelFrameWithText(
  reelId: string,
  input: CustomThumbnailInput
): Promise<IReelReviewPackage> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  const current = reel.review ?? (await buildReelReviewPackage(reel));
  await ensureDir(config.processingPath);
  const framePath = join(config.processingPath, generateFilename("thumb_custom", "png"));

  try {
    await composeThumbnailImage(reel, input, framePath);
    return await replaceReviewThumbnail(reel, current, framePath);
  } finally {
    await unlink(framePath).catch(() => {});
  }
}

export async function previewReelFrameWithText(
  reelId: string,
  input: CustomThumbnailInput
): Promise<string> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  await ensureDir(config.processingPath);
  const framePath = join(config.processingPath, generateFilename("thumb_custom_preview", "png"));

  try {
    await composeThumbnailImage(reel, input, framePath);
    const buffer = await readFile(framePath);
    return `data:image/png;base64,${buffer.toString("base64")}`;
  } finally {
    await unlink(framePath).catch(() => {});
  }
}

function drawtextDecoration(effect: ThumbnailTextEffect, outlineWidth: number): string {
  switch (effect) {
    case "none":
    case "outline":
      return "";
    case "pop":
      return "shadowcolor=0x000000@0.88:shadowx=5:shadowy=5:";
    case "impact":
      return `borderw=${Math.max(outlineWidth, 10)}:shadowcolor=0x000000@0.92:shadowx=4:shadowy=5:`;
    case "pill":
      return "box=1:boxcolor=0x000000@0.72:boxborderw=28:";
    case "box":
      return "box=1:boxcolor=0x000000@0.48:boxborderw=18:";
    case "glow":
    case "neon":
      return "";
    default:
      return "shadowcolor=0x000000@0.68:shadowx=3:shadowy=4:";
  }
}

function thumbnailDrawtext(input: CustomThumbnailInput, textPath: string): string {
  const size = thumbnailSize(input.aspectRatio);
  const fontFile =
    fontFilePathByFamily(input.fontFamily) ??
    fontFilePathByFamily(DEFAULT_BUNDLED_FONT_FAMILY);
  if (!fontFile) {
    throw new Error(
      `No bundled font file for "${input.fontFamily ?? DEFAULT_BUNDLED_FONT_FAMILY}" — run \`bun run fetch-fonts\` in server/`
    );
  }
  const fontSize = Math.min(Math.max(input.fontSize ?? 96, 20), 400);
  const color = hexToDrawColor(input.color, "0xFFFFFF");
  const outlineColor = hexToDrawColor(input.outlineColor, "0x000000");
  const effect = input.effect ?? "shadow";
  const outlineWidth =
    effect === "impact"
      ? Math.min(Math.max(input.outlineWidth ?? 4, 8), 30)
      : effect === "outline"
        ? Math.min(Math.max(input.outlineWidth ?? 4, 6), 30)
        : Math.min(Math.max(input.outlineWidth ?? 4, 0), 30);
  const xPct = input.xPct ?? 0.5;
  const yPct = input.yPct ?? 0.7;
  const widthPct = input.widthPct ?? 0.82;
  const boxW = Math.round(widthPct * size.width);
  const boxLeft = Math.max(0, Math.min(size.width - 1, Math.round(xPct * size.width - boxW / 2)));
  const align = input.align ?? "center";
  const xExpr =
    align === "left"
      ? `${boxLeft}`
      : align === "right"
        ? `max(${boxLeft},${boxLeft + boxW}-text_w)`
        : `max(${boxLeft},min(${boxLeft + boxW}-text_w,w*${xPct}-text_w/2))`;
  const yExpr = `h*${yPct}+${Math.round(fontSize * 0.82)}`;
  const lineSpacing = Math.round(fontSize * ((input.lineHeight ?? 1.12) - 1));
  const decoration = drawtextDecoration(effect, outlineWidth);

  return [
    "drawtext=",
    `fontfile='${escapeFilterPath(fontFile)}':`,
    `textfile='${escapeFilterPath(textPath)}':`,
    `fontsize=${fontSize}:`,
    `fontcolor=${color}:`,
    `borderw=${outlineWidth}:bordercolor=${outlineColor}:`,
    decoration,
    `line_spacing=${lineSpacing}:`,
    "fix_bounds=1:",
    `x=${xExpr}:y=${yExpr}`,
  ].join("");
}

function wrapThumbnailText(input: CustomThumbnailInput): string {
  const size = thumbnailSize(input.aspectRatio);
  const fontSize = Math.min(Math.max(input.fontSize ?? 96, 20), 400);
  const boxWidth = (input.widthPct ?? 0.82) * size.width;
  const maxChars = Math.max(4, Math.floor(boxWidth / (fontSize * 0.55)));
  const text = input.text ?? "";
  const raw = input.uppercase ? text.toUpperCase() : text;

  const breakLongWord = (word: string): string[] => {
    if (word.length <= maxChars) return [word];
    const chunks: string[] = [];
    for (let i = 0; i < word.length; i += maxChars) {
      chunks.push(word.slice(i, i + maxChars));
    }
    return chunks;
  };

  return raw
    .split("\n")
    .flatMap((line) => {
      const words = line.trim().split(/\s+/).filter(Boolean);
      if (words.length === 0) return [""];
      const out: string[] = [];
      let current = "";
      for (const word of words) {
        for (const piece of breakLongWord(word)) {
          const next = current ? `${current} ${piece}` : piece;
          if (next.length > maxChars && current) {
            out.push(current);
            current = piece;
          } else {
            current = next;
          }
        }
      }
      if (current) out.push(current);
      return out;
    })
    .join("\n");
}

function composeStillWithText(
  imageUrl: string,
  output: string,
  drawtext: string,
  input: CustomThumbnailInput
): Promise<string> {
  const size = thumbnailSize(input.aspectRatio);
  const vf = thumbnailTextFilter(size, drawtext, input.effect, input.photoLook);
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(imageUrl);
    applyOutputOptions(cmd, ["-vframes", "1", "-vf", vf])
      .output(output)
      .on("end", () => resolve(output))
      .on("error", (err: Error) => reject(new Error(`Still thumbnail render failed: ${err.message}`)))
      .run();
  });
}

function photoLookFilter(look?: ThumbnailPhotoLook): string {
  switch (look) {
    case "vivid":
      return "eq=saturation=1.45:contrast=1.12:brightness=0.02";
    case "punch":
      return "eq=saturation=1.28:contrast=1.2,unsharp=5:5:0.85:5:5:0";
    case "cinematic":
      return "eq=saturation=0.82:contrast=1.18:brightness=-0.06";
    case "noir":
      return "hue=s=0,eq=contrast=1.3:brightness=-0.03";
    case "warm":
      return "colortemperature=6200";
    case "cool":
      return "colortemperature=11000";
    default:
      return "";
  }
}

function thumbnailTextFilter(
  size: { width: number; height: number },
  drawtext: string,
  effect?: CustomThumbnailInput["effect"],
  photoLook?: CustomThumbnailInput["photoLook"]
): string {
  const base = thumbnailCompositeFilter(size);
  const grade = photoLookFilter(photoLook);
  const mid = grade ? `${base},${grade}` : base;
  if (effect === "glow" || effect === "neon") {
    const glow = drawtext
      .replace(/borderw=\d+/, effect === "neon" ? "borderw=26" : "borderw=22")
      .replace(/fontcolor=[^:]+/, effect === "neon" ? "fontcolor=0xFFFFFF@0.38" : "fontcolor=0xFFFFFF@0.25");
    return `${mid},${glow},${drawtext}`;
  }
  return `${mid},${drawtext}`;
}

/** Same base composition as extractVideoFrame, with a drawtext overlay appended. */
function extractFrameWithText(
  videoUrl: string,
  atSeconds: number,
  output: string,
  drawtext: string,
  input: Pick<CustomThumbnailInput, "aspectRatio" | "effect" | "photoLook">
): Promise<string> {
  const size = thumbnailSize(input.aspectRatio);
  const vf = thumbnailTextFilter(size, drawtext, input.effect, input.photoLook);
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(videoUrl).seekInput(Math.max(atSeconds, 0));
    applyOutputOptions(cmd, ["-vframes", "1", "-vf", vf])
      .output(output)
      .on("end", () => resolve(output))
      .on("error", (err: Error) => reject(new Error(`Custom thumbnail render failed: ${err.message}`)))
      .run();
  });
}
