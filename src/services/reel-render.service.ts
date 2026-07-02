import ffmpeg from "fluent-ffmpeg";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { ensureDir } from "../utils";
import { getAudioDuration } from "./openrouter-media.service";
import type { ISceneMotion } from "../models";

export const W = 1080;
export const H = 1920;
export const FPS = 30;

// Continuity tuning (fixes "too much gap" / "no natural flow"):
//  - TAIL: silent breathing room appended after each narration.
//  - XFADE: scenes crossfade into each other instead of cutting to black.
//    The crossfade is hidden inside TAIL so spoken words never overlap.
//    Effective silent gap between sentences = TAIL - XFADE (~0.1s) → tight.
export const TAIL = 0.45;
export const XFADE = 0.35;
export const EDGE_FADE = 0.4; // gentle fade from/to black at the very start/end only

export interface RenderScene {
  imagePath: string;
  audioPath: string;
  narration: string;
  motion: ISceneMotion;
}

export interface RenderResult {
  videoPath: string;
  assPath: string;
  scenes: { startTime: number; duration: number }[];
  totalDuration: number;
  heroVideoPath?: string;
}

export interface SceneTiming {
  clipPath: string;
  narration: string;
  d: number; // full clip duration (speech + TAIL)
  speech: number; // spoken audio duration (for caption timing)
  startTime: number; // resolved position on the crossfaded timeline
}

/**
 * Render a scene-graph reel: stills + Ken Burns + grain/vignette, narration,
 * crossfaded together, with length-weighted karaoke captions burned in.
 *
 * Sync / continuity correctness (render-lab findings):
 *  - Never `-shortest` with zoompan (under-counts frames → clipped audio +
 *    caption drift). Force video length with `-frames:v`, pad audio with
 *    `apad`+`atrim` so each scene's A/V are exactly equal.
 *  - Scenes CROSSFADE (xfade + acrossfade) rather than cut to black, and the
 *    overlap sits in the silent TAIL, so the video flows without dead air or
 *    black dips and no spoken words collide.
 *  - Caption timing is derived from ACTUAL per-scene speech duration and
 *    weighted by word length, so cues track real speech and never bleed into
 *    the next scene.
 */
export async function renderImageKenBurns(
  reelId: string,
  scenes: RenderScene[],
  styleTint = true
): Promise<RenderResult> {
  await ensureDir(config.processingPath);
  const tmp: string[] = [];

  try {
    return await renderImageKenBurnsInner(reelId, scenes, styleTint, tmp);
  } finally {
    // Cleanup must run even on failure — previously only ran on success,
    // leaving every intermediate scene clip behind in storage/processing/.
    await Promise.all(tmp.map((f) => unlink(f).catch(() => {})));
  }
}

async function renderImageKenBurnsInner(
  reelId: string,
  scenes: RenderScene[],
  styleTint: boolean,
  tmp: string[]
): Promise<RenderResult> {
  const timings: SceneTiming[] = [];

  // 1. Render each scene to its own clip (identical params → crossfade-safe).
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const speech = await getAudioDuration(scene.audioPath);
    const d = +(speech + TAIL).toFixed(2);
    const frames = Math.round(d * FPS);
    const clipPath = join(config.processingPath, `${reelId}_scene${i}.mp4`);

    await renderSceneClip(scene, d, frames, clipPath, styleTint);

    timings.push({ clipPath, narration: scene.narration, d, speech, startTime: 0 });
    tmp.push(clipPath);
    console.log(`🎞️  Scene ${i}: ${d}s speech=${speech.toFixed(2)}s (${frames}f)`);
  }

  // 2. Resolve crossfaded start times: s_0 = 0, s_k = Σd(j<k) − k·XFADE.
  const n = timings.length;
  const overlap = n > 1 ? XFADE : 0;
  let cumulative = 0;
  for (let i = 0; i < n; i++) {
    timings[i].startTime = +(cumulative - i * overlap).toFixed(3);
    cumulative += timings[i].d;
  }
  const totalDuration = +(cumulative - (n - 1) * overlap).toFixed(3);

  // 3. Crossfade-assemble all clips (or copy through if a single scene).
  const joinedPath = join(config.processingPath, `${reelId}_joined.mp4`);
  await assembleCrossfade(timings, totalDuration, joinedPath);
  tmp.push(joinedPath);

  // 4. Weighted karaoke captions from ACTUAL timings → ASS → burn.
  const assContent = buildPortraitKaraoke(
    timings.map((t) => ({ text: t.narration, startTime: t.startTime, speech: t.speech }))
  );
  const assPath = join(config.processingPath, `${reelId}.ass`);
  await writeFile(assPath, assContent, "utf-8");

  const finalPath = join(config.processingPath, `${reelId}_final.mp4`);
  await burnSubtitles(joinedPath, assPath, finalPath);

  return {
    videoPath: finalPath,
    assPath,
    scenes: timings.map((t) => ({ startTime: t.startTime, duration: t.d })),
    totalDuration,
  };
}

export interface SceneClipStyle {
  /** 0-1, scaled onto the base `noise=alls=9` grain — 1 = default intensity. Can exceed 1. */
  grainIntensity?: number;
  /** vignette angle divisor — smaller = darker/tighter vignette. Default matches `PI/5`. */
  vignetteDivisor?: number;
  /** extra desaturation beyond the base 0.9 saturation (0 = none). */
  desaturateBoost?: number;
}

/**
 * One scene → mp4 (Ken Burns + grain + vignette + its narration).
 * No black fades here — continuity comes from crossfades in assembly.
 */
export function renderSceneClip(
  scene: RenderScene,
  d: number,
  frames: number,
  out: string,
  styleTint: boolean,
  style: SceneClipStyle = {}
): Promise<string> {
  const z =
    scene.motion.direction === "out"
      ? `if(eq(on,1),1.45,max(zoom-0.0011,1.0))`
      : `min(zoom+0.0011,1.45)`;

  const grain = Math.round(9 * (style.grainIntensity ?? 1));
  const vignetteDivisor = style.vignetteDivisor ?? 5;
  const saturation = Math.max(0.9 - (style.desaturateBoost ?? 0), 0.2);

  const filters = [
    `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase`,
    `crop=${W * 2}:${H * 2}`,
    `zoompan=z='${z}':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${FPS}`,
    grain > 0 ? `noise=alls=${grain}:allf=t` : null,
    `vignette=PI/${vignetteDivisor}`,
    styleTint ? `eq=contrast=1.05:saturation=${saturation.toFixed(2)}` : null,
    `format=yuv420p`,
    `trim=end_frame=${frames}`,
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
        "-frames:v", String(frames),
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
      .on("error", (err) => reject(new Error(`Scene render failed: ${err.message}`)))
      .run();
  });
}

/**
 * Chain all scene clips with xfade (video) + acrossfade (audio) so they melt
 * into one another. A subtle fade-from-black / fade-to-black is applied only at
 * the very start and end. Falls back to a straight re-encode for one scene.
 */
function assembleCrossfade(
  timings: SceneTiming[],
  total: number,
  out: string
): Promise<string> {
  const n = timings.length;

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg();
    for (const t of timings) cmd.input(t.clipPath);

    const filters: string[] = [];
    let vChain: string;
    let aChain: string;

    if (n === 1) {
      vChain = "0:v";
      aChain = "0:a";
    } else {
      // running combined length before adding each next clip
      let runLen = timings[0].d;
      let vPrev = "0:v";
      let aPrev = "0:a";
      for (let k = 1; k < n; k++) {
        const offset = +(runLen - XFADE).toFixed(3);
        const vOut = `vx${k}`;
        const aOut = `ax${k}`;
        filters.push(
          `[${vPrev}][${k}:v]xfade=transition=fade:duration=${XFADE}:offset=${offset}[${vOut}]`
        );
        filters.push(`[${aPrev}][${k}:a]acrossfade=d=${XFADE}:c1=tri:c2=tri[${aOut}]`);
        runLen = +(runLen + timings[k].d - XFADE).toFixed(3);
        vPrev = vOut;
        aPrev = aOut;
      }
      vChain = vPrev;
      aChain = aPrev;
    }

    // gentle edges only (no per-scene black dips); always emit real labels
    const fadeOutStart = Math.max(total - EDGE_FADE, 0).toFixed(2);
    filters.push(
      `[${vChain}]fade=t=in:st=0:d=${EDGE_FADE},fade=t=out:st=${fadeOutStart}:d=${EDGE_FADE}[vout]`
    );
    filters.push(`[${aChain}]anull[aout]`);

    cmd
      .complexFilter(filters, ["vout", "aout"])
      .outputOptions([
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-ar", "44100",
      ])
      .output(out)
      .on("end", () => resolve(out))
      .on("error", (err) => reject(new Error(`Crossfade assembly failed: ${err.message}`)))
      .run();
  });
}

export function burnSubtitles(video: string, assPath: string, out: string): Promise<string> {
  return new Promise((resolve, reject) => {
    ffmpeg(video)
      .outputOptions([
        "-vf", `ass='${assPath.replace(/'/g, "\\'")}'`,
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "21",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
      ])
      .output(out)
      .on("end", () => resolve(out))
      .on("error", (err) => reject(new Error(`Caption burn failed: ${err.message}`)))
      .run();
  });
}

// ============================================
// Portrait karaoke captions (9:16). Word-by-word amber highlight is the
// signature look. Per-word duration is WEIGHTED by word length within each
// scene's measured speech window, so cues track real speech far better than a
// uniform split and never bleed past the scene's spoken portion.
// ============================================

function assTime(sec: number): string {
  const clamped = Math.max(sec, 0);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = (clamped % 60).toFixed(2);
  return `${h}:${m.toString().padStart(2, "0")}:${s.padStart(5, "0")}`;
}

/** Rough "spoken weight" of a word — letters/digits count, min 1. */
function wordWeight(w: string): number {
  const letters = w.replace(/[^A-Za-z0-9]/g, "").length;
  return Math.max(letters, 1);
}

export function buildPortraitKaraoke(
  scenes: { text: string; startTime: number; speech: number }[]
): string {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Arial,64,&H00FFFFFF,&H0000D7FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,2,90,90,320,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const ACTIVE = "&H0000D7FF"; // amber highlight
  const IDLE = "&H00FFFFFF"; // white
  const CHUNK = 4; // words shown together (legible on portrait)
  const lines: string[] = [];

  for (const scene of scenes) {
    const words = scene.text.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;

    // weighted per-word timing across the spoken window
    const weights = words.map(wordWeight);
    const totalW = weights.reduce((a, b) => a + b, 0);
    const starts: number[] = [];
    const ends: number[] = [];
    let acc = 0;
    for (let i = 0; i < words.length; i++) {
      const st = scene.startTime + (acc / totalW) * scene.speech;
      acc += weights[i];
      const en = scene.startTime + (acc / totalW) * scene.speech;
      starts.push(st);
      ends.push(en);
    }

    // display in chunks; highlight the active word as it is spoken
    for (let i = 0; i < words.length; i++) {
      const chunkStart = Math.floor(i / CHUNK) * CHUNK;
      const chunk = words.slice(chunkStart, chunkStart + CHUNK);
      const activeInChunk = i - chunkStart;
      const text = chunk
        .map((w, k) => `{\\1c${k === activeInChunk ? ACTIVE : IDLE}}${w}`)
        .join(" ");
      lines.push(
        `Dialogue: 0,${assTime(starts[i])},${assTime(ends[i])},Cap,,0,0,0,,${text}`
      );
    }
  }

  return header + lines.join("\n") + "\n";
}
