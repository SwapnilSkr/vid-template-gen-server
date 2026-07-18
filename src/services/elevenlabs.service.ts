import { ElevenLabsClient } from "elevenlabs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { getErrorMessage, type VoiceSettings } from "../types";
import { ensureDir, generateFilename } from "../utils";
import type { WordTiming } from "../utils/caption-timing";

// Initialize ElevenLabs client
const client = new ElevenLabsClient({
  apiKey: config.elevenLabsApiKey,
});

// Audio cache to avoid regenerating identical content. Value carries the
// captured word timings too so a cache hit is still a fully-timed result.
interface CachedSpeech {
  audioPath: string;
  words?: WordTiming[];
}
const audioCache = new Map<string, CachedSpeech>();

export interface GeneratedSpeech {
  audioPath: string;
  duration: number;
  /** Real per-word timings (seconds, relative to this clip) when the timestamp
   *  API succeeded — thread into generateKaraokeAssContent for exact sync. */
  words?: WordTiming[];
}

/**
 * Generate cache key for audio
 */
function getCacheKey(text: string, voiceId: string): string {
  return `${voiceId}:${text}`;
}

function buildVoiceSettings(settings?: Partial<VoiceSettings>) {
  return settings
    ? {
        stability: settings.stability ?? 0.5,
        similarity_boost: settings.similarityBoost ?? 0.75,
        style: settings.style ?? 0.5,
        use_speaker_boost: settings.useSpeakerBoost ?? true,
      }
    : undefined;
}

/**
 * Collapse ElevenLabs per-CHARACTER timestamps into per-WORD windows. A word
 * spans from its first character's start to its last character's end; runs of
 * whitespace delimit words. This gives the karaoke highlighter real, exact word
 * timing for the AI-image niches (free, provider-native — no forced aligner).
 */
function charAlignmentToWords(alignment: {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}): WordTiming[] {
  const { characters, character_start_times_seconds: starts, character_end_times_seconds: ends } =
    alignment;
  const words: WordTiming[] = [];
  let current = "";
  let wordStart = 0;
  let wordEnd = 0;
  let inWord = false;

  const flush = (): void => {
    if (inWord && current.trim()) {
      words.push({ word: current, start: wordStart, end: wordEnd });
    }
    current = "";
    inWord = false;
  };

  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i];
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if (!inWord) {
      inWord = true;
      wordStart = starts[i] ?? wordEnd;
    }
    current += ch;
    wordEnd = ends[i] ?? wordStart;
  }
  flush();
  return words;
}

/**
 * Generate speech audio from text using ElevenLabs. Uses the timestamp API so
 * real word timings come back with the audio; falls back to the plain streaming
 * synth (no timings) if the timestamp endpoint is unavailable.
 */
export async function generateSpeech(
  text: string,
  voiceId: string,
  outputDir?: string,
  settings?: Partial<VoiceSettings>
): Promise<GeneratedSpeech> {
  const cacheKey = getCacheKey(text, voiceId);

  // Check cache
  const cached = audioCache.get(cacheKey);
  if (cached) {
    return {
      audioPath: cached.audioPath,
      duration: await getAudioDuration(cached.audioPath),
      words: cached.words,
    };
  }

  const targetDir = outputDir || config.processingPath;
  await ensureDir(targetDir);

  const filename = generateFilename("speech", "mp3");
  const audioPath = join(targetDir, filename);
  const voice_settings = buildVoiceSettings(settings);

  try {
    let words: WordTiming[] | undefined;
    let buffer: Buffer | undefined;

    // Preferred: timestamped synth (audio + character alignment in one call).
    try {
      const result = await client.textToSpeech.convertWithTimestamps(voiceId, {
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings,
      });
      buffer = Buffer.from(result.audio_base64, "base64");
      const alignment = result.alignment ?? result.normalized_alignment;
      if (alignment) words = charAlignmentToWords(alignment);
    } catch (timestampError: unknown) {
      console.warn(
        `ElevenLabs timestamp synth unavailable, falling back to plain synth: ${getErrorMessage(
          timestampError
        )}`
      );
    }

    // Fallback: streaming synth without timings.
    if (!buffer) {
      const audio = await client.generate({
        voice: voiceId,
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings,
      });
      const chunks: Uint8Array[] = [];
      for await (const chunk of audio) {
        chunks.push(chunk);
      }
      buffer = Buffer.concat(chunks);
    }

    await writeFile(audioPath, buffer);

    // Cache the result (audio + timings)
    audioCache.set(cacheKey, { audioPath, words });

    const duration = await getAudioDuration(audioPath);

    console.log(
      `🎤 Generated speech: "${text.substring(0, 30)}..." (${duration.toFixed(
        2
      )}s${words ? `, ${words.length} word timings` : ""})`
    );

    return { audioPath, duration, words };
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    console.error("ElevenLabs error:", message);
    throw new Error(`Failed to generate speech: ${message}`);
  }
}

/**
 * Get list of available voices
 */
export async function getVoices(): Promise<{ id: string; name: string }[]> {
  try {
    const voices = await client.voices.getAll();
    return voices.voices.map((v) => ({
      id: v.voice_id,
      name: v.name || "Unknown",
    }));
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    console.error("Failed to get voices:", message);
    throw new Error(`Failed to get voices: ${message}`);
  }
}

/**
 * Get audio duration using ffprobe
 */
async function getAudioDuration(audioPath: string): Promise<number> {
  const ffmpeg = await import("fluent-ffmpeg");

  return new Promise((resolve, _reject) => {
    ffmpeg.default.ffprobe(audioPath, (err, metadata) => {
      if (err) {
        // Fallback: estimate based on text length (rough approximation)
        console.warn("Could not get audio duration, using estimate");
        resolve(3); // default 3 seconds
        return;
      }
      resolve(metadata.format.duration || 3);
    });
  });
}

/**
 * Clear audio cache
 */
export function clearAudioCache(): void {
  audioCache.clear();
}
