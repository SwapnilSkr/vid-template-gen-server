import { Resvg } from "@resvg/resvg-js";
import ffmpeg from "fluent-ffmpeg";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { resolveModels } from "../config/models";
import { Reel, type IReel, type IReelReviewPackage } from "../models";
import { getErrorMessage } from "../types";
import { ensureDir, escapeFilterPath, applyOutputOptions, generateFilename } from "../utils";
import { generateText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateImage, type MediaUsageCallback } from "./openrouter-media.service";
import { type LlmUsageCallback, reportLlmUsage } from "./reel-script.service";
import {
  applyMeasuredCostsToReel,
  type MeasuredCostInput,
} from "./reel-cost.service";
import { deleteFromS3, uploadImage } from "./s3.service";
import { renderRedditCard } from "./reddit-card.service";
import { pickGameplay } from "./reel-gameplay.service";
import { listTrendReferences } from "./trend-reference.service";
import { getTrendDigest } from "./trend-insight.service";
import { getRecipe } from "../config/niche-styles";
import { fontFilePathByFamily, DEFAULT_BUNDLED_FONT_FAMILY } from "../config/fonts";

export interface UpdateReelReviewInput {
  title?: string;
  description?: string;
  tags?: string[];
  thumbnailPrompt?: string;
  visibilityNotes?: string;
  status?: IReelReviewPackage["status"];
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

function formatHashtags(tags: string[]): string[] {
  return tags
    .map((tag) => tag.trim().replace(/^#/, ""))
    .filter(Boolean)
    .map((tag) => `#${tag}`);
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

function withTitleHashtags(baseTitle: string, hashtags: string[], maxLength = 100): string {
  const base = stripHashtagsFromText(baseTitle).trim();
  let result = base;
  for (const tag of hashtags) {
    const next = result ? `${result} ${tag}` : tag;
    if (next.length <= maxLength) {
      result = next;
    } else {
      break;
    }
  }
  return result.slice(0, maxLength);
}

function withDescriptionHashtags(description: string, hashtags: string[]): string {
  const managed = hashtags.length ? hashtags.join(" ") : "";
  const body = stripHashtagsFromText(description);
  return managed ? `${body}${body ? "\n\n" : ""}${managed}` : body;
}

async function buildReviewCopy(
  reel: IReel,
  tags: string[],
  onLlmUsage?: LlmUsageCallback,
): Promise<{ title: string; description: string }> {
  const hashtagStrings = formatHashtags(tags);
  const baseFallbackTitle = buildTitle(reel).slice(0, 100);
  const fallbackTitle = withTitleHashtags(baseFallbackTitle, hashtagStrings);
  const fallbackDescription = buildDescription(reel, baseFallbackTitle, tags);
  const source = storySeed(reel).slice(0, 2600);
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
    const { text, usage } = await generateText({
      model: openrouter(config.openRouterModel),
      prompt: `Write YouTube Shorts review copy for this ${nicheLabel}.

SOURCE STORY:
${source}

Rules:
- Output JSON only: {"title":"...","description":"..."}.
- Title must be specific to the conflict/twist, 50-80 characters, curiosity-gap style.
- Do not include hashtags in the title or description — those are appended separately.
- Avoid generic format words such as gameplay, AI, video generation, horror video, short-form, content, captions, or thumbnail.
- Do not invent facts not present in the source.
- Description should be 1-2 natural sentences only.
- Keep description under 500 characters.
- Include part info if the source says this is one part of a series.
- Make it punchy, human, and platform-ready, not templated slop.`,
    });
    reportLlmUsage(onLlmUsage, "Review copy", config.openRouterModel, usage);

    const parsed = extractReviewJson(text);
    const baseTitle = parsed.title ? stripHashtagsFromText(cleanTitle(parsed.title)) : baseFallbackTitle;
    const baseDescription = parsed.description
      ? stripHashtagsFromText(parsed.description.trim()).slice(0, 500)
      : "";
    const title = withTitleHashtags(baseTitle, hashtagStrings);
    const description = baseDescription
      ? withDescriptionHashtags(baseDescription, hashtagStrings)
      : fallbackDescription;
    return { title, description };
  } catch (error: unknown) {
    console.warn(`Review copy generation failed, using fallback: ${getErrorMessage(error)}`);
    return { title: fallbackTitle, description: fallbackDescription };
  }
}

function buildDescription(reel: IReel, title: string, tags: string[]): string {
  const part =
    reel.partNumber && reel.partCount && reel.partCount > 1
      ? `\n\nPart ${reel.partNumber} of ${reel.partCount}.`
      : "";
  const hashtags = tags.slice(0, 8).map((tag) => `#${tag}`).join(" ");

  if (reel.niche === "reddit") {
    const source = reel.redditStory?.subreddit ? `${reel.redditStory.subreddit} story` : "Reddit story";
    return `${title}\n\n${source} with gameplay, captions, and a fast hook.${part}\n\n${hashtags}`.trim();
  }

  const recipe = getRecipe(reel.niche);
  return `${title}\n\n${recipe.displayName} short.${part}\n\n${hashtags}`.trim();
}

async function buildThumbnailPrompt(reel: IReel, _title: string): Promise<string> {
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
    await Promise.all(localFiles.map((f) => unlink(f).catch(() => {})));
    return renderFlatThumbnailPng(title, subtitle, niche);
  }
}

export interface ReelReviewUsageCallbacks {
  onReviewCopyUsage?: LlmUsageCallback;
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
  const nicheTags = reel.niche === "reddit" ? DEFAULT_REDDIT_TAGS : isHorrorNiche(reel.niche) ? DEFAULT_HORROR_TAGS : [reel.niche];
  const tags = normalizeTags([
    reel.niche,
    reel.genre ?? "",
    reel.redditStory?.subreddit?.replace(/^r\//i, "") ?? "",
    ...nicheTags,
  ]);
  const { title, description } = await buildReviewCopy(reel, tags, callbacks.onReviewCopyUsage);
  const thumbnailPrompt = await buildThumbnailPrompt(reel, title);
  const visibilityNotes = await buildVisibilityNotes(reel);
  const subtitle = reel.partNumber && reel.partCount ? `Part ${reel.partNumber} of ${reel.partCount}` : "Full story";
  const thumbnailUrl =
    reel.thumbnailMode === "ai"
      ? await renderAndUploadThumbnail(reel, title, subtitle, thumbnailPrompt, callbacks.onThumbnailImageUsage)
      : undefined;

  return {
    title,
    description,
    tags,
    thumbnailUrl,
    thumbnailPrompt,
    visibilityNotes,
    status: "ready",
    updatedAt: new Date(),
  };
}

async function renderAndUploadThumbnail(
  reel: IReel,
  title: string,
  subtitle: string,
  thumbnailPrompt: string,
  onThumbnailImageUsage?: MediaUsageCallback
): Promise<string> {
  const thumbnailPath = await renderThumbnailPng(
    title,
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
  if (!reel.review?.title || (reel.thumbnailMode === "ai" && !reel.review.thumbnailUrl)) {
    const measuredCosts: MeasuredCostInput[] = [];
    reel.review = await buildReelReviewPackage(reel, {
      onReviewCopyUsage: (usage) => {
        measuredCosts.push({
          label: usage.label,
          model: usage.model,
          costUsd: usage.costUsd,
          source: "actual",
        });
      },
      onThumbnailImageUsage: (usage) => {
        measuredCosts.push({
          label: "Thumbnail image",
          model: resolveModels("cheap").image,
          costUsd: usage.costUsd,
          source: usage.costUsd !== undefined ? "actual" : "estimated",
        });
      },
    });
    applyMeasuredCostsToReel(reel, measuredCosts, "Review package");
    await reel.save();
  }
  return reel.review;
}

export async function updateReelReview(
  reelId: string,
  input: UpdateReelReviewInput
): Promise<IReelReviewPackage> {
  if (input.title !== undefined && input.title.length > 100) throw new Error("YouTube titles are limited to 100 characters");
  if (input.description !== undefined && input.description.length > 5000) throw new Error("YouTube descriptions are limited to 5,000 characters");
  const hashtagCount = `${input.title ?? ""} ${input.description ?? ""}`.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0;
  if (hashtagCount > 60) throw new Error("YouTube ignores all hashtags when a video contains more than 60");
  if (input.tags && input.tags.join(",").length > 500) throw new Error("YouTube upload tags are limited to 500 total characters");
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  const current = reel.review ?? (await buildReelReviewPackage(reel));
  reel.review = {
    ...current,
    ...input,
    tags: input.tags ? normalizeTags(input.tags) : current.tags,
    updatedAt: new Date(),
  };
  await reel.save();
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
  const subtitle = reel.partNumber && reel.partCount ? `Part ${reel.partNumber} of ${reel.partCount}` : "Full story";
  const thumbnailPrompt = nextReview.thumbnailPrompt || (await buildThumbnailPrompt(reel, title));
  nextReview.title = title;
  nextReview.thumbnailPrompt = thumbnailPrompt;
  const measuredCosts: MeasuredCostInput[] = [];
  const thumbnailPath = await renderThumbnailPng(
    title,
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
    await deleteFromS3(previousThumbnailUrl).catch((error) => {
      console.warn(`Could not delete previous thumbnail for reel ${reel._id}: ${getErrorMessage(error)}`);
    });
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
        await renderCleanGameplayTitlePreview(reel, input.atSeconds ?? 0, outPath, input.aspectRatio);
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
  const card = await renderRedditCard(story?.title ?? reel.title ?? "Reddit story", {
    subreddit: story?.subreddit,
    username: story?.cardUsername ?? (story?.author ? `u/${story.author.replace(/^u\//, "")}` : undefined),
    ageHours: story?.ageHours,
    upvotes: count(story?.upvotes),
    comments: count(story?.comments),
  });
  try {
    // pickGameplay resolves to the existing local clip cache, downloading the
    // S3 object only once. Repeated timeline scrubs therefore seek local disk.
    const gameplay = await pickGameplay(reel.gameplayKey);
    await extractVideoFrame(gameplay.path, atSeconds, framePath, aspectRatio);
    const size = thumbnailSize(aspectRatio ?? "9:16");
    const x = Math.round((size.width - card.width) / 2);
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(framePath)
        .input(card.path)
        .complexFilter(`[0:v][1:v]overlay=${x}:250[v]`, ["v"])
        .outputOptions(["-frames:v", "1"])
        .output(output)
        .on("end", () => resolve())
        .on("error", (error) => reject(new Error(`Clean gameplay preview failed: ${error.message}`)))
        .run();
    });
  } finally {
    await Promise.all([framePath, card.path].map((path) => unlink(path).catch(() => {})));
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
