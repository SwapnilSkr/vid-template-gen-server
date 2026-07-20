import { readFile, unlink } from "node:fs/promises";
import { Reel, type IReel, type IShortsCover } from "../models/reel.model";
import { deleteS3Urls, uploadImage } from "./s3.service";
import { redditShortsCoverHeadline, renderRedditOpeningShortsCover } from "./reddit-card.service";

const PNG_MAGIC = 0x89504e47;
const MAX_BYTES = 12 * 1024 * 1024;
const AUTO_REDDIT_OPENING_PREFIX = "reddit-opening-cover:";
/** Identity-only fingerprint — title/hook/part labels. Vanity card stats must
 *  not force a regenerate on Generate. */
const AUTO_REDDIT_OPENING_FINGERPRINT = "reddit-opening-cover:v4:";

function redditOpeningFingerprint(reel: IReel): string {
  const story = reel.redditStory;
  return `${AUTO_REDDIT_OPENING_FINGERPRINT}${[
    story?.title ?? reel.title ?? "",
    reel.thumbnailHook ?? "",
    reel.partNumber ?? story?.partNumber ?? 1,
    reel.partCount ?? story?.partCount ?? 1,
  ].join("|")}`;
}

export function isAutomaticRedditOpening(reel: IReel): boolean {
  return Boolean(reel.shortsCover?.sourceFingerprint?.startsWith(AUTO_REDDIT_OPENING_PREFIX));
}

/** Covers saved by the initial opening-cover rollout were all marked as
 * replacing the card. That layout is now invalid: retain the card and migrate
 * these generated/legacy defaults to the lower safe band on next plan/produce. */
function isLegacyCardReplacingCover(reel: IReel): boolean {
  return reel.shortsCover?.sourceType === "reddit_title_card" &&
    reel.shortsCover.replacesTitleCard === true;
}

/** Creator-saved Thumbnail Studio covers (and any non-auto cover). Never wipe. */
export function isCreatorOwnedShortsCover(reel: IReel): boolean {
  const cover = reel.shortsCover;
  if (!cover?.imageUrl && !cover?.editorState) return false;
  if (isAutomaticRedditOpening(reel)) return false;
  if (isLegacyCardReplacingCover(reel)) return false;
  return true;
}

/**
 * Give every planned Reddit reel a real opening cover before video rendering.
 * Never replaces a cover that already exists — Generate / Keep current / Use AI
 * must not clobber Thumbnail Studio saves or a prior auto cover the creator kept.
 */
export async function ensureDefaultRedditOpeningCover(reel: IReel): Promise<void> {
  if (reel.strategy !== "gameplay_overlay" || !reel.redditStory?.title) return;
  if (isCreatorOwnedShortsCover(reel)) return;
  if (reel.shortsCover?.imageUrl && !isLegacyCardReplacingCover(reel)) {
    // Existing auto cover: only refresh when title/hook/part identity changed.
    await refreshAutomaticOpeningCoverIfStale(reel);
    return;
  }
  await renderAndAssignAutomaticOpeningCover(reel);
}

/** Refresh an automatic cover after title/hook/part changes. No-op for manual. */
export async function refreshAutomaticOpeningCoverIfStale(reel: IReel): Promise<void> {
  if (reel.strategy !== "gameplay_overlay" || !reel.redditStory?.title) return;
  if (isCreatorOwnedShortsCover(reel)) return;
  if (!isAutomaticRedditOpening(reel) && !isLegacyCardReplacingCover(reel)) return;
  const fingerprint = redditOpeningFingerprint(reel);
  if (reel.shortsCover?.imageUrl && reel.shortsCover.sourceFingerprint === fingerprint) return;
  await renderAndAssignAutomaticOpeningCover(reel);
}

async function renderAndAssignAutomaticOpeningCover(reel: IReel): Promise<void> {
  const story = reel.redditStory;
  if (!story?.title) return;
  const fingerprint = redditOpeningFingerprint(reel);
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
    layers: [{ id: "reddit-opening-headline", type: "text", text: headline, x: 0.5, y: 0.66, widthPct: 0.82, rotate: 0, opacity: 1, fontFamily: "Anton", sizePct: headline.length > 45 ? 0.068 : 0.078, fill: { type: "solid", color: "#ffffff" }, strokeColor: "#000000", strokePct: 0.1, align: "center", lineHeight: 1.05, letterSpacing: 0, uppercase: true, shadowColor: "#000000", shadowBlurPct: 0.12, shadowXPct: 0, shadowYPct: 0.06, glowColor: "#ffffff", glowStrength: 0, extrudeDepthPct: 0, extrudeColor: "#000000", glitch: false, bgColor: "#000000", bgOpacity: 0.64, bgRadiusPct: 0.28, bgPadPct: 0.28, styleId: "classic" }],
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
  // Thumbnail Studio saves must never be classified as automatic, even if the
  // client omits a fingerprint — otherwise the next Generate regenerates them.
  const sourceFingerprint =
    input.sourceFingerprint && !input.sourceFingerprint.startsWith(AUTO_REDDIT_OPENING_PREFIX)
      ? input.sourceFingerprint
      : `manual:${input.sourceType}:${input.atSeconds ?? input.sceneIndex ?? "cover"}`;
  reel.shortsCover = {
    imageUrl,
    sourceType: input.sourceType,
    sceneIndex: input.sceneIndex,
    atSeconds: input.atSeconds,
    placement: input.placement ?? (reel.niche.startsWith("horror") ? "source_scene" : "opening"),
    replacesTitleCard: input.replacesTitleCard ?? false,
    holdSeconds: input.holdSeconds ?? 0.75,
    editorState: input.editorState,
    sourceFingerprint,
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

/** Snapshot a creator-owned cover so replan/restructure can restore it after reset. */
export function snapshotCreatorShortsCover(reel: IReel): IShortsCover | undefined {
  if (!isCreatorOwnedShortsCover(reel) || !reel.shortsCover?.imageUrl) return undefined;
  // Mongoose subdocs do not spread cleanly — a shallow `{ ...subdoc }` can drop
  // imageUrl, then reset deletes the S3 object while saving an empty cover.
  const raw = reel.shortsCover as IShortsCover & { toObject?: () => IShortsCover };
  const plain = typeof raw.toObject === "function" ? raw.toObject() : { ...raw };
  if (!plain.imageUrl) return undefined;
  return {
    imageUrl: plain.imageUrl,
    sourceType: plain.sourceType,
    sceneIndex: plain.sceneIndex,
    atSeconds: plain.atSeconds,
    placement: plain.placement ?? "opening",
    replacesTitleCard: plain.replacesTitleCard ?? false,
    holdSeconds: plain.holdSeconds ?? 0.75,
    editorState: plain.editorState,
    sourceFingerprint: plain.sourceFingerprint,
    updatedAt: plain.updatedAt ?? new Date(),
  };
}
