import ffmpeg from "fluent-ffmpeg";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { ensureDir } from "../utils";
import {
  getAudioDuration,
  generateMotionClip,
  type MediaUsageCallback,
} from "./openrouter-media.service";
import {
  W,
  H,
  FPS,
  TAIL,
  XFADE,
  EDGE_FADE,
  assembleCrossfade,
  applyHorrorFinalMix,
  buildPortraitKaraoke,
  burnSubtitles,
  type SceneTiming,
  type RenderResult,
} from "./reel-render.service";
import type { ISceneMotion, ICaptionStyle } from "../models";

// ============================================
// Motion engine — animates each scene's still into REAL movement instead of a
// flat Ken Burns pan. Two per-scene motion types:
//
//  - "parallax": FFmpeg-only "living still". A sinusoidal, multi-axis drifting
//    zoompan (breathing push + lateral/vertical sway) reads as a floating,
//    parallax-y shot — clearly more alive than the single-direction Ken Burns
//    push — at ZERO extra cost. Default for every horror scene.
//
//  - "ai_motion": a genuine image-to-video clip. The scene's already-uploaded
//    still (S3 URL) is sent as the first frame to OpenRouter /videos, so the
//    generated motion inherits the reference-art look baked into the still.
//    Expensive + slow, so the orchestrator gates it to the hook + climax
//    (motionMode "ai_hybrid") or the whole reel ("ai_full").
//
// Assembly, captions, and the horror final mix are reused verbatim from
// reel-render.service so this stays a thin per-scene branch, not a fork.
// ============================================

export interface MotionScene {
  imagePath: string; // local still (used for parallax)
  assetUrl?: string; // S3/CDN URL of the still → first frame for image-to-video
  audioPath: string;
  narration: string;
  visualPrompt: string; // prompt passed to the video model
  motion: ISceneMotion;
}

export interface MotionRenderOptions {
  videoModel?: string;
  horrorEffects?: boolean;
  comicEffects?: boolean;
  horrorAudioKey?: string;
  captionStyle?: ICaptionStyle;
  /** per-scene image-to-video generation cost (fed into the cost ledger) */
  onMotionUsage?: (index: number, usage: Parameters<MediaUsageCallback>[0]) => void;
}

export async function renderMotionReel(
  reelId: string,
  scenes: MotionScene[],
  options: MotionRenderOptions = {}
): Promise<RenderResult> {
  await ensureDir(config.processingPath);
  const tmp: string[] = [];
  try {
    return await renderMotionReelInner(reelId, scenes, options, tmp);
  } finally {
    await Promise.all(tmp.map((f) => unlink(f).catch(() => {})));
  }
}

async function renderMotionReelInner(
  reelId: string,
  scenes: MotionScene[],
  options: MotionRenderOptions,
  tmp: string[]
): Promise<RenderResult> {
  const timings: SceneTiming[] = [];

  // 1. Per-scene clip: parallax (free) or ai_motion (image-to-video).
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const speech = await getAudioDuration(scene.audioPath);
    const d = +(speech + TAIL).toFixed(2);
    const frames = Math.round(d * FPS);
    const clipPath = join(config.processingPath, `${reelId}_mscene${i}.mp4`);

    const progress = scenes.length > 1 ? i / (scenes.length - 1) : 0;
    const style: LivingStillStyle = {
      grainIntensity: 1.25 + progress * 1.1,
      vignetteDivisor: Math.max(4.6 - progress * 1.9, 2.8),
      desaturateBoost: Math.min(0.12 + progress * 0.18, 0.32),
      comicInk: options.comicEffects,
    };

    if (scene.motion.type === "ai_motion") {
      await renderAiMotionClip(scene, d, frames, clipPath, i, options);
    } else {
      await renderLivingStillClip(scene, d, frames, clipPath, style);
    }

    timings.push({ clipPath, narration: scene.narration, d, speech, startTime: 0 });
    tmp.push(clipPath);
    console.log(`🎞️  Motion scene ${i} [${scene.motion.type}]: ${d}s (${frames}f)`);
  }

  // 2. Crossfaded timeline (same math as image_kenburns).
  const n = timings.length;
  const overlap = n > 1 ? XFADE : 0;
  let cumulative = 0;
  for (let i = 0; i < n; i++) {
    timings[i].startTime = +(cumulative - i * overlap).toFixed(3);
    cumulative += timings[i].d;
  }
  const totalDuration = +(cumulative - (n - 1) * overlap).toFixed(3);

  // 3. Assemble + captions + horror mix (all reused).
  const joinedPath = join(config.processingPath, `${reelId}_joined.mp4`);
  await assembleCrossfade(timings, totalDuration, joinedPath);
  tmp.push(joinedPath);

  const assContent = buildPortraitKaraoke(
    timings.map((t) => ({ text: t.narration, startTime: t.startTime, speech: t.speech })),
    options.captionStyle
  );
  const assPath = join(config.processingPath, `${reelId}.ass`);
  await writeFile(assPath, assContent, "utf-8");

  const captionedPath = join(config.processingPath, `${reelId}_captioned.mp4`);
  await burnSubtitles(joinedPath, assPath, captionedPath, EDGE_FADE);
  tmp.push(captionedPath);

  const finalPath = join(config.processingPath, `${reelId}_final.mp4`);
  if (options.horrorEffects) {
    await applyHorrorFinalMix(captionedPath, finalPath, tmp, options.horrorAudioKey, timings, options.comicEffects);
  } else {
    await copyThrough(captionedPath, finalPath);
  }

  return {
    videoPath: finalPath,
    assPath,
    scenes: timings.map((t) => ({ startTime: t.startTime, duration: t.d })),
    totalDuration,
  };
}

interface LivingStillStyle {
  grainIntensity?: number;
  vignetteDivisor?: number;
  desaturateBoost?: number;
  comicInk?: boolean;
}

/**
 * FFmpeg "living still" — a breathing, multi-axis drifting frame. Unlike Ken
 * Burns (one monotonic direction), the zoom and the x/y crop centre each follow
 * gentle out-of-phase sinusoids, so the shot floats and sways like a slow
 * parallax move. Drift amplitudes are kept well inside the pan headroom from
 * the 2x upscale so the crop window never clamps (which would cause jitter).
 */
export function renderLivingStillClip(
  scene: MotionScene,
  d: number,
  frames: number,
  out: string,
  style: LivingStillStyle = {}
): Promise<string> {
  const N = Math.max(frames, 1);
  const amp = 0.5 + (scene.motion.intensity ?? 0.5); // 1.0 default multiplier
  // Breathing zoom (always >= 1) + lateral/vertical sway, out of phase.
  const z = `1.16+${(0.045 * amp).toFixed(4)}*sin(2*PI*on/${N})`;
  const x = `iw/2-(iw/zoom/2)+(iw*${(0.02 * amp).toFixed(4)})*sin(2*PI*on/${N})`;
  const y = `ih/2-(ih/zoom/2)+(ih*${(0.015 * amp).toFixed(4)})*cos(2*PI*on/${Math.round(N * 1.3)})`;

  const grain = Math.round(9 * (style.grainIntensity ?? 1));
  const vignetteDivisor = style.vignetteDivisor ?? 5;
  const saturation = Math.max(0.9 - (style.desaturateBoost ?? 0), 0.2);
  const contrast = style.comicInk ? 1.18 : 1.06;

  const filters = [
    `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase`,
    `crop=${W * 2}:${H * 2}`,
    `zoompan=z='${z}':d=${N}:x='${x}':y='${y}':s=${W}x${H}:fps=${FPS}`,
    grain > 0 ? `noise=alls=${grain}:allf=t` : null,
    `vignette=PI/${vignetteDivisor}`,
    `eq=contrast=${contrast.toFixed(2)}:saturation=${saturation.toFixed(2)}`,
    style.comicInk ? "unsharp=5:5:0.85:3:3:0.3" : null,
    style.comicInk ? `drawbox=x=28:y=28:w=iw-56:h=ih-56:color=black@0.72:t=8` : null,
    `format=yuv420p`,
    `trim=end_frame=${N}`,
    `setpts=PTS-STARTPTS`,
  ]
    .filter(Boolean)
    .join(",");

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(scene.imagePath)
      .inputOptions(["-loop", "1", "-framerate", String(FPS)])
      .input(scene.audioPath)
      .outputOptions([
        "-vf", filters,
        "-frames:v", String(N),
        "-af", `apad,atrim=0:${d.toFixed(2)},asetpts=PTS-STARTPTS`,
        "-r", String(FPS),
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-ar", "44100",
      ])
      .output(out)
      .on("end", () => resolve(out))
      .on("error", (err) => reject(new Error(`Living-still render failed: ${err.message}`)))
      .run();
  });
}

/**
 * Generate a real image-to-video clip from the scene's still, then fit it to
 * the narration duration (loop if short, trim if long) and attach the audio.
 * Falls back to a living-still parallax clip if generation fails, so one flaky
 * video job never sinks a whole reel that has already paid for stills + TTS.
 */
async function renderAiMotionClip(
  scene: MotionScene,
  d: number,
  frames: number,
  out: string,
  index: number,
  options: MotionRenderOptions
): Promise<void> {
  if (!scene.assetUrl) {
    console.warn(`Scene ${index} has no still URL for image-to-video; using parallax instead`);
    await renderLivingStillClip(scene, d, frames, out);
    return;
  }
  let rawPath: string | undefined;
  try {
    const generated = await generateMotionClip(scene.visualPrompt || scene.narration, {
      model: options.videoModel,
      durationSec: Math.min(Math.max(Math.round(d), 4), 8),
      aspectRatio: "9:16",
      frameImageUrl: scene.assetUrl,
      onUsage: (usage) => options.onMotionUsage?.(index, usage),
    });
    rawPath = generated.videoPath;
    await fitMotionClip(rawPath, scene.audioPath, d, frames, out);
  } catch (error: unknown) {
    console.warn(
      `Image-to-video failed for scene ${index} (${error instanceof Error ? error.message : String(error)}); falling back to parallax`
    );
    await renderLivingStillClip(scene, d, frames, out);
  } finally {
    if (rawPath) await unlink(rawPath).catch(() => {});
  }
}

/** Fit a raw AI video clip to the scene's narration-driven length + attach audio. */
function fitMotionClip(
  rawVideoPath: string,
  audioPath: string,
  d: number,
  frames: number,
  out: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(rawVideoPath)
      .inputOptions(["-stream_loop", "-1"]) // loop if the AI clip is shorter than needed
      .input(audioPath)
      .outputOptions([
        "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS}`,
        "-frames:v", String(frames),
        "-af", `apad,atrim=0:${d.toFixed(2)},asetpts=PTS-STARTPTS`,
        "-map", "0:v",
        "-map", "1:a",
        "-r", String(FPS),
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-ar", "44100",
      ])
      .output(out)
      .on("end", () => resolve(out))
      .on("error", (err) => reject(new Error(`Motion clip fit failed: ${err.message}`)))
      .run();
  });
}

function copyThrough(input: string, output: string): Promise<string> {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .outputOptions(["-c", "copy", "-movflags", "+faststart"])
      .output(output)
      .on("end", () => resolve(output))
      .on("error", (err) => reject(new Error(`Motion final copy failed: ${err.message}`)))
      .run();
  });
}
