import { Resvg } from "@resvg/resvg-js";
import ffmpeg from "fluent-ffmpeg";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { resolveModels } from "../config/models";
import { Reel, type IReel, type IReelReviewPackage } from "../models";
import { getErrorMessage } from "../types";
import { ensureDir, generateFilename } from "../utils";
import { generateText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateImage, type MediaUsageCallback } from "./openrouter-media.service";
import { uploadImage } from "./s3.service";
import { listTrendReferences } from "./trend-reference.service";
import { getTrendDigest } from "./trend-insight.service";
import { getRecipe } from "../config/niche-styles";

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

async function buildReviewCopy(reel: IReel, tags: string[]): Promise<{ title: string; description: string }> {
  const fallbackTitle = buildTitle(reel).slice(0, 100);
  const fallbackDescription = buildDescription(reel, fallbackTitle, tags);
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
    const { text } = await generateText({
      model: openrouter(config.openRouterModel),
      prompt: `Write YouTube Shorts review copy for this ${nicheLabel}.

SOURCE STORY:
${source}

Rules:
- Output JSON only: {"title":"...","description":"..."}.
- Title must be specific to the conflict/twist, 55-90 characters, curiosity-gap style.
- Avoid generic format words such as gameplay, AI, video generation, horror video, short-form, content, captions, or thumbnail.
- Do not invent facts not present in the source.
- Description should be 1-2 natural sentences plus relevant hashtags.
- Keep description under 500 characters.
- Include part info if the source says this is one part of a series.
- Make it punchy, human, and platform-ready, not templated slop.`,
    });

    const parsed = extractReviewJson(text);
    const title = parsed.title ? cleanTitle(parsed.title) : fallbackTitle;
    const description = parsed.description?.trim().slice(0, 500) || fallbackDescription;
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

async function buildThumbnailPrompt(reel: IReel, title: string): Promise<string> {
  const genre = reel.genre ? ` ${reel.genre.replace(/_/g, " ")}` : "";
  const digest = await getTrendDigest(reel.niche, reel.genre);
  const trendBlock = digest ? ` Reference these winning thumbnail/title patterns from top-performing videos in this genre: ${digest.replace(/\n/g, " ")}` : "";

  if (reel.niche === "reddit") {
    return `Bold Reddit Shorts thumbnail for a${genre} story: huge readable hook text, white Reddit post card, tense contrast, gameplay background, red-orange accent, no clutter. Title: "${title}".${trendBlock}`;
  }

  if (isHorrorNiche(reel.niche)) {
    const medium = reel.niche === "horror_comic" ? "2D horror comic panel" : "dark cinematic photoreal scene";
    return `Terrifying YouTube Shorts horror thumbnail for a${genre} story: ${medium}, single unsettling figure or silhouette half-lit, deep shadows, blood-red or sickly-green rim light, huge bold white hook text with black stroke, high contrast, unsettling composition, no clutter. Title: "${title}".${trendBlock}`;
  }

  const recipe = getRecipe(reel.niche);
  return `Bold YouTube Shorts thumbnail for a "${recipe.displayName}"${genre} video: cinematic dramatic scene, huge readable hook text, high contrast, no clutter. Title: "${title}".${trendBlock}`;
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
      "dramatic wide shot, high contrast, cinematic, YouTube thumbnail composition",
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

export async function buildReelReviewPackage(
  reel: IReel,
  onThumbnailImageUsage?: MediaUsageCallback
): Promise<IReelReviewPackage> {
  const nicheTags = reel.niche === "reddit" ? DEFAULT_REDDIT_TAGS : isHorrorNiche(reel.niche) ? DEFAULT_HORROR_TAGS : [reel.niche];
  const tags = normalizeTags([
    reel.niche,
    reel.genre ?? "",
    reel.redditStory?.subreddit?.replace(/^r\//i, "") ?? "",
    ...nicheTags,
  ]);
  const { title, description } = await buildReviewCopy(reel, tags);
  const thumbnailPrompt = await buildThumbnailPrompt(reel, title);
  const visibilityNotes = await buildVisibilityNotes(reel);
  const subtitle = reel.partNumber && reel.partCount ? `Part ${reel.partNumber} of ${reel.partCount}` : "Full story";
  const thumbnailUrl =
    reel.thumbnailMode === "ai"
      ? await renderAndUploadThumbnail(reel, title, subtitle, thumbnailPrompt, onThumbnailImageUsage)
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
    reel.review = await buildReelReviewPackage(reel);
    await reel.save();
  }
  return reel.review;
}

export async function updateReelReview(
  reelId: string,
  input: UpdateReelReviewInput
): Promise<IReelReviewPackage> {
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
  const thumbnailPath = await renderThumbnailPng(title, subtitle, reel.niche, thumbnailPrompt);
  try {
    nextReview.thumbnailUrl = await uploadImage(
      await readFile(thumbnailPath),
      "reels",
      `${reel._id}_thumbnail.png`
    );
  } finally {
    await unlink(thumbnailPath).catch(() => {});
  }
  nextReview.title = title;
  nextReview.thumbnailPrompt = thumbnailPrompt;

  reel.review = nextReview;
  await reel.save();
  return reel.review;
}

function extractVideoFrame(videoUrl: string, atSeconds: number, output: string): Promise<string> {
  return new Promise((resolve, reject) => {
    ffmpeg(videoUrl)
      .seekInput(Math.max(atSeconds, 0))
      .outputOptions([
        "-vframes", "1",
        "-vf",
        `split=2[bg][fg];[bg]scale=${THUMB_W}:${THUMB_H}:force_original_aspect_ratio=increase,crop=${THUMB_W}:${THUMB_H},gblur=sigma=28,eq=brightness=-0.08:saturation=0.85[back];[fg]scale=-2:${THUMB_H}:force_original_aspect_ratio=decrease[front];[back][front]overlay=(W-w)/2:(H-h)/2`,
      ])
      .output(output)
      .on("end", () => resolve(output))
      .on("error", (err) => reject(new Error(`Frame extraction failed: ${err.message}`)))
      .run();
  });
}

/** Use a specific frame of the rendered video as the thumbnail instead of an
 * AI/flat design — handy when a genuine reaction/moment in the footage beats
 * a generated composite. */
export async function useReelFrameAsThumbnail(
  reelId: string,
  atSeconds: number
): Promise<IReelReviewPackage> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  if (!reel.outputUrl) throw new Error("Reel has no rendered video yet");

  const current = reel.review ?? (await buildReelReviewPackage(reel));
  await ensureDir(config.processingPath);
  const framePath = join(config.processingPath, generateFilename("thumb_frame", "png"));

  try {
    await extractVideoFrame(reel.outputUrl, atSeconds, framePath);
    const thumbnailUrl = await uploadImage(await readFile(framePath), "reels", `${reel._id}_thumbnail.png`);

    reel.review = {
      ...current,
      thumbnailUrl,
      updatedAt: new Date(),
    };
    await reel.save();
    return reel.review;
  } finally {
    await unlink(framePath).catch(() => {});
  }
}
