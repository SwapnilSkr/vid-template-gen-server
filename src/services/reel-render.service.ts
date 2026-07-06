import ffmpeg from "fluent-ffmpeg";
import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { ensureDir } from "../utils";
import { getAudioDuration } from "./openrouter-media.service";
import { cdnUrlFor, listKeys } from "./s3.service";
import { DEFAULT_CAPTION_STYLE } from "../config/style-presets";
import { captionStylePlain } from "../utils/caption-style.utils";
import { FONTS_DIR, HAS_FONTS_DIR } from "../config/fonts";
import type { ISceneMotion, ICaptionStyle, IEditEffects } from "../models";

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

export interface RenderOptions {
  horrorEffects?: boolean;
  comicEffects?: boolean;
  horrorAudioKey?: string;
  captionStyle?: ICaptionStyle;
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
  styleTint = true,
  options: RenderOptions = {}
): Promise<RenderResult> {
  await ensureDir(config.processingPath);
  const tmp: string[] = [];

  try {
    return await renderImageKenBurnsInner(reelId, scenes, styleTint, tmp, options);
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
  tmp: string[],
  options: RenderOptions
): Promise<RenderResult> {
  const timings: SceneTiming[] = [];

  // 1. Render each scene to its own clip (identical params → crossfade-safe).
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const speech = await getAudioDuration(scene.audioPath);
    const d = +(speech + TAIL).toFixed(2);
    const frames = Math.round(d * FPS);
    const clipPath = join(config.processingPath, `${reelId}_scene${i}.mp4`);

    await renderSceneClip(
      scene,
      d,
      frames,
      clipPath,
      styleTint,
      options.comicEffects
        ? comicHorrorStyleForScene(scene, i, scenes.length)
        : options.horrorEffects
        ? horrorStyleForScene(scene, i, scenes.length)
        : {}
    );

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
    await copyVideo(captionedPath, finalPath);
  }

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
  /** comic-style ink sharpening and harsher contrast. */
  comicInk?: boolean;
}

function horrorStyleForScene(scene: RenderScene, index: number, total: number): SceneClipStyle {
  const text = scene.narration.toLowerCase();
  const isFinal = index === total - 1;
  const hasDevice = /\b(recorder|phone|radio|speaker|screen|camera|ai|computer|monitor|tape|voice)\b/.test(text);
  const hasRoomReveal = /\b(door|window|closet|bed|pillow|chair|room|hall|mirror|stairs|basement)\b/.test(text);
  const hasBodyDetail = /\b(hand|face|mouth|breath|teeth|skin|eye|eyes|warm|cold)\b/.test(text);

  let grainIntensity = 1.35 + index * 0.08;
  let vignetteDivisor = 3.9 - index * 0.08;
  let desaturateBoost = 0.12 + index * 0.015;

  if (hasDevice) {
    grainIntensity += 0.35;
    desaturateBoost += 0.04;
  }
  if (hasRoomReveal) {
    vignetteDivisor -= 0.35;
    desaturateBoost += 0.03;
  }
  if (hasBodyDetail) {
    grainIntensity += 0.18;
    vignetteDivisor -= 0.15;
  }
  if (isFinal) {
    grainIntensity += 0.35;
    vignetteDivisor -= 0.45;
    desaturateBoost += 0.07;
  }

  return {
    grainIntensity,
    vignetteDivisor: Math.max(vignetteDivisor, 2.8),
    desaturateBoost: Math.min(desaturateBoost, 0.32),
  };
}

function comicHorrorStyleForScene(scene: RenderScene, index: number, total: number): SceneClipStyle {
  const base = horrorStyleForScene(scene, index, total);
  return {
    ...base,
    grainIntensity: Math.min((base.grainIntensity ?? 1.4) + 0.05, 1.55),
    vignetteDivisor: Math.max((base.vignetteDivisor ?? 3.6) - 0.25, 2.65),
    desaturateBoost: Math.min((base.desaturateBoost ?? 0.16) + 0.02, 0.34),
    comicInk: true,
  };
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
  const contrast = style.comicInk ? 1.18 : 1.05;

  const filters = [
    `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase`,
    `crop=${W * 2}:${H * 2}`,
    `zoompan=z='${z}':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${FPS}`,
    grain > 0 ? `noise=alls=${grain}:allf=t` : null,
    `vignette=PI/${vignetteDivisor}`,
    styleTint ? `eq=contrast=${contrast.toFixed(2)}:saturation=${saturation.toFixed(2)}` : null,
    style.comicInk ? "unsharp=5:5:0.85:3:3:0.3" : null,
    style.comicInk ? `drawbox=x=28:y=28:w=iw-56:h=ih-56:color=black@0.72:t=8` : null,
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
export function assembleCrossfade(
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

    // Fade to black at the very end only. The intro fade-IN is applied later, in
    // burnSubtitles, so it fades the captions in with the image rather than
    // leaving them lit over a black opening frame. Always emit real labels.
    const fadeOutStart = Math.max(total - EDGE_FADE, 0).toFixed(2);
    filters.push(
      `[${vChain}]fade=t=out:st=${fadeOutStart}:d=${EDGE_FADE}[vout]`
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

export function burnSubtitles(
  video: string,
  assPath: string,
  out: string,
  fadeIn = 0
): Promise<string> {
  const escapedAss = assPath.replace(/'/g, "\\'");
  const fontsdir = HAS_FONTS_DIR ? `:fontsdir='${FONTS_DIR.replace(/'/g, "\\'")}'` : "";
  // Fade the composited frame (image + burned captions) in together. The intro
  // fade lives HERE, after the burn — never before it — so captions can't flash
  // at full opacity over a still-black frame at t=0 ("captions before the image").
  const vf =
    fadeIn > 0
      ? `ass='${escapedAss}'${fontsdir},fade=t=in:st=0:d=${fadeIn}`
      : `ass='${escapedAss}'${fontsdir}`;
  return new Promise((resolve, reject) => {
    ffmpeg(video)
      .outputOptions([
        "-vf", vf,
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

function copyVideo(input: string, output: string): Promise<string> {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .outputOptions(["-c", "copy", "-movflags", "+faststart"])
      .output(output)
      .on("end", () => resolve(output))
      .on("error", (err) => reject(new Error(`Final copy failed: ${err.message}`)))
      .run();
  });
}

// ============================================
// Co-creatable cinematic edit effects — a single final full-video pass applied
// over the fully-assembled reel body (before the branded outro). Render-only:
// toggling these only needs a free re-render, no asset regeneration.
//
// Rain is composited as a WHITE ALPHA OVERLAY (not a screen blend): screen-
// blending the chroma planes tints the whole frame purple, so we build a rain
// alpha-mask from temporal noise (threshold → vertical blur = streaks) and
// overlay white through it, leaving the base color untouched. Validated against
// the reference art before wiring.
// ============================================

/** True when at least one edit effect is enabled (else the pass is a no-op copy). */
export function hasEditEffects(fx?: IEditEffects): boolean {
  if (!fx) return false;
  return (
    Boolean(fx.rain) ||
    Boolean(fx.letterbox) ||
    (fx.grain ?? 0) > 0 ||
    (fx.vignette ?? 0) > 0 ||
    (fx.desaturate ?? 0) > 0 ||
    (fx.flicker ?? 0) > 0 ||
    (fx.chromatic ?? 0) > 0 ||
    (fx.scanlines ?? 0) > 0
  );
}

export function applyEditEffects(input: string, output: string, fx?: IEditEffects): Promise<string> {
  if (!hasEditEffects(fx)) return copyVideo(input, output);
  const effects = fx!;

  const rain = Boolean(effects.rain);
  // rainIntensity 0-1 → streak opacity 0.2-0.9 (0 still shows faint drizzle).
  const rainOp = clamp01(effects.rainIntensity ?? 0.5) * 0.7 + 0.2;
  const grain = Math.min(Math.max(effects.grain ?? 0, 0), 1.5);
  const vig = clamp01(effects.vignette ?? 0);
  const desaturate = clamp01(effects.desaturate ?? 0);
  const flicker = clamp01(effects.flicker ?? 0);
  const chromatic = clamp01(effects.chromatic ?? 0);
  const scanlines = clamp01(effects.scanlines ?? 0);
  const vigDivisor = (5.5 - vig * 2.5).toFixed(2); // strength 1 → PI/3.0, 0.5 → PI/4.25
  const bar = Math.round(H * 0.11); // cinematic bar height per edge

  // Post-composite chain (applied after any rain overlay): cold grade → instability → analog texture → bars.
  const post: string[] = [];
  if (desaturate > 0) post.push(`hue=s=${(1 - desaturate * 0.78).toFixed(2)}`);
  if (flicker > 0) {
    const a = (flicker * 0.045).toFixed(3);
    const b = (flicker * 0.025).toFixed(3);
    post.push(`eq=brightness='${a}*sin(2*PI*t*7)+${b}*sin(2*PI*t*13)'`);
  }
  if (chromatic > 0) {
    const shift = Math.max(1, Math.round(chromatic * 8));
    post.push(`rgbashift=rh=${shift}:bh=-${shift}`);
  }
  if (grain > 0) post.push(`noise=alls=${Math.round(grain * 14)}:allf=t`);
  if (vig > 0) post.push(`vignette=PI/${vigDivisor}`);
  if (scanlines > 0) post.push(`drawgrid=w=iw:h=4:t=1:c=black@${(scanlines * 0.28).toFixed(2)}`);
  if (effects.letterbox) {
    post.push(`drawbox=x=0:y=0:w=iw:h=${bar}:color=black:t=fill`);
    post.push(`drawbox=x=0:y=ih-${bar}:w=iw:h=${bar}:color=black:t=fill`);
  }

  // Spawn ffmpeg directly rather than through fluent-ffmpeg: the rain sources
  // are lavfi *devices*, which fluent-ffmpeg's capability check rejects
  // ("Input format lavfi is not available"). Raw argv also means commas inside
  // filter expressions need no escaping. Mirrors reel-hybrid.service's spawn.
  const args: string[] = ["-y", "-i", input];
  const filters: string[] = [];
  let vlabel = "0:v";

  if (rain) {
    // Two lavfi sources: black (temporal-noise carrier) + white (streak color).
    args.push("-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=${FPS}`);
    args.push("-f", "lavfi", "-i", `color=c=white:s=${W}x${H}:r=${FPS}`);
    filters.push(
      `[1:v]noise=alls=70:allf=t,format=gray,lutyuv=y='if(gt(val,208),val,0)',gblur=sigma=0.4:sigmaV=8,eq=contrast=2.2:brightness=-0.02,lutyuv=y='val*${rainOp.toFixed(2)}'[rmap]`,
      `[2:v][rmap]alphamerge[rain]`,
      `[0:v][rain]overlay=format=auto[vrain]`
    );
    vlabel = "vrain";
  }

  filters.push(`[${vlabel}]${[...post, "format=yuv420p"].join(",")}[vout]`);
  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[vout]",
    "-map", "0:a?", // carry the reel's audio through untouched
    "-c:a", "copy",
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-shortest", // bound the infinite lavfi rain sources to the video length
    output
  );

  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpegPath || "ffmpeg", args);
    let stderr = "";
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("error", (err) => reject(new Error(`Edit-effects pass failed: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Edit-effects pass failed (${code}): ${stderr.slice(-600)}`));
        return;
      }
      const on = [
        rain ? "rain" : null,
        grain > 0 ? "grain" : null,
        vig > 0 ? "vignette" : null,
        desaturate > 0 ? "desaturate" : null,
        flicker > 0 ? "flicker" : null,
        chromatic > 0 ? "chromatic" : null,
        scanlines > 0 ? "scanlines" : null,
        effects.letterbox ? "letterbox" : null,
      ].filter(Boolean);
      console.log(`🎬 Edit effects applied: ${on.join(", ")}`);
      resolve(output);
    });
  });
}

function clamp01(n: number): number {
  return Math.min(Math.max(n, 0), 1);
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function pickHorrorBed(preferredKey: string | undefined, seed: string): Promise<string | undefined> {
  if (preferredKey && /^horror-audio\/.+\.mp3$/i.test(preferredKey)) return preferredKey;
  try {
    const keys = (await listKeys("horror-audio/")).filter(
      (key) =>
        key.endsWith(".mp3") &&
        /(ambient|ambience|drone|feedback|tone)/i.test(key) &&
        !key.endsWith("manifest.json")
    );
    if (!keys.length) return undefined;
    return keys.sort()[hashString(seed) % keys.length];
  } catch (error) {
    console.warn(`Could not list horror audio library: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

interface HorrorCue {
  key: string;
  at: number;
  volume: number;
}

function firstKey(keys: string[], pattern: RegExp, fallback?: string): string | undefined {
  return keys.find((key) => pattern.test(key)) ?? fallback;
}

function selectSituationalHorrorCues(
  timings: SceneTiming[],
  keys: string[],
  bedKey?: string
): HorrorCue[] {
  const sfxKeys = keys.filter((key) => key !== bedKey && /(hit|scare|stinger|riser|feedback|tone)/i.test(key));
  if (!sfxKeys.length) return [];

  const fallback = sfxKeys[0];
  const feedback = firstKey(sfxKeys, /(feedback|tone)/i, fallback);
  const stinger = firstKey(sfxKeys, /(stinger|ambient-hit|cringe-scare|scare)/i, fallback);
  const hit = firstKey(sfxKeys, /(horror-hit|scary-hits|riser)/i, fallback);
  const cues: HorrorCue[] = [];

  for (let i = 0; i < timings.length; i++) {
    const scene = timings[i];
    const text = scene.narration.toLowerCase();
    const isFinal = i === timings.length - 1;
    const hasDevice = /\b(recorder|phone|radio|speaker|screen|camera|ai|computer|monitor|tape|voice)\b/.test(text);
    const hasRoomReveal = /\b(door|window|closet|bed|pillow|chair|room|hall|mirror|stairs|basement)\b/.test(text);

    if (isFinal && hit) {
      cues.push({
        key: hit,
        at: scene.startTime + Math.max(scene.speech - 0.7, 0.4),
        volume: 0.24,
      });
    } else if (hasDevice && feedback) {
      cues.push({ key: feedback, at: scene.startTime + 0.2, volume: 0.12 });
    } else if (hasRoomReveal && stinger && i > 0) {
      cues.push({ key: stinger, at: scene.startTime + 0.25, volume: 0.16 });
    }
  }

  return cues
    .sort((a, b) => a.at - b.at)
    .filter((cue, index, all) => index === 0 || cue.at - all[index - 1].at > 1.4)
    .slice(0, 3);
}

async function downloadUrlToFile(url: string, output: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  await writeFile(output, Buffer.from(await res.arrayBuffer()));
  return output;
}

export async function applyHorrorFinalMix(
  input: string,
  output: string,
  tmp: string[],
  horrorAudioKey?: string,
  timings: SceneTiming[] = [],
  comicEffects = false
): Promise<string> {
  const seed = timings.map((timing) => timing.narration).join("|");
  const bedKey = await pickHorrorBed(horrorAudioKey, seed);
  if (!bedKey) return copyVideo(input, output);
  const horrorKeys = await listKeys("horror-audio/").catch(() => []);
  const cues = selectSituationalHorrorCues(timings, horrorKeys, bedKey);

  const bedPath = join(config.processingPath, `horror_bed_${Date.now()}.mp3`);
  tmp.push(bedPath);
  try {
    await downloadUrlToFile(cdnUrlFor(bedKey), bedPath);
  } catch (error) {
    console.warn(`Skipping horror bed ${bedKey}: ${error instanceof Error ? error.message : String(error)}`);
    return copyVideo(input, output);
  }

  const cuePaths: { path: string; cue: HorrorCue }[] = [];
  for (const cue of cues) {
    const cuePath = join(config.processingPath, `horror_cue_${cuePaths.length}_${Date.now()}.mp3`);
    tmp.push(cuePath);
    try {
      await downloadUrlToFile(cdnUrlFor(cue.key), cuePath);
      cuePaths.push({ path: cuePath, cue });
    } catch (error) {
      console.warn(`Skipping horror cue ${cue.key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg().input(input).input(bedPath).inputOptions(["-stream_loop", "-1"]);
    for (const cue of cuePaths) cmd.input(cue.path);

    const videoFilter = comicEffects
      ? "[0:v]eq=contrast=1.14:saturation=0.74,unsharp=5:5:0.75:3:3:0.25,noise=alls=2:allf=t,drawbox=x=18:y=18:w=iw-36:h=ih-36:color=black@0.65:t=6[vout]"
      : "[0:v]eq=contrast=1.08:saturation=0.82,noise=alls=5:allf=t[vout]";
    const filters = [
      videoFilter,
      "[1:a]highpass=f=45,lowpass=f=3600,volume=0.16,afade=t=in:st=0:d=1.2[bed]",
    ];
    const mixInputs = ["[0:a]", "[bed]"];
    cuePaths.forEach(({ cue }, index) => {
      const inputIndex = index + 2;
      const delayMs = Math.max(Math.round(cue.at * 1000), 0);
      const label = `cue${index}`;
      filters.push(
        `[${inputIndex}:a]atrim=0:2.6,asetpts=PTS-STARTPTS,highpass=f=70,lowpass=f=9000,volume=${cue.volume.toFixed(
          2
        )},afade=t=out:st=2.1:d=0.45,adelay=${delayMs}:all=1[${label}]`
      );
      mixInputs.push(`[${label}]`);
    });
    filters.push(
      `${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=first:dropout_transition=0,acompressor=threshold=-18dB:ratio=2.4:attack=8:release=180,loudnorm=I=-16:LRA=8:TP=-1.5[aout]`
    );

    cmd
      .complexFilter(filters, ["vout", "aout"])
      .outputOptions([
        "-c:v",
        "libx264",
        "-preset",
        comicEffects ? "slow" : "medium",
        "-crf",
        comicEffects ? "24" : "21",
        ...(comicEffects ? ["-maxrate", "8M", "-bufsize", "16M", "-tune", "animation"] : []),
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-ar",
        "44100",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
      ])
      .output(output)
      .on("end", () => {
        console.log(
          `🎧 Horror bed mixed from S3: ${bedKey}` +
            (cuePaths.length ? ` + ${cuePaths.length} situational cue(s)` : "")
        );
        resolve(output);
      })
      .on("error", (err) => reject(new Error(`Horror final mix failed: ${err.message}`)))
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

/** Split a word into per-letter ASS karaoke tags so it fills left-to-right across
 *  `durationSec`. The tag durations are centiseconds relative to the cue start
 *  and sum to exactly the cue window, so the letter sweep stays locked to the
 *  measured speech with no cumulative drift against the audio.
 *
 *  `instant` chooses the transition per letter: `\kf` (default) fades each letter
 *  smoothly across its slot; `\k` snaps it instantly at the slot boundary — a
 *  near-instant catch-up that still never runs ahead of the spoken word. */
function karaokeLetters(word: string, durationSec: number, instant = false): string {
  const chars = [...word];
  if (!chars.length) return "";
  const tag = instant ? "k" : "kf";
  const totalCs = Math.max(1, Math.round(durationSec * 100));
  let acc = 0;
  return chars
    .map((c, i) => {
      const target = Math.round(((i + 1) / chars.length) * totalCs);
      const cs = Math.max(0, target - acc);
      acc = target;
      return `{\\${tag}${cs}}${c}`;
    })
    .join("");
}

/** Rough "spoken weight" of a word — letters/digits count, min 1. */
function wordWeight(w: string): number {
  const letters = w.replace(/[^A-Za-z0-9]/g, "").length;
  return Math.max(letters, 1);
}

/** #RRGGBB → ASS style colour (&HAABBGGRR, opaque). */
function hexToAssColor(hex?: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex ?? "");
  if (!m) return "&H00FFFFFF";
  const rr = m[1].slice(0, 2);
  const gg = m[1].slice(2, 4);
  const bb = m[1].slice(4, 6);
  return `&H00${bb}${gg}${rr}`.toUpperCase();
}

/** #RRGGBB → ASS inline override colour (`&HBBGGRR&` — libass requires the
 *  trailing ampersand; see reel-gameplay bouncing captions). */
function hexToAssInlineColor(hex?: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex ?? "");
  if (!m) return "&HFFFFFF&";
  const rr = m[1].slice(0, 2);
  const gg = m[1].slice(2, 4);
  const bb = m[1].slice(4, 6);
  return `&H${bb}${gg}${rr}&`.toUpperCase();
}

export function buildPortraitKaraoke(
  scenes: { text: string; startTime: number; speech: number }[],
  captionStyle?: ICaptionStyle
): string {
  // Merge the requested style over the renderer's built-in default so any
  // unset field renders exactly as before. Vertical placement always uses
  // bottom-center + MarginV (px from bottom) — matches Studio drag preview.
  //
  // captionStyle arrives as a Mongoose subdocument (reel.captionStyle); a raw
  // spread of it copies NONE of the schema fields, so the whole custom look
  // (font, colours, chunk size, caps) would silently fall back to the default.
  // Flatten to a plain object first so the user's chosen style actually burns.
  const style = captionStylePlain(captionStyle);
  const s = {
    ...DEFAULT_CAPTION_STYLE,
    ...style,
    alignment: 2,
    marginV: Math.round(
      Math.min(Math.max(style.marginV ?? DEFAULT_CAPTION_STYLE.marginV, 0), 1900)
    ),
  };
  const IDLE = hexToAssColor(s.primaryColor);
  const ACTIVE = hexToAssColor(s.activeColor);
  const OUTLINE = hexToAssColor(s.outlineColor);
  const IDLE_INLINE = hexToAssInlineColor(s.primaryColor);
  const ACTIVE_INLINE = hexToAssInlineColor(s.activeColor);
  // Karaoke fill is opt-in. Off (default) → words render in the flat text colour
  // only. On → a word starts in the highlight colour (activeColor) and the text
  // colour catches up letter by letter as it's spoken. If karaoke is on but the
  // highlight matches the text colour, there's nothing to sweep from, so letters
  // reveal (faint → solid) instead.
  const KARAOKE = s.karaoke === true;
  const HAS_HIGHLIGHT = ACTIVE_INLINE !== IDLE_INLINE;
  const CHUNK = Math.max(1, Math.round(s.chunkSize));
  const bold = s.bold ? -1 : 0;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${s.fontName},${s.fontSize},${IDLE},${ACTIVE},${OUTLINE},&H80000000,${bold},0,0,0,100,100,0,0,1,${s.outlineWidth},${s.shadow},${s.alignment},${s.marginL},${s.marginR},${s.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines: string[] = [];

  for (const scene of scenes) {
    const rawWords = scene.text.trim().split(/\s+/).filter(Boolean);
    if (!rawWords.length) continue;
    const words = s.uppercase ? rawWords.map((w) => w.toUpperCase()) : rawWords;

    // weighted per-word timing across the spoken window
    const weights = rawWords.map(wordWeight);
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

    // Display in chunks. With karaoke OFF (default) every word is flat text
    // colour. With karaoke ON the HIGHLIGHT colour is the base: a word starts
    // fully highlighted and the TEXT colour catches up LETTER BY LETTER as it's
    // spoken (\k karaoke → no drift against the audio), ending in the text
    // colour. Across a multi-word chunk (karaoke on):
    //   - words already spoken  → text colour,
    //   - the word being spoken  → highlight base with text snapping in,
    //   - words not yet spoken   → still the highlight colour (the base).
    // If karaoke is on with no distinct highlight, the word reveals (faint → solid).
    const pop = s.animation === "pop" ? "{\\fscx112\\fscy112\\t(0,120,\\fscx100\\fscy100)}" : "";
    for (let i = 0; i < words.length; i++) {
      const chunkStart = Math.floor(i / CHUNK) * CHUNK;
      const chunk = words.slice(chunkStart, chunkStart + CHUNK);
      const activeInChunk = i - chunkStart;
      const dur = Math.max(ends[i] - starts[i], 0);
      const text = chunk
        .map((w, k) => {
          if (!KARAOKE) {
            // Flat text colour, fully opaque — no highlight, no per-letter fill.
            return `{\\1c${IDLE_INLINE}\\1a&H00&\\2a&H00&}${w}`;
          }
          if (k !== activeInChunk) {
            // Idle word: text colour once spoken, else the highlight base.
            const spoken = k < activeInChunk;
            const col = HAS_HIGHLIGHT && !spoken ? ACTIVE_INLINE : IDLE_INLINE;
            return `{\\1c${col}\\1a&H00&\\2a&H00&}${w}`;
          }
          const fill = HAS_HIGHLIGHT
            ? // base = highlight (\2c, unsung); text (\1c) fills in per letter
              `\\2a&H00&\\1a&H00&\\2c${ACTIVE_INLINE}\\1c${IDLE_INLINE}`
            : // no distinct highlight → faint → solid reveal in the text colour
              `\\2a&H90&\\1a&H00&\\2c${IDLE_INLINE}\\1c${IDLE_INLINE}`;
          // Highlight fill snaps instantly per letter; the plain reveal stays smooth.
          return `{${fill}}${pop}${karaokeLetters(w, dur, HAS_HIGHLIGHT)}`;
        })
        .join(" ");
      lines.push(
        `Dialogue: 0,${assTime(starts[i])},${assTime(ends[i])},Cap,,0,0,0,,${text}`
      );
    }
  }

  return header + lines.join("\n") + "\n";
}
