/**
 * Caption / libass smoke test — verifies this machine can burn ASS captions
 * onto a video, including the fluent-ffmpeg one-space path bug that silently
 * dropped captions on Macs with usernames like "Jane Doe".
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { config } from "../config";
import {
  FONTS_DIR,
  hasBundledFonts,
  listFonts,
  DEFAULT_BUNDLED_FONT_FAMILY,
} from "../config/fonts";
import { assVideoFilter, applyOutputOptions } from "../utils";
import {
  burnSubtitles,
  burnSubtitlesStrict,
  buildPortraitKaraoke,
} from "./reel-render.service";
import { generateKaraokeAssContent } from "./subtitle.service";
import { buildBouncingCaptions } from "./reel-gameplay.service";
import {
  distributeWordTimings,
  type RealWordTiming,
} from "../utils/caption-timing";
import { normalizeNarration } from "../utils/narration-normalize";
import ffmpeg from "fluent-ffmpeg";

export interface CaptionSmokeCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface CaptionSmokeResult {
  success: boolean;
  checks: CaptionSmokeCheck[];
  /** Local path to the burned sample (deleted after API responses that opt out). */
  outputPath?: string;
  filterPreview?: string;
  message: string;
}

function run(
  bin: string,
  args: string[],
  opts?: { cwd?: string }
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: opts?.cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("close", (code) =>
      resolve({ code: code ?? 1, stdout, stderr })
    );
    child.on("error", (err) =>
      resolve({ code: 1, stdout, stderr: err.message })
    );
  });
}

async function countNonBluePixels(rgbPath: string): Promise<number> {
  const buf = new Uint8Array(await readFile(rgbPath));
  let nonBlue = 0;
  for (let i = 0; i + 2 < buf.length; i += 3) {
    if (buf[i]! > 40 || buf[i + 1]! > 40) nonBlue++;
  }
  return nonBlue;
}

async function extractRgbFrame(video: string, outRgb: string): Promise<void> {
  const r = await run(config.ffmpegPath || "ffmpeg", [
    "-y",
    "-i",
    video,
    "-ss",
    "0.4",
    "-vframes",
    "1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    outRgb,
  ]);
  if (r.code !== 0) {
    throw new Error(`Frame extract failed: ${r.stderr.slice(-400)}`);
  }
}

const MIN_CAPTION_PIXELS = 500;

/**
 * Full environment + burn smoke test.
 * `keepOutput` leaves the MP4 under the temp dir for manual inspection.
 */
export async function runCaptionSmokeTest(
  options: { keepOutput?: boolean } = {}
): Promise<CaptionSmokeResult> {
  const checks: CaptionSmokeCheck[] = [];
  const ffmpegBin = config.ffmpegPath || "ffmpeg";

  // 1. ffmpeg present
  const ver = await run(ffmpegBin, ["-version"]);
  const versionLine = ver.stdout.split("\n")[0] ?? ver.stderr.split("\n")[0] ?? "";
  checks.push({
    id: "ffmpeg",
    ok: ver.code === 0,
    detail: ver.code === 0 ? versionLine : `ffmpeg not runnable: ${ver.stderr.slice(0, 200)}`,
  });

  // 2. libass / ass filter
  const filters = await run(ffmpegBin, ["-hide_banner", "-filters"]);
  const hasAss = /\bass\b/.test(filters.stdout + filters.stderr);
  checks.push({
    id: "libass",
    ok: hasAss,
    detail: hasAss
      ? "ass filter available (libass)"
      : "ffmpeg build missing `ass` filter — install ffmpeg with libass (e.g. brew reinstall ffmpeg)",
  });

  // 3. bundled fonts
  const fonts = listFonts();
  checks.push({
    id: "fonts",
    ok: hasBundledFonts(),
    detail: hasBundledFonts()
      ? `${fonts.length} bundled font(s) in ${FONTS_DIR}`
      : `No TTFs in ${FONTS_DIR} — run: bun run fetch-fonts`,
  });

  if (!checks.every((c) => c.ok)) {
    return {
      success: false,
      checks,
      message: "Environment checks failed — fix ffmpeg/libass/fonts before burning captions",
    };
  }

  // Use a directory whose path contains EXACTLY one space — the fluent-ffmpeg
  // bug that was shipping caption-free videos on many Macs.
  const root = join(tmpdir(), `caption-smoke-${Date.now()}`);
  const spaced = join(root, "one space");
  await mkdir(spaced, { recursive: true });

  const assPath = join(spaced, "smoke.ass");
  const basePath = join(spaced, "base.mp4");
  const outPath = join(spaced, "captioned.mp4");
  const framePath = join(spaced, "frame.rgb");

  const assContent = buildPortraitKaraoke(
    [{ text: "CAPTION SMOKE TEST", startTime: 0, speech: 2 }],
    {
      fontName: DEFAULT_BUNDLED_FONT_FAMILY,
      fontSize: 72,
      primaryColor: "#FFFFFF",
      activeColor: "#FFFFFF",
      outlineColor: "#000000",
      outlineWidth: 4,
      shadow: 2,
      marginV: 480,
      chunkSize: 4,
      bold: true,
      uppercase: true,
      karaoke: false,
    }
  );
  await writeFile(assPath, assContent, "utf-8");

  const base = await run(ffmpegBin, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=1080x1920:d=2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-t",
    "2",
    basePath,
  ]);
  if (base.code !== 0) {
    checks.push({
      id: "base_video",
      ok: false,
      detail: `Could not create test video: ${base.stderr.slice(-300)}`,
    });
    await rm(root, { recursive: true, force: true }).catch(() => {});
    return { success: false, checks, message: "Failed to create base test video" };
  }
  checks.push({ id: "base_video", ok: true, detail: basePath });

  const vf = assVideoFilter(assPath);
  checks.push({
    id: "filter_path",
    ok: vf.includes("one space") && vf.includes("fontsdir="),
    detail: vf,
  });

  // 4. Strict burn through our production helper (applyOutputOptions + fontsdir)
  try {
    await burnSubtitlesStrict(basePath, assPath, outPath, 0);
    checks.push({
      id: "burn_strict",
      ok: true,
      detail: "burnSubtitlesStrict succeeded with one-space path",
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({ id: "burn_strict", ok: false, detail: message });
    await rm(root, { recursive: true, force: true }).catch(() => {});
    return {
      success: false,
      checks,
      filterPreview: vf,
      message: `Caption burn failed on a one-space path (the classic Mac username bug): ${message}`,
    };
  }

  // 5. Pixel proof — white text on blue background
  try {
    await extractRgbFrame(outPath, framePath);
    const nonBlue = await countNonBluePixels(framePath);
    const ok = nonBlue >= MIN_CAPTION_PIXELS;
    checks.push({
      id: "pixels",
      ok,
      detail: ok
        ? `${nonBlue} non-blue pixels — captions are visible in the frame`
        : `${nonBlue} non-blue pixels — captions appear missing (need ≥ ${MIN_CAPTION_PIXELS})`,
    });
  } catch (error: unknown) {
    checks.push({
      id: "pixels",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // 6. Public burnSubtitles API succeeds (hard-fails on error)
  try {
    await burnSubtitles(basePath, assPath, join(spaced, "soft.mp4"), 0);
    checks.push({
      id: "burn_api",
      ok: true,
      detail: "burnSubtitles succeeded",
    });
  } catch (error: unknown) {
    checks.push({
      id: "burn_api",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // 7. Regression: array-form outputOptions with one space must NOT be used —
  //    document that applyOutputOptions is required (sanity via re-burn).
  const brokenOut = join(spaced, "broken-array.mp4");
  const arrayBroke = await new Promise<boolean>((resolve) => {
    // Deliberately use the broken array form to confirm the trap still exists
    // in fluent-ffmpeg — if this unexpectedly succeeds, paths have no space.
    ffmpeg(basePath)
      .outputOptions(["-vf", vf, "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an"])
      .output(brokenOut)
      .on("end", () => resolve(false)) // succeeded = path had ≠1 space or ffmpeg changed
      .on("error", () => resolve(true)) // failed as expected for one-space paths
      .run();
  });
  const fixedOut = join(spaced, "fixed-variadic.mp4");
  const variadicOk = await new Promise<boolean>((resolve) => {
    const cmd = ffmpeg(basePath);
    applyOutputOptions(cmd, [
      "-vf",
      vf,
      "-t",
      "1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-an",
    ])
      .output(fixedOut)
      .on("end", () => resolve(true))
      .on("error", () => resolve(false))
      .run();
  });
  checks.push({
    id: "fluent_ffmpeg_space_trap",
    ok: arrayBroke && variadicOk,
    detail: arrayBroke
      ? variadicOk
        ? "Confirmed: array outputOptions breaks one-space paths; applyOutputOptions fixes it"
        : "Array form failed as expected, but variadic applyOutputOptions also failed"
      : "Array form unexpectedly succeeded (path may not have exactly one space)",
  });

  const success = checks.every((c) => c.ok);
  if (!options.keepOutput) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }

  return {
    success,
    checks,
    outputPath: options.keepOutput ? outPath : undefined,
    filterPreview: vf,
    message: success
      ? "Caption smoke test passed — ASS burn works on this device (including one-space paths)"
      : "Caption smoke test failed — see checks for details",
  };
}

// ============================================
// Caption TIMING checks — pure, deterministic, no ffmpeg/TTS spend.
// Verifies the Issue-1 guarantees: no 0.75 compression, cue times track real
// audio, monotonic + bounded by segment duration, endpoints hard-resync, amber
// highlight present; plus the Issue-2 narration normalization invariants.
// ============================================

const EPS = 0.02; // 20ms tolerance for ASS centisecond rounding

/** Parse (start,end) seconds for every `Dialogue:` cue, in file order. */
function parseAssCues(ass: string): { start: number; end: number }[] {
  const re = /Dialogue:\s*\d+,(\d+):(\d\d):(\d\d\.\d\d),(\d+):(\d\d):(\d\d\.\d\d),/g;
  const cues: { start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(ass))) {
    const start = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    const end = Number(m[4]) * 3600 + Number(m[5]) * 60 + Number(m[6]);
    cues.push({ start, end });
  }
  return cues;
}

function isMonotonic(cues: { start: number; end: number }[]): boolean {
  for (let i = 0; i < cues.length; i++) {
    if (cues[i].end + EPS < cues[i].start) return false; // end before start
    if (i > 0 && cues[i].start + EPS < cues[i - 1].start) return false; // starts go backwards
  }
  return true;
}

function within(
  cues: { start: number; end: number }[],
  segStart: number,
  segEnd: number
): boolean {
  return cues.every(
    (c) => c.start >= segStart - EPS && c.end <= segEnd + EPS
  );
}

/**
 * Deterministic caption-timing + normalization checks. Runs without ffmpeg,
 * TTS, or any network — safe to run anywhere.
 */
export async function runCaptionTimingChecks(): Promise<CaptionSmokeCheck[]> {
  const checks: CaptionSmokeCheck[] = [];

  // --- 1. Shared distribution: heuristic path -----------------------------
  {
    const words = "I really did not know what to do at all".split(" ");
    const segStart = 5;
    const dur = 4;
    const t = distributeWordTimings(words, segStart, dur);
    const ok =
      t.length === words.length &&
      Math.abs(t[0].start - segStart) < EPS &&
      Math.abs(t[t.length - 1].end - (segStart + dur)) < EPS &&
      t.every((w, i) => (i === 0 || w.start + EPS >= t[i - 1].end - EPS)) &&
      t.every((w) => w.start >= segStart - EPS && w.end <= segStart + dur + EPS);
    checks.push({
      id: "distribute_heuristic",
      ok,
      detail: ok
        ? "syllable-weighted: first word at segStart, last ends at segEnd, monotonic, bounded"
        : `bad heuristic distribution: ${JSON.stringify(t)}`,
    });
  }

  // --- 2. Shared distribution: real timings are honored + resynced --------
  {
    const words = ["one", "two", "three", "four"];
    const segStart = 10;
    const dur = 2;
    // Real windows in the clip's own 0-based frame; span already == dur.
    const real: RealWordTiming[] = [
      { start: 0.0, end: 0.2 },
      { start: 0.2, end: 1.2 }, // "two" deliberately long
      { start: 1.2, end: 1.5 },
      { start: 1.5, end: 2.0 },
    ];
    const t = distributeWordTimings(words, segStart, dur, real);
    const longWord = t[1].end - t[1].start;
    const shortWord = t[0].end - t[0].start;
    const ok =
      Math.abs(t[0].start - segStart) < EPS &&
      Math.abs(t[3].end - (segStart + dur)) < EPS &&
      longWord > shortWord + 0.3 && // the long real window stays clearly longer
      within(t, segStart, segStart + dur);
    checks.push({
      id: "distribute_real_timings",
      ok,
      detail: ok
        ? "real word windows preserved (long 'two' kept long) and endpoints resynced"
        : `real timings not honored: ${JSON.stringify(t)}`,
    });
  }

  // --- 3. Karaoke ASS: no 0.75 compression, ends at real audio end -------
  {
    const startTime = 3;
    const duration = 6;
    const ass = await generateKaraokeAssContent(
      [{ text: "the quick brown fox jumps over", startTime, duration }],
      { primaryColor: "#FFFFFF", secondaryColor: "#00FF00" }
    );
    const cues = parseAssCues(ass);
    const lastEnd = cues.length ? cues[cues.length - 1].end : 0;
    const firstStart = cues.length ? cues[0].start : -1;
    // The old bug: chunkSpeedMultiplier=0.75 → captions ended at 0.75*duration
    // (here ~4.5s) instead of 6s. Assert we now reach the real end.
    const endsAtAudioEnd = Math.abs(lastEnd - (startTime + duration)) < 0.15;
    const notCompressed = lastEnd > startTime + duration * 0.9;
    const hasAmber = /00FF00/i.test(ass); // active (secondary) colour present
    const ok =
      cues.length > 0 &&
      Math.abs(firstStart - startTime) < EPS &&
      endsAtAudioEnd &&
      notCompressed &&
      isMonotonic(cues) &&
      within(cues, startTime, startTime + duration) &&
      hasAmber;
    checks.push({
      id: "karaoke_no_compression",
      ok,
      detail: ok
        ? `karaoke cues span full ${duration}s of audio (last end ${lastEnd.toFixed(2)}s), monotonic, highlight present`
        : `karaoke timing wrong: firstStart=${firstStart}, lastEnd=${lastEnd}, expected end ${startTime + duration}`,
    });
  }

  // --- 4. Karaoke ASS honours supplied real word timings -----------------
  {
    const startTime = 0;
    const duration = 3;
    const text = "alpha beta gamma";
    const real: RealWordTiming[] = [
      { start: 0, end: 0.3 },
      { start: 0.3, end: 2.4 }, // "beta" long
      { start: 2.4, end: 3.0 },
    ];
    const ass = await generateKaraokeAssContent(
      [{ text, startTime, duration, words: real }],
      { wordsPerChunkMin: 3, wordsPerChunkMax: 3 }
    );
    const cues = parseAssCues(ass);
    // 3 words, one chunk → 3 cues; middle should be the longest.
    const ok =
      cues.length === 3 &&
      cues[1].end - cues[1].start > cues[0].end - cues[0].start + 0.5 &&
      Math.abs(cues[2].end - duration) < 0.15;
    checks.push({
      id: "karaoke_real_word_timings",
      ok,
      detail: ok
        ? "karaoke cue widths follow the real per-word windows"
        : `karaoke did not follow real timings: ${JSON.stringify(cues)}`,
    });
  }

  // --- 5. Bouncing (Reddit) captions: bounded + amber highlight ----------
  {
    const seg = {
      text: "this is a longer reddit sentence for timing",
      startTime: 2,
      speech: 5,
    };
    const ass = buildBouncingCaptions([seg]);
    const cues = parseAssCues(ass);
    const lastEnd = cues.length ? cues[cues.length - 1].end : 0;
    const hasAmber = /00D7FF/i.test(ass); // #FFD700 active inline colour
    const ok =
      cues.length > 0 &&
      Math.abs(cues[0].start - seg.startTime) < EPS &&
      Math.abs(lastEnd - (seg.startTime + seg.speech)) < 0.15 &&
      isMonotonic(cues) &&
      within(cues, seg.startTime, seg.startTime + seg.speech) &&
      hasAmber;
    checks.push({
      id: "bouncing_bounded_amber",
      ok,
      detail: ok
        ? `bouncing cues pinned to [${seg.startTime}, ${seg.startTime + seg.speech}]s, monotonic, amber highlight present`
        : `bouncing timing wrong: firstStart=${cues[0]?.start}, lastEnd=${lastEnd}`,
    });
  }

  // --- 6. Narration normalization (Issue 2) ------------------------------
  {
    const cases: { in: string; speech: string; caption: string }[] = [
      { in: "AITA for leaving", speech: "A.I.T.A. for leaving", caption: "AITA for leaving" },
      { in: "My (31M) wife", speech: "My (31 male) wife", caption: "My (31 male) wife" },
      { in: "i left bc she lied", speech: "i left because she lied", caption: "i left because she lied" },
      { in: "what the f*ck", speech: "what the fuck", caption: "what the fuck" },
      { in: "my SO and MIL", speech: "my significant other and mother in law", caption: "my significant other and mother in law" },
    ];
    const failures: string[] = [];
    for (const c of cases) {
      const n = normalizeNarration(c.in);
      const speechTokens = n.speech.split(/\s+/).length;
      const captionTokens = n.caption.split(/\s+/).length;
      if (n.speech !== c.speech) failures.push(`speech "${c.in}" → "${n.speech}" (want "${c.speech}")`);
      if (n.caption !== c.caption) failures.push(`caption "${c.in}" → "${n.caption}" (want "${c.caption}")`);
      if (speechTokens !== captionTokens)
        failures.push(`token count mismatch for "${c.in}": speech ${speechTokens} vs caption ${captionTokens}`);
    }
    checks.push({
      id: "narration_normalize",
      ok: failures.length === 0,
      detail: failures.length === 0
        ? "acronyms letter-spelled, age/gender + shorthand expanded, profanity de-censored, speech↔caption token counts aligned"
        : failures.join(" | "),
    });
  }

  return checks;
}
