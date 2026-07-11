import { Reel, type IReel } from "../models";
import { deleteFromS3, uploadImage } from "./s3.service";

const PNG_MAGIC = 0x89504e47;
const MAX_BYTES = 12 * 1024 * 1024;

export async function saveShortsCover(reelId: string, input: {
  imageDataUrl: string;
  sourceType: "reddit_title_card" | "scene" | "video_frame";
  sceneIndex?: number;
  atSeconds?: number;
  placement?: "opening" | "source_scene";
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
    holdSeconds: input.holdSeconds ?? 0.75,
    editorState: input.editorState,
    sourceFingerprint: input.sourceFingerprint,
    updatedAt: new Date(),
  };
  reel.markModified("shortsCover");
  await reel.save();
  if (previous && previous !== imageUrl) await deleteFromS3(previous).catch(() => {});
  return reel;
}

export async function clearShortsCover(reelId: string): Promise<IReel> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  const previous = reel.shortsCover?.imageUrl;
  reel.shortsCover = undefined;
  reel.markModified("shortsCover");
  await reel.save();
  if (previous) await deleteFromS3(previous).catch(() => {});
  return reel;
}
