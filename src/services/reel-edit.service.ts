import { Reel, type IReel, type ICaptionStyle, type IAudioPost, type IEditEffects, type ISceneMotion, type ReelMotionMode } from "../models";
import { enqueueReelPlan, enqueueReelProduce } from "../queue/queues";

// ============================================
// Studio editing — human-in-the-loop scene/settings/caption edits + surgical
// regeneration. Clearing a scene's assetUrl/audioUrl (via $unset so it's truly
// removed from Mongo, not left stale) makes the produce stage regenerate ONLY
// that piece; leaving assets intact makes a re-render reuse everything (free
// for parallax/ken_burns). See reel.service.produceImageReel.
// ============================================

const ACTIVE_STATUSES: IReel["status"][] = [
  "planning",
  "generating_assets",
  "generating_audio",
  "aligning",
  "rendering",
  "uploading",
];

function assertEditable(reel: IReel): void {
  if (ACTIVE_STATUSES.includes(reel.status)) {
    throw new Error(`Cannot edit while generation is active (status: ${reel.status})`);
  }
}

async function loadReel(reelId: string): Promise<IReel> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  return reel;
}

/** Per-scene motion type for a reel's motion mode (mirrors reel.service). */
function motionTypeFor(mode: ReelMotionMode, i: number, total: number): ISceneMotion["type"] {
  switch (mode) {
    case "ai_full":
      return "ai_motion";
    case "ai_hybrid":
      return i === 0 || i === total - 1 ? "ai_motion" : "parallax";
    case "parallax":
      return "parallax";
    case "ken_burns":
    default:
      return "ken_burns";
  }
}

function reindex(reel: IReel): void {
  reel.scenes.forEach((scene, i) => {
    scene.index = i;
  });
  reel.markModified("scenes");
}

/** Mark the reel as queued for a produce run (assets/render). */
async function markQueued(reelId: string): Promise<void> {
  await Reel.updateOne(
    { _id: reelId },
    { $set: { status: "generating_assets", progress: 15 }, $unset: { error: "" } }
  );
}

// ---- Scene edits ----

export async function updateScene(
  reelId: string,
  index: number,
  patch: { narration?: string; visualPrompt?: string; motion?: Partial<ISceneMotion> }
): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertEditable(reel);
  const scene = reel.scenes[index];
  if (!scene) throw new Error(`Scene ${index} not found`);
  if (patch.narration !== undefined) scene.narration = patch.narration;
  if (patch.visualPrompt !== undefined) scene.visualPrompt = patch.visualPrompt;
  if (patch.motion) scene.motion = { ...scene.motion, ...patch.motion };
  reel.markModified("scenes");
  await reel.save();
  return reel;
}

/** Clear the chosen asset(s) for one scene and queue a produce run — only that
 *  scene's image/audio regenerates; everything else is reused. */
export async function regenerateScene(
  reelId: string,
  index: number,
  targets: ("image" | "audio")[]
): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertEditable(reel);
  if (!reel.scenes[index]) throw new Error(`Scene ${index} not found`);

  const unset: Record<string, ""> = {};
  if (targets.includes("image")) unset[`scenes.${index}.assetUrl`] = "";
  if (targets.includes("audio")) unset[`scenes.${index}.audioUrl`] = "";
  await Reel.updateOne({ _id: reelId }, { $unset: unset });

  await markQueued(reelId);
  await enqueueReelProduce(reelId);
  return loadReel(reelId);
}

export async function addScene(
  reelId: string,
  narration: string,
  visualPrompt?: string,
  atIndex?: number
): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertEditable(reel);
  const at = Math.min(Math.max(atIndex ?? reel.scenes.length, 0), reel.scenes.length);
  const mode = (reel.motionMode ?? "ken_burns") as ReelMotionMode;
  reel.scenes.splice(at, 0, {
    index: at,
    narration,
    visualPrompt: visualPrompt?.trim() || narration,
    motion: { type: motionTypeFor(mode, at, reel.scenes.length + 1), direction: "in" },
    startTime: 0,
    duration: 0,
    isHero: false,
  });
  reindex(reel);
  await reel.save();
  return reel;
}

export async function removeScene(reelId: string, index: number): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertEditable(reel);
  if (!reel.scenes[index]) throw new Error(`Scene ${index} not found`);
  if (reel.scenes.length <= 1) throw new Error("A reel must keep at least one scene");
  reel.scenes.splice(index, 1);
  reindex(reel);
  await reel.save();
  return reel;
}

export async function reorderScenes(reelId: string, order: number[]): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertEditable(reel);
  const n = reel.scenes.length;
  const valid =
    order.length === n && new Set(order).size === n && order.every((i) => i >= 0 && i < n);
  if (!valid) throw new Error("order must be a permutation of the current scene indices");
  reel.scenes = order.map((i) => reel.scenes[i]);
  reindex(reel);
  await reel.save();
  return reel;
}

// ---- Reel-level settings ----

export async function updateReelSettings(
  reelId: string,
  patch: {
    artStyleId?: string;
    motionMode?: ReelMotionMode;
    imageModel?: string;
    horrorAudioKey?: string;
    horrorReferenceId?: string;
    voice?: { model?: string; voice?: string; format?: "mp3" | "pcm" };
    audioPost?: IAudioPost;
    editEffects?: IEditEffects;
  }
): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertEditable(reel);
  const prevArt = reel.artStyleId;
  const prevModel = reel.imageModelOverride;

  if (patch.artStyleId !== undefined) reel.artStyleId = patch.artStyleId;
  if (patch.imageModel !== undefined) reel.imageModelOverride = patch.imageModel;
  if (patch.horrorAudioKey !== undefined) reel.horrorAudioKey = patch.horrorAudioKey;
  if (patch.horrorReferenceId !== undefined) reel.horrorReferenceId = patch.horrorReferenceId;
  if (patch.voice !== undefined) reel.voiceOverride = patch.voice;
  if (patch.audioPost !== undefined) reel.audioPost = patch.audioPost;
  // Edit FX are render-only — no assets to clear, just re-render to apply.
  if (patch.editEffects !== undefined) {
    reel.editEffects = patch.editEffects;
    reel.markModified("editEffects");
  }
  if (patch.motionMode !== undefined) {
    reel.motionMode = patch.motionMode;
    reel.scenes.forEach((scene, i) => {
      scene.motion = { ...scene.motion, type: motionTypeFor(patch.motionMode!, i, reel.scenes.length) };
    });
    reel.markModified("scenes");
  }
  await reel.save();

  // Changing the art style or image model invalidates the stills; a new voice
  // invalidates the narration. Clear so the next produce regenerates them.
  const clearsImages =
    (patch.artStyleId !== undefined && patch.artStyleId !== prevArt) ||
    (patch.imageModel !== undefined && patch.imageModel !== prevModel);
  const clearsAudio = patch.voice !== undefined;
  const unset: Record<string, ""> = {};
  if (clearsImages) unset["scenes.$[].assetUrl"] = "";
  if (clearsAudio) unset["scenes.$[].audioUrl"] = "";
  if (Object.keys(unset).length) await Reel.updateOne({ _id: reelId }, { $unset: unset });

  return loadReel(reelId);
}

/** Manual (non-AI) caption look edit — merges over the current style. Applied on
 *  the next render (render-only re-burn, free for parallax/ken_burns). */
export async function updateCaptions(reelId: string, patch: ICaptionStyle): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertEditable(reel);
  reel.captionStyle = { ...(reel.captionStyle ?? {}), ...patch };
  reel.markModified("captionStyle");
  await reel.save();
  return reel;
}

// ---- Regeneration control ----

/** Queue a produce run. `render_only` reuses every asset (free re-render for
 *  caption/mix edits); `assets` clears all stills+narration to regenerate them. */
export async function regenerateReel(reelId: string, mode: "render_only" | "assets"): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertEditable(reel);
  if (reel.scenes.length === 0) throw new Error("Nothing to regenerate — plan the reel first");
  if (mode === "assets") {
    await Reel.updateOne(
      { _id: reelId },
      { $unset: { "scenes.$[].assetUrl": "", "scenes.$[].audioUrl": "" } }
    );
  }
  await markQueued(reelId);
  await enqueueReelProduce(reelId);
  return loadReel(reelId);
}

/** Approve a reviewed plan → run the produce stage. */
export async function approvePlan(reelId: string): Promise<IReel> {
  const reel = await loadReel(reelId);
  if (reel.status !== "plan_review") {
    throw new Error(`Reel is not awaiting plan review (status: ${reel.status})`);
  }
  await markQueued(reelId);
  await enqueueReelProduce(reelId);
  return loadReel(reelId);
}

/** Discard the current plan and re-plan (new story / reference / pasted script). */
export async function replanReel(
  reelId: string,
  patch: { topic?: string; providedScript?: string; horrorReferenceId?: string }
): Promise<IReel> {
  const reel = await loadReel(reelId);
  assertEditable(reel);
  if (patch.topic !== undefined) reel.topic = patch.topic;
  if (patch.providedScript !== undefined) reel.providedScript = patch.providedScript;
  if (patch.horrorReferenceId !== undefined) reel.horrorReferenceId = patch.horrorReferenceId;
  reel.scenes = [];
  reel.title = undefined;
  reel.hook = undefined;
  reel.status = "planning";
  reel.progress = 5;
  reel.error = undefined;
  await reel.save();
  await enqueueReelPlan(reelId);
  return loadReel(reelId);
}
