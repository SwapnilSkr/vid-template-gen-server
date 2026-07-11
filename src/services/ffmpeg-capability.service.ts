/**
 * Lightweight FFmpeg / libass / font capability probe for produce gates.
 * Cached briefly so create → regenerate → resume in the same request don't
 * re-spawn ffmpeg on every click.
 */
import { spawnSync } from "node:child_process";
import { config } from "../config";
import { FONTS_DIR, hasBundledFonts, listFonts } from "../config/fonts";

export const FFMPEG_UNAVAILABLE = "FFMPEG_UNAVAILABLE";
export const CAPTION_BURN_FAILED = "CAPTION_BURN_FAILED";

export class FfmpegUnavailableError extends Error {
  readonly code = FFMPEG_UNAVAILABLE;
  readonly capability: FfmpegCapability;
  constructor(capability: FfmpegCapability, context = "Video generation") {
    const hints = capability.fixHints.length
      ? ` Fix: ${capability.fixHints.join(" ")}`
      : "";
    super(`${context}: ${capability.message}${hints}`);
    this.name = "FfmpegUnavailableError";
    this.capability = capability;
  }
}

export class CaptionBurnError extends Error {
  readonly code = CAPTION_BURN_FAILED;
  constructor(message: string) {
    super(message);
    this.name = "CaptionBurnError";
  }
}

export interface FfmpegCapability {
  ok: boolean;
  code?: typeof FFMPEG_UNAVAILABLE;
  ffmpegPath: string;
  ffmpegOk: boolean;
  hasAssFilter: boolean;
  fontsOk: boolean;
  fontCount: number;
  fontsDir: string;
  version?: string;
  message: string;
  fixHints: string[];
}

let cached: { at: number; value: FfmpegCapability } | undefined;
const CACHE_MS = 15_000;

function probeOnce(): FfmpegCapability {
  const ffmpegPath = config.ffmpegPath || "ffmpeg";
  const fixHints: string[] = [];

  const ver = spawnSync(ffmpegPath, ["-version"], { encoding: "utf8" });
  const ffmpegOk = ver.status === 0;
  const version = ffmpegOk
    ? (ver.stdout || ver.stderr).split("\n")[0]?.trim()
    : undefined;
  if (!ffmpegOk) {
    fixHints.push(
      "Install FFmpeg and ensure it is on PATH (macOS: brew install ffmpeg).",
      "Or set FFMPEG_PATH to the full binary path in server/.env."
    );
  }

  let hasAssFilter = false;
  if (ffmpegOk) {
    const filters = spawnSync(ffmpegPath, ["-hide_banner", "-filters"], {
      encoding: "utf8",
    });
    hasAssFilter = /\bass\b/.test((filters.stdout || "") + (filters.stderr || ""));
    if (!hasAssFilter) {
      fixHints.push(
        "This FFmpeg build is missing the `ass` filter (libass). Reinstall a full build (brew reinstall ffmpeg)."
      );
    }
  }

  const fontsOk = hasBundledFonts();
  const fontCount = listFonts().length;
  if (!fontsOk) {
    fixHints.push(`Run: cd server && bun run fetch-fonts  (missing fonts in ${FONTS_DIR})`);
  }

  const ok = ffmpegOk && hasAssFilter && fontsOk;
  const message = ok
    ? `FFmpeg ready for caption burns (${version ?? ffmpegPath})`
    : !ffmpegOk
      ? "FFmpeg is not installed or not runnable on this device. Video generation cannot start until FFmpeg is available."
      : !hasAssFilter
        ? "FFmpeg is installed but missing libass (`ass` filter). Captions cannot be burned into videos."
        : "Bundled caption fonts are missing. Run `bun run fetch-fonts` in the server package.";

  return {
    ok,
    code: ok ? undefined : FFMPEG_UNAVAILABLE,
    ffmpegPath,
    ffmpegOk,
    hasAssFilter,
    fontsOk,
    fontCount,
    fontsDir: FONTS_DIR,
    version,
    message,
    fixHints,
  };
}

/** Fresh or cached capability snapshot (15s TTL). */
export function checkFfmpegCapability(options?: {
  fresh?: boolean;
}): FfmpegCapability {
  if (!options?.fresh && cached && Date.now() - cached.at < CACHE_MS) {
    return cached.value;
  }
  const value = probeOnce();
  cached = { at: Date.now(), value };
  return value;
}

/**
 * Throw when produce/render cannot safely run.
 * Uses the 15s cache by default; pass `{ fresh: true }` right before paid asset
 * spend so a mid-session ffmpeg uninstall is still caught.
 */
export function assertFfmpegReady(
  context = "Video generation",
  options?: { fresh?: boolean }
): void {
  const cap = checkFfmpegCapability(options);
  if (!cap.ok) throw new FfmpegUnavailableError(cap, context);
}

/** Shared caption-burn failure — keeps paid S3 assets for Resume. */
export function captionBurnFailed(cause: string, detail?: string): never {
  const suffix = detail ? ` ${detail}` : "";
  throw new CaptionBurnError(
    `Caption burn failed (paid assets kept — use Resume after fixing FFmpeg/fonts).${suffix} Cause: ${cause}`
  );
}

export function isFfmpegUnavailableError(
  error: unknown
): error is FfmpegUnavailableError {
  return (
    error instanceof FfmpegUnavailableError ||
    (error instanceof Error &&
      (error as { code?: string }).code === FFMPEG_UNAVAILABLE)
  );
}

export function isCaptionBurnError(error: unknown): error is CaptionBurnError {
  return (
    error instanceof CaptionBurnError ||
    (error instanceof Error &&
      (error as { code?: string }).code === CAPTION_BURN_FAILED)
  );
}

/** Map unknown errors to HTTP status + JSON body for Elysia controllers. */
export function httpErrorFromUnknown(error: unknown): {
  status: number;
  body: { success: false; error: string; code?: string };
} {
  const message = error instanceof Error ? error.message : String(error);
  if (isFfmpegUnavailableError(error)) {
    return {
      status: 503,
      body: { success: false, error: message, code: FFMPEG_UNAVAILABLE },
    };
  }
  if (isCaptionBurnError(error)) {
    return {
      status: 500,
      body: { success: false, error: message, code: CAPTION_BURN_FAILED },
    };
  }
  return { status: 400, body: { success: false, error: message } };
}
