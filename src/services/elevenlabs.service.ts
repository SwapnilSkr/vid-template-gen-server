import { ElevenLabsClient } from "elevenlabs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { getErrorMessage, type VoiceSettings } from "../types";
import { ensureDir, generateFilename } from "../utils";

// Initialize ElevenLabs client
const client = new ElevenLabsClient({
  apiKey: config.elevenLabsApiKey,
});

// Audio cache to avoid regenerating identical content
const audioCache = new Map<string, string>();

/**
 * Generate cache key for audio
 */
function getCacheKey(text: string, voiceId: string): string {
  return `${voiceId}:${text}`;
}

/**
 * Generate speech audio from text using ElevenLabs
 */
export async function generateSpeech(
  text: string,
  voiceId: string,
  outputDir?: string,
  settings?: Partial<VoiceSettings>
): Promise<{ audioPath: string; duration: number }> {
  const cacheKey = getCacheKey(text, voiceId);

  // Check cache
  const cached = audioCache.get(cacheKey);
  if (cached) {
    return { audioPath: cached, duration: await getAudioDuration(cached) };
  }

  const targetDir = outputDir || config.processingPath;
  await ensureDir(targetDir);

  const filename = generateFilename("speech", "mp3");
  const audioPath = join(targetDir, filename);

  try {
    const audio = await client.generate({
      voice: voiceId,
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: settings
        ? {
            stability: settings.stability ?? 0.5,
            similarity_boost: settings.similarityBoost ?? 0.75,
            style: settings.style ?? 0.5,
            use_speaker_boost: settings.useSpeakerBoost ?? true,
          }
        : undefined,
    });

    // Convert stream to buffer
    const chunks: Uint8Array[] = [];
    for await (const chunk of audio) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    await writeFile(audioPath, buffer);

    // Cache the result
    audioCache.set(cacheKey, audioPath);

    const duration = await getAudioDuration(audioPath);

    console.log(
      `🎤 Generated speech: "${text.substring(0, 30)}..." (${duration.toFixed(
        2
      )}s)`
    );

    return { audioPath, duration };
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
