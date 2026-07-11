import ffmpeg from "fluent-ffmpeg";
import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { ensureDir } from "../utils";
import type { ICaptionStyle } from "../models";
import { getAudioDuration, generateHeroVideo, type MediaUsageCallback } from "./openrouter-media.service";
import {
  W,
  H,
  FPS,
  TAIL,
  XFADE,
  EDGE_FADE,
  renderSceneClip,
  burnSubtitles,
  buildPortraitKaraoke,
  type RenderScene,
  type RenderResult,
  type SceneTiming,
} from "./reel-render.service";

// ============================================
// HybridSceneStrategy — "skilled video editor" treatment for niches that get
// one real AI-video hero shot (horror, mythology, movie-recap — heroPolicy
// "one_climax"/"trend_gated" in niche-styles.ts). Everything up to the hero
// scene is image_kenburns-style stills, but with a TENSION RAMP (grain,
// vignette, and desaturation intensify scene-by-scene toward the climax)
// instead of flat, identical treatment throughout.
//
// Editorial choices, deliberately not "just another crossfade":
//  - Every non-hero transition still crossfades (continuity).
//  - The cut INTO the hero shot is a hard cut with a near-instant white-flash
//    xfade (0.08s) — the "jump scare" edit — video AND audio both cut sharply
//    instead of blending, because a slow fade into the money shot kills the
//    surprise.
//  - A procedural ambient "dread" bed (brown noise, lowpassed, ffmpeg-
//    synthesized — no external audio assets, no licensing risk) is mixed
//    under the whole track with sidechain ducking so it recedes under
//    narration and swells in the silences.
//  - The hero clip itself gets NO grain/vignette/desaturation — real AI
//    video footage should read as strikingly different from the stylized
//    stills around it, not blended into the same treatment.
// ============================================

export interface HybridScene extends RenderScene {
  isHero: boolean;
  /** style prompt used only when this scene is NOT the hero (image gen) */
  visualPrompt: string;
  heroVideoPath?: string;
}

export interface HybridRenderOptions {
  heroVideoModel?: string;
  onHeroGenerated?: (videoPath: string) => Promise<void>;
  onHeroUsage?: MediaUsageCallback;
  captionStyle?: ICaptionStyle;
}

export async function renderHybridScene(
  reelId: string,
  scenes: HybridScene[],
  opts: HybridRenderOptions = {}
): Promise<RenderResult> {
  await ensureDir(config.processingPath);
  const tmp: string[] = [];
  try {
    return await renderHybridSceneInner(reelId, scenes, opts, tmp);
  } finally {
    await Promise.all(tmp.map((f) => unlink(f).catch(() => {})));
  }
}

async function renderHybridSceneInner(
  reelId: string,
  scenes: HybridScene[],
  opts: HybridRenderOptions,
  tmp: string[]
): Promise<RenderResult> {
  const n = scenes.length;
  const heroIndex = scenes.findIndex((s) => s.isHero);
  const timings: SceneTiming[] = [];
  let generatedHeroVideoPath: string | undefined;

  // 1. Render each scene to its own clip — stills ramp tension, hero is real AI video.
  for (let i = 0; i < n; i++) {
    const scene = scenes[i];
    const speech = await getAudioDuration(scene.audioPath);
    const d = +(speech + TAIL).toFixed(2);
    const frames = Math.round(d * FPS);
    const clipPath = join(config.processingPath, `${reelId}_scene${i}.mp4`);

    if (scene.isHero) {
      generatedHeroVideoPath = await renderHeroClip(scene, d, frames, clipPath, opts);
    } else {
      // 0 (calm open) -> 1 (right before the climax): grain thickens, vignette
      // tightens, color drains as dread builds toward the hero reveal.
      const progress = n > 1 ? i / Math.max(n - 1, 1) : 0;
      await renderSceneClip(scene, d, frames, clipPath, true, {
        grainIntensity: 1 + progress * 1.2,
        vignetteDivisor: 5 - progress * 2.2,
        desaturateBoost: progress * 0.25,
      });
    }

    timings.push({ clipPath, narration: scene.narration, d, speech, startTime: 0 });
    tmp.push(clipPath);
    console.log(`🎞️  Hybrid scene ${i}${scene.isHero ? " [HERO]" : ""}: ${d}s`);
  }

  // 2. Resolve timeline — every transition crossfades (XFADE) except the cut
  //    INTO the hero scene, which has ~zero overlap (hard cut).
  let cumulative = 0;
  let accOverlap = 0;
  for (let i = 0; i < n; i++) {
    const overlap = i === 0 ? 0 : i === heroIndex ? HERO_CUT_DURATION : XFADE;
    accOverlap += overlap;
    timings[i].startTime = +(cumulative - accOverlap).toFixed(3);
    cumulative += timings[i].d;
  }
  const totalDuration = +(cumulative - accOverlap).toFixed(3);

  // 3. Assemble with per-transition control (crossfade vs. hard-cut flash).
  const joinedPath = join(config.processingPath, `${reelId}_joined.mp4`);
  await assembleHybrid(timings, heroIndex, totalDuration, joinedPath);
  tmp.push(joinedPath);

  // 4. Procedural ambient dread bed, ducked under narration. Some local ffmpeg
  // builds do not expose lavfi; in that case, keep the assembled video instead
  // of failing after paid assets have already been generated.
  const bedPath = join(config.processingPath, `${reelId}_bed.mp4`);
  let subtitleInputPath = joinedPath;
  try {
    await addAmbientBed(joinedPath, totalDuration, bedPath);
    tmp.push(bedPath);
    subtitleInputPath = bedPath;
  } catch (error: unknown) {
    console.warn(`Skipping ambient bed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 5. Karaoke captions (reused as-is from image_kenburns).
  // Cache the pre-caption input (joined or joined+ambient bed) as assembly.
  const assemblyPath = join(config.processingPath, `${reelId}_assembly.mp4`);
  try {
    await copyAssembly(subtitleInputPath, assemblyPath);
  } catch (error) {
    await unlink(assemblyPath).catch(() => {});
    throw error;
  }

  const assContent = buildPortraitKaraoke(
    timings.map((t) => ({ text: t.narration, startTime: t.startTime, speech: t.speech })),
    opts.captionStyle
  );
  const assPath = join(config.processingPath, `${reelId}.ass`);
  await writeFile(assPath, assContent, "utf-8");

  const finalPath = join(config.processingPath, `${reelId}_final.mp4`);
  let burnedPath: string;
  try {
    burnedPath = await burnSubtitles(subtitleInputPath, assPath, finalPath, EDGE_FADE);
  } catch (error) {
    await unlink(assemblyPath).catch(() => {});
    throw error;
  }

  return {
    videoPath: burnedPath,
    assPath,
    scenes: timings.map((t) => ({ startTime: t.startTime, duration: t.d })),
    totalDuration,
    heroVideoPath: generatedHeroVideoPath,
    assemblyPath,
  };
}

async function copyAssembly(input: string, output: string): Promise<string> {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .outputOptions(["-c", "copy", "-movflags", "+faststart"])
      .output(output)
      .on("end", () => resolve(output))
      .on("error", (err) => reject(new Error(`Assembly copy failed: ${err.message}`)))
      .run();
  });
}

const HERO_CUT_DURATION = 0.08; // near-instant flash-cut, not a crossfade

/** Generate the AI hero clip, then fit it to the scene's narration-driven
 * duration (loop if shorter, trim if longer) and attach the narration audio —
 * the video model never generates its own audio (`generate_audio: false`). */
async function renderHeroClip(
  scene: HybridScene,
  d: number,
  frames: number,
  out: string,
  opts: HybridRenderOptions
): Promise<string | undefined> {
  let rawHeroPath = scene.heroVideoPath;
  let generatedHeroVideoPath: string | undefined;
  if (rawHeroPath) {
    console.log(`♻️  Reusing hero video: ${rawHeroPath}`);
  } else {
    const generated = await generateHeroVideo(scene.visualPrompt || scene.narration, {
      model: opts.heroVideoModel,
      durationSec: Math.min(Math.max(Math.round(d), 4), 8),
      aspectRatio: "9:16",
      onUsage: opts.onHeroUsage,
    });
    rawHeroPath = generated.videoPath;
    generatedHeroVideoPath = generated.videoPath;
    await opts.onHeroGenerated?.(generated.videoPath);
  }

  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(rawHeroPath)
      .inputOptions(["-stream_loop", "-1"]) // loop if the AI clip is shorter than the scene needs
      .input(scene.audioPath)
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
      .on("end", () => resolve())
      .on("error", (err) => reject(new Error(`Hero clip fit failed: ${err.message}`)))
      .run();
  });
  return generatedHeroVideoPath;
}

/** Like image_kenburns's crossfade assembly, except the transition into the
 * hero scene is a near-instant white-flash hard cut instead of a slow blend. */
function assembleHybrid(
  timings: SceneTiming[],
  heroIndex: number,
  total: number,
  out: string
): Promise<string> {
  const n = timings.length;

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg();
    for (const t of timings) cmd.input(t.clipPath);

    const filters: string[] = [];
    let vChain = "0:v";
    let aChain = "0:a";

    if (n > 1) {
      let runLen = timings[0].d;
      for (let k = 1; k < n; k++) {
        const isHardCut = k === heroIndex;
        const dur = isHardCut ? HERO_CUT_DURATION : XFADE;
        const transition = isHardCut ? "fadewhite" : "fade";
        const offset = +(runLen - dur).toFixed(3);
        const vOut = `vx${k}`;
        const aOut = `ax${k}`;
        filters.push(
          `[${vChain}][${k}:v]xfade=transition=${transition}:duration=${dur}:offset=${offset}[${vOut}]`
        );
        const audioXfadeDur = Math.min(dur, Math.max(timings[k].d - 0.05, 0.02));
        filters.push(`[${aChain}][${k}:a]acrossfade=d=${audioXfadeDur.toFixed(3)}:c1=tri:c2=tri[${aOut}]`);
        runLen = +(runLen + timings[k].d - dur).toFixed(3);
        vChain = vOut;
        aChain = aOut;
      }
    }

    // Fade-out only; the intro fade-in is applied in burnSubtitles so it fades
    // the captions in with the image, not over a black opening frame.
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
      .on("error", (err) => reject(new Error(`Hybrid assembly failed: ${err.message}`)))
      .run();
  });
}

/** Procedural ambient dread bed — brown noise, lowpassed into a rumble, mixed
 * under the narration with sidechain ducking (recedes when narration plays,
 * swells in the gaps). Fully synthesized by ffmpeg — no external audio
 * assets, so zero licensing risk and zero extra generation cost. */
function addAmbientBed(input: string, total: number, out: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-i",
      input,
      "-f",
      "lavfi",
      "-i",
      `anoisesrc=color=brown:amplitude=0.4:duration=${total.toFixed(2)}`,
      "-filter_complex",
      "[1:a]lowpass=f=300,highpass=f=40,volume=0.35[bed];" +
        "[bed][0:a]sidechaincompress=threshold=0.05:ratio=10:attack=5:release=400[duckedbed];" +
        "[0:a][duckedbed]amix=inputs=2:duration=first:dropout_transition=0,volume=2[aout]",
      "-map",
      "0:v",
      "-map",
      "[aout]",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-ar",
      "44100",
      "-shortest",
      out,
    ];
    const child = spawn(config.ffmpegPath || "ffmpeg", args);
    let stderr = "";
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("error", (err) => reject(new Error(`Ambient bed mix failed: ${err.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`Ambient bed mix failed (${code}): ${stderr}`));
    });
  });
}
