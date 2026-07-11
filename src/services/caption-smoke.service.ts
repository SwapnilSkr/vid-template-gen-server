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
