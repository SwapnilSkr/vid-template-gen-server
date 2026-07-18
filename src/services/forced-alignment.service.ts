import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { config } from "../config";
import type { RealWordTiming } from "../utils/caption-timing";

// ============================================
// Forced word alignment (provider-independent).
//
// Issue 1 asks that the amber caption highlight track the ACTUAL spoken word,
// without depending on any particular TTS model. The cleanest provider-neutral
// way to get real word timestamps is to run a local speech recognizer over the
// already-rendered narration audio and read back its word offsets — offline,
// free, and identical regardless of which TTS produced the audio.
//
// This module is a thin, defensive wrapper around the local whisper.cpp CLI,
// following the same "bundle native tooling" pattern as ffmpeg. It is
// intentionally BEST-EFFORT:
//
//   • It is disabled by default (config.whisperAlignmentEnabled) so local
//     development does not gain a hidden model download.
//   • If the binding/model is missing or recognition fails, it returns null and
//     callers fall back to the syllable-weighted heuristic in caption-timing.ts
//     (which already hard-resyncs every segment, so drift stays bounded).
//
// To enable it locally, run `bun run whisper:install`, then set
// WHISPER_ALIGNMENT_ENABLED=true in .env.local. The base.en model is about
// 142 MB and is stored under storage/whisper/, which is gitignored.
// ============================================

/** One recognised word with its audio offset (seconds), from the aligner. */
interface RecognizedWord {
  word: string;
  start: number;
  end: number;
}

let alignerUnavailableLogged = false;
let alignerActiveLogged = false;

/** Readiness for the local, provider-independent word aligner. This is kept
 * separate from a successful render: it tells Studio whether the next Reddit
 * render can attempt Whisper alignment, while the render itself still safely
 * falls back when speech recognition cannot map the narration exactly. */
export interface WordAlignmentStatus {
  enabled: boolean;
  ready: boolean;
  detail: string;
}

export async function getWordAlignmentStatus(): Promise<WordAlignmentStatus> {
  if (!config.whisperAlignmentEnabled) {
    return {
      enabled: false,
      ready: false,
      detail: "Off — set WHISPER_ALIGNMENT_ENABLED=true to use local word sync on new Reddit renders.",
    };
  }

  try {
    await access(config.whisperModelPath);
  } catch {
    return {
      enabled: true,
      ready: false,
      detail: `Model not found at ${config.whisperModelPath}. Run bun run whisper:install.`,
    };
  }

  try {
    await runCommand(config.whisperCliPath, ["--help"]);
    return {
      enabled: true,
      ready: true,
      detail: "Ready — new Reddit renders will attempt local Whisper word timing, then safely fall back if speech does not map cleanly.",
    };
  } catch (error) {
    return {
      enabled: true,
      ready: false,
      detail: `Whisper CLI is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Attempt to obtain real per-word timings for `captionTokens` spoken in
 * `audioPath`. Returns timings aligned 1:1 with `captionTokens`, or null when
 * alignment is unavailable/unreliable (caller then uses the heuristic).
 *
 * The returned windows are in the audio file's own frame (seconds from 0);
 * distributeWordTimings re-anchors them onto the final timeline, so this only
 * needs to get the RELATIVE word rhythm right.
 */
export async function alignWordsToAudio(
  audioPath: string,
  captionTokens: string[]
): Promise<RealWordTiming[] | null> {
  if (!config.whisperAlignmentEnabled) return null;
  if (captionTokens.length === 0) return null;

  try {
    const recognized = await runWhisper(audioPath);
    if (!recognized || recognized.length === 0) return null;
    const mapped = mapRecognizedToTokens(recognized, captionTokens);
    if (mapped && !alignerActiveLogged) {
      alignerActiveLogged = true;
      console.log(`🎯 Forced caption alignment active (${mapped.length} real word timestamps)`);
    }
    return mapped;
  } catch (error) {
    if (!alignerUnavailableLogged) {
      alignerUnavailableLogged = true;
      console.warn(
        `⚠️  Forced alignment unavailable — falling back to heuristic caption timing. Cause: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    return null;
  }
}

/** Run whisper.cpp over the audio and flatten its word-sized JSON segments. */
async function runWhisper(audioPath: string): Promise<RecognizedWord[] | null> {
  await Promise.all([access(audioPath), access(config.whisperModelPath)]);
  const root = await mkdtemp(join(tmpdir(), "vidgen-whisper-"));
  const wavPath = join(root, "narration.wav");
  const outputBase = join(root, "alignment");

  try {
    // whisper.cpp is most portable with 16 kHz mono PCM. Converting here also
    // means the Docker build does not need whisper.cpp's optional ffmpeg build.
    await runCommand(config.ffmpegPath, [
      "-y", "-v", "error", "-i", audioPath,
      "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath,
    ]);
    await runCommand(config.whisperCliPath, [
      "-m", config.whisperModelPath,
      "-f", wavPath,
      "-l", "en",
      "-ml", "1", // one output segment per recognised word
      "-sow", // never split a word at a token boundary
      "-oj",
      "-of", outputBase,
      "-np",
    ]);
    return parseWhisperWords(JSON.parse(await readFile(`${outputBase}.json`, "utf8")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? "unknown"}: ${stderr.slice(-500)}`));
    });
  });
}

/** Best-effort parse of nodejs-whisper output into word windows. */
function parseWhisperWords(result: unknown): RecognizedWord[] | null {
  const json =
    typeof result === "string" ? safeJsonParse(result) : (result as unknown);
  const record = json as { transcription?: unknown; words?: unknown } | null;
  if (!record) return null;

  const rawWords = Array.isArray(record.words)
    ? record.words
    : Array.isArray(record.transcription)
      ? (record.transcription as unknown[]).flatMap((seg) => {
          const s = seg as { words?: unknown; text?: unknown; timestamps?: unknown };
          // node bindings tend to nest a `words` array per sentence, whereas
          // whisper.cpp with -ml 1/-sow returns each word-sized segment itself.
          return Array.isArray(s.words) ? s.words : s.text && s.timestamps ? [s] : [];
        })
      : [];

  const words: RecognizedWord[] = [];
  for (const entry of rawWords) {
    const w = entry as {
      word?: string;
      text?: string;
      start?: number | string;
      end?: number | string;
      offsets?: { from?: number; to?: number };
      timestamps?: { from?: string; to?: string };
    };
    const text = (w.word ?? w.text ?? "").toString().trim();
    if (!text) continue;
    // whisper.cpp exposes both human timestamps and numeric millisecond
    // offsets. Do not use a magnitude heuristic here: a 200 ms first word
    // would otherwise be read as 200 seconds. Other adapters may provide
    // start/end directly in seconds.
    const start = w.timestamps?.from !== undefined
      ? toTimestampSeconds(w.timestamps.from)
      : w.offsets?.from !== undefined
        ? Number(w.offsets.from) / 1000
        : toSeconds(w.start);
    const end = w.timestamps?.to !== undefined
      ? toTimestampSeconds(w.timestamps.to)
      : w.offsets?.to !== undefined
        ? Number(w.offsets.to) / 1000
        : toSeconds(w.end);
    if (start === undefined || end === undefined) continue;
    words.push({ word: text, start, end });
  }
  return words.length ? words : null;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Generic SDK word timings are expressed in seconds. */
function toSeconds(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return undefined;
  return n;
}

function toTimestampSeconds(value: string): number | undefined {
  if (!/^\d\d:\d\d:\d\d[.,]\d+$/u.test(value)) return undefined;
  const [hours, minutes, seconds] = value.replace(",", ".").split(":");
  const n = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Map the recognizer's words back onto the KNOWN caption tokens. We trust the
 * script for spelling (the tokens we will actually render) and only borrow the
 * timing rhythm. Recognisers occasionally merge/split words. In that case we
 * deliberately return null: manufacturing a proportional replacement would
 * look "aligned" but would not be genuinely word-accurate. The caller's
 * bounded syllable fallback is the honest, safe result.
 */
function mapRecognizedToTokens(
  recognized: RecognizedWord[],
  captionTokens: string[]
): RealWordTiming[] | null {
  const n = captionTokens.length;
  if (recognized.length === n) {
    return recognized.map((r) => ({ start: r.start, end: r.end }));
  }
  return null;
}
