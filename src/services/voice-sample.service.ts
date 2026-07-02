import { readFile, unlink } from "node:fs/promises";
import { generateNarration } from "./openrouter-media.service";
import { keyExists, uploadToS3, cdnUrlFor } from "./s3.service";

// ============================================
// Cached voice preview samples — a short, fixed line of narration rendered
// once per (model, voice) pair and reused forever, so "listen before you
// pick" in the revoice/create UI doesn't re-spend TTS calls on repeat plays.
// ============================================

const SAMPLE_TEXT =
  "Hey, this is a quick preview of how this voice sounds when it tells a story.";

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function sampleKey(model: string, voice: string): string {
  return `voice-samples/${sanitize(model)}__${sanitize(voice)}.mp3`;
}

/** Return a cached sample URL for this voice, generating + caching it on first request. */
export async function getVoiceSample(
  model: string,
  voice: string,
  format: "mp3" | "pcm"
): Promise<string> {
  const key = sampleKey(model, voice);
  if (await keyExists(key)) return cdnUrlFor(key);

  const { audioPath } = await generateNarration(SAMPLE_TEXT, { model, voice, format });
  try {
    const buffer = await readFile(audioPath);
    await uploadToS3(buffer, "voice-samples", `${sanitize(model)}__${sanitize(voice)}.mp3`, "audio/mpeg");
    return cdnUrlFor(key);
  } finally {
    await unlink(audioPath).catch(() => {});
  }
}
