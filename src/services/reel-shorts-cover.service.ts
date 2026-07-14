import { readFile, unlink } from "node:fs/promises";
import { Reel, type IReel } from "../models";
import { deleteS3Urls, uploadImage } from "./s3.service";
import { redditShortsCoverHeadline, renderRedditOpeningShortsCover } from "./reddit-card.service";

const PNG_MAGIC = 0x89504e47;
const MAX_BYTES = 12 * 1024 * 1024;
const AUTO_REDDIT_OPENING_PREFIX = "reddit-opening-cover:";
const AUTO_REDDIT_OPENING_FINGERPRINT = "reddit-opening-cover:v3:";

function redditOpeningFingerprint(reel: IReel): string {
  const story = reel.redditStory;
  return `${AUTO_REDDIT_OPENING_FINGERPRINT}${[
    story?.title ?? reel.title ?? "",
    reel.thumbnailHook ?? "",
    story?.subreddit ?? "",
    story?.cardUsername ?? story?.author ?? "",
    story?.ageHours ?? "",
    story?.upvotes ?? "",
    story?.comments ?? "",
    reel.partNumber ?? story?.partNumber ?? 1,
    reel.partCount ?? story?.partCount ?? 1,
  ].join("|")}`;
}

function isAutomaticRedditOpening(reel: IReel): boolean {
  return Boolean(reel.shortsCover?.sourceFingerprint?.startsWith(AUTO_REDDIT_OPENING_PREFIX));
}

/** Covers saved by the initial opening-cover rollout were all marked as
 * replacing the card. That layout is now invalid: retain the card and migrate
 * these generated/legacy defaults to the lower safe band on next plan/produce. */
function isLegacyCardReplacingCover(reel: IReel): boolean {
  return reel.shortsCover?.sourceType === "reddit_title_card" &&
    reel.shortsCover.replacesTitleCard === true;
}

/**
 * Give every planned Reddit reel a real opening cover before video rendering.
 * A manually saved cover is always respected; automatic covers are refreshed
 * when a re-plan changes the story/card metadata.
 */
export async function ensureDefaultRedditOpeningCover(reel: IReel): Promise<void> {
  if (reel.strategy !== "gameplay_overlay" || !reel.redditStory?.title) return;
  const fingerprint = redditOpeningFingerprint(reel);
  if (
    reel.shortsCover?.imageUrl &&
    !isAutomaticRedditOpening(reel) &&
    !isLegacyCardReplacingCover(reel)
  ) return;
  if (reel.shortsCover?.imageUrl && reel.shortsCover.sourceFingerprint === fingerprint) return;

  const story = reel.redditStory;
  const headline = redditShortsCoverHeadline(reel.thumbnailHook || story.title);
  const cardPath = await renderRedditOpeningShortsCover(story.title, {
    headline,
    partNumber: reel.partNumber ?? story.partNumber,
    partCount: reel.partCount ?? story.partCount,
  });
  try {
    const imageUrl = await uploadImage(await readFile(cardPath), "reels", `${reel._id}_shorts_cover.png`);
    const previous = reel.shortsCover?.imageUrl;
    reel.shortsCover = {
      imageUrl,
      sourceType: "reddit_title_card",
      placement: "opening",
      replacesTitleCard: false,
      holdSeconds: 0.75,
      editorState: automaticOpeningCoverEditorState(headline),
      sourceFingerprint: fingerprint,
      updatedAt: new Date(),
    };
    reel.markModified("shortsCover");
    if (previous && previous !== imageUrl) await deleteS3Urls([previous]);
  } finally {
    await unlink(cardPath).catch(() => {});
  }
}

function automaticOpeningCoverEditorState(headline: string): Record<string, unknown> {
  return {
    version: 2,
    aspectRatio: "9:16",
    background: { sourceType: "frame", atSeconds: 0, brightness: 1, contrast: 1, saturation: 1, hue: 0, grayscale: 0, sepia: 0, blur: 0, temperature: 0, vignette: 0, grain: 0, overlayId: "none", overlayOpacity: 0 },
    layers: [{ id: "reddit-opening-headline", type: "text", text: headline, x: 0.5, y: 0.66, widthPct: 0.82, rotation: 0, opacity: 1, fontFamily: "Anton", sizePct: headline.length > 45 ? 0.068 : 0.078, fill: { type: "solid", color: "#ffffff" }, strokeColor: "#000000", strokePct: 0.1, align: "center", lineHeight: 1.05, letterSpacing: 0, uppercase: true, shadowColor: "#000000", shadowBlurPct: 0.12, shadowXPct: 0, shadowYPct: 0.06, glowColor: "#ffffff", glowStrength: 0, extrudeDepthPct: 0, extrudeColor: "#000000", glitch: false, bgColor: "#000000", bgOpacity: 0.64, bgRadiusPct: 0.28, bgPadPct: 0.28, styleId: "classic" }],
  };
}

export async function saveShortsCover(reelId: string, input: {
  imageDataUrl: string;
  sourceType: "reddit_title_card" | "scene" | "video_frame";
  sceneIndex?: number;
  atSeconds?: number;
  placement?: "opening" | "source_scene";
  replacesTitleCard?: boolean;
  holdSeconds?: number;
  editorState?: Record<string, unknown>;
  sourceFingerprint?: string;
}): Promise<IReel> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(input.imageDataUrl);
  if (!match) throw new Error("imageDataUrl must be a base64 PNG data URL");
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== PNG_MAGIC) throw new Error("Invalid PNG");
  if (bytes.length > MAX_BYTES) throw new Error("Shorts cover is too large (max 12MB)");
  if (input.sourceType === "scene" && !reel.scenes.some((scene) => scene.index === input.sceneIndex)) {
    throw new Error("Cover scene does not exist");
  }
  const previous = reel.shortsCover?.imageUrl;
  const imageUrl = await uploadImage(bytes, "reels", `${reel._id}_shorts_cover.png`);
  reel.shortsCover = {
    imageUrl,
    sourceType: input.sourceType,
    sceneIndex: input.sceneIndex,
    atSeconds: input.atSeconds,
    placement: input.placement ?? (reel.niche.startsWith("horror") ? "source_scene" : "opening"),
    replacesTitleCard: input.replacesTitleCard ?? false,
    holdSeconds: input.holdSeconds ?? 0.75,
    editorState: input.editorState,
    sourceFingerprint: input.sourceFingerprint,
    updatedAt: new Date(),
  };
  reel.markModified("shortsCover");
  await reel.save();
  if (previous && previous !== imageUrl) await deleteS3Urls([previous]);
  return reel;
}

export async function clearShortsCover(reelId: string): Promise<IReel> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  const previous = reel.shortsCover?.imageUrl;
  reel.shortsCover = undefined;
  reel.markModified("shortsCover");
  await reel.save();
  if (previous) await deleteS3Urls([previous]);
  return reel;
}
