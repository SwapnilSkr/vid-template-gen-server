import { readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Reel, type IReel, type IVoiceVariant } from "../models";
import { resolveModels, type Tier } from "../config/models";
import { getRecipe } from "../config/niche-styles";
import { getErrorMessage } from "../types";
import { cleanupFiles } from "../utils";
import { pickGameplay, renderGameplayReel } from "./reel-gameplay.service";
import { deleteFromS3, uploadVideo } from "./s3.service";
import { enqueueRevoice } from "../queue/queues";

// ============================================
// Revoice — re-narrate an already-rendered gameplay_overlay reel with a
// different TTS model/voice, reusing the exact same story + gameplay clip.
// Several voices can be requested at once; each becomes a `voiceVariant`
// rendered independently so they can be compared before one is promoted to
// `reel.outputUrl`. Mirrors the publish queue: a separate stage that reads
// already-generated inputs and never re-spends on the LLM/story/gameplay pick.
// ============================================

export interface RevoiceVariantInput {
  model?: string;
  voice?: string;
  format?: "mp3" | "pcm";
  label?: string;
}

/** Register 1-5 pending voice variants and enqueue their render. */
export async function requestRevoice(
  reelId: string,
  variants: RevoiceVariantInput[]
): Promise<IReel> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  if (reel.strategy !== "gameplay_overlay") {
    throw new Error("Revoice is only supported for gameplay_overlay (Reddit) reels");
  }
  if (reel.status !== "completed") {
    throw new Error(`Reel must be completed before revoicing (current status: ${reel.status})`);
  }
  if (!reel.redditStory) throw new Error("Reel has no story to re-narrate");

  const fallback = resolveModels(reel.tier as Tier).tts;
  const created: IVoiceVariant[] = variants.map((v) => ({
    id: randomUUID(),
    model: v.model || fallback.model,
    voice: v.voice || fallback.voice,
    format: v.format || fallback.format,
    label: v.label,
    status: "pending",
    createdAt: new Date(),
  }));

  reel.voiceVariants.push(...created);
  await reel.save();

  await enqueueRevoice(
    reelId,
    created.map((v) => v.id)
  );
  return reel;
}

/** Render each pending variant in turn (invoked by the revoice worker). */
export async function processRevoice(reelId: string, variantIds: string[]): Promise<void> {
  const reel = await Reel.findById(reelId);
  if (!reel || !reel.redditStory) return;

  const { path: gameplayPath, key: gameplayKey } = await pickGameplay(reel.gameplayKey);
  if (!reel.gameplayKey) {
    reel.gameplayKey = gameplayKey;
    await reel.save();
  }
  const recipe = getRecipe(reel.niche);

  for (const variantId of variantIds) {
    const localFiles: string[] = [];
    const variant = reel.voiceVariants.find((v) => v.id === variantId);
    if (!variant) continue;

    try {
      // Match the studio plan: spoken body from sentence scenes + caption style.
      const bodySentences = reel.scenes.map((s) => s.narration.trim()).filter(Boolean);
      const result = await renderGameplayReel(`${reelId}_voice_${variantId}`, reel.redditStory, gameplayPath, {
        model: variant.model,
        voice: variant.voice,
        format: variant.format,
        bodySentences: bodySentences.length ? bodySentences : undefined,
        captionStyle: reel.captionStyle,
      });
      localFiles.push(result.videoPath, result.assPath);

      const buffer = await readFile(result.videoPath);
      variant.videoUrl = await uploadVideo(buffer, "reels", `${reelId}_voice_${variantId}.mp4`);
      variant.status = "ready";
      console.log(`🗣️  Revoice ready: ${reelId} [${variant.model}/${variant.voice}] (${recipe.niche})`);
    } catch (error: unknown) {
      variant.status = "failed";
      variant.error = getErrorMessage(error);
      console.error(`❌ Revoice failed: ${reelId}/${variantId}: ${variant.error}`);
    } finally {
      await cleanupFiles(localFiles);
      await reel.save();
    }
  }

  // Same clip served every variant above — drop the local cache now that this
  // batch is done. S3 stays the source of truth (pickGameplay re-downloads on demand).
  await unlink(gameplayPath).catch(() => {});
}

/** Promote a ready voice variant to be the reel's primary output. Also adopts
 *  the variant's TTS choice so later re-renders (title card / captions / clip)
 *  keep the same voice instead of snapping back to the previous narrator.
 *  The video it replaces is deleted from S3 unless it is itself a variant's
 *  render (still referenced for comparison). */
export async function promoteVoiceVariant(reelId: string, variantId: string): Promise<IReel> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");

  const variant = reel.voiceVariants.find((v) => v.id === variantId);
  if (!variant) throw new Error("Voice variant not found");
  if (variant.status !== "ready" || !variant.videoUrl) {
    throw new Error(`Voice variant is not ready (status: ${variant.status})`);
  }

  const previousOutputUrl = reel.outputUrl;
  reel.outputUrl = variant.videoUrl;
  reel.narrationVoice = {
    model: variant.model,
    voice: variant.voice,
    format: variant.format,
  };
  reel.voiceOverride = {
    model: variant.model,
    voice: variant.voice,
    format: variant.format,
  };
  await reel.save();

  const stillReferenced =
    !previousOutputUrl ||
    previousOutputUrl === variant.videoUrl ||
    reel.voiceVariants.some((v) => v.videoUrl === previousOutputUrl);
  if (!stillReferenced && previousOutputUrl) {
    await deleteFromS3(previousOutputUrl).catch((error) => {
      console.warn(`Could not delete superseded output for reel ${reelId}: ${getErrorMessage(error)}`);
    });
  }
  return reel;
}
