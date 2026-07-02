import ffmpeg from "fluent-ffmpeg";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { resolveModels } from "../config/models";
import { getErrorMessage } from "../types";
import { ensureDir, generateFilename } from "../utils";

// ============================================
// OpenRouter media generation — single-provider stack.
// Images via /chat/completions (image modality), TTS via /audio/speech.
// Model choices come from the registry (config/models.ts) — pass an override
// to pin a specific model/voice, otherwise the active tier's default is used.
// ============================================

/** Negative suffix — image models (esp. Nano Banana) stamp garbled fake text
 * unless explicitly told not to. Learned in the render lab. */
const NO_TEXT_SUFFIX =
  "no text, no watermark, no caption, no lettering, no subtitles, no border, no signature";

/**
 * Generate a still image from a prompt. Returns a local PNG path.
 * Models return square (e.g. 1024x1024); the renderer scales+crops to 9:16.
 */
export async function generateImage(
  prompt: string,
  styleSuffix = "",
  opts: { model?: string; outputDir?: string } = {}
): Promise<string> {
  const targetDir = opts.outputDir || config.processingPath;
  const model = opts.model || resolveModels().image;
  await ensureDir(targetDir);

  const fullPrompt = [prompt, styleSuffix, NO_TEXT_SUFFIX]
    .filter(Boolean)
    .join(". ");

  try {
    const res = await fetch(`${config.openRouterBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openRouterApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        modalities: ["image", "text"],
        messages: [{ role: "user", content: fullPrompt }],
      }),
    });

    if (!res.ok) {
      throw new Error(`Image API ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      choices?: { message?: { images?: { image_url?: { url?: string } }[] } }[];
    };
    const url = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;
    if (!url) {
      throw new Error("No image returned from model");
    }

    // url is a data URI: data:image/png;base64,XXXX
    const base64 = url.includes(",") ? url.split(",", 2)[1] : url;
    const buffer = Buffer.from(base64, "base64");

    const imagePath = join(targetDir, generateFilename("scene", "png"));
    await writeFile(imagePath, buffer);
    console.log(`🖼️  Generated image: "${prompt.substring(0, 40)}..."`);
    return imagePath;
  } catch (error: unknown) {
    throw new Error(`Image generation failed: ${getErrorMessage(error)}`);
  }
}

/**
 * Generate narration audio. Returns a local MP3 path + duration (seconds).
 * Leading/trailing silence is trimmed so scenes flow without dead air — the
 * fix for "too much gap between the audios". TTS clips ship with ~0.3-0.6s of
 * baked-in silence at each end that otherwise compounds across scenes.
 */
export async function generateNarration(
  text: string,
  opts: { model?: string; voice?: string; format?: "mp3" | "pcm"; outputDir?: string } = {}
): Promise<{ audioPath: string; duration: number }> {
  const targetDir = opts.outputDir || config.processingPath;
  const tts = resolveModels().tts;
  const model = opts.model || tts.model;
  const voice = opts.voice || tts.voice;
  const format = opts.format || tts.format; // some models (Gemini) only emit pcm

  await ensureDir(targetDir);

  let rawPath = "";
  try {
    const res = await fetch(`${config.openRouterBaseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openRouterApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: text,
        voice,
        response_format: format,
      }),
    });

    if (!res.ok) {
      throw new Error(`TTS API ${res.status}: ${await res.text()}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const rawExt = format === "pcm" ? "pcm" : "mp3";
    rawPath = join(targetDir, generateFilename("narration_raw", rawExt));
    await writeFile(rawPath, buffer);

    // pcm (raw s16le 24kHz mono from Gemini TTS) → mp3 before trimming
    let mp3Src = rawPath;
    if (format === "pcm") {
      mp3Src = join(targetDir, generateFilename("narration_pcm", "mp3"));
      await pcmToMp3(rawPath, mp3Src);
    }

    const audioPath = join(targetDir, generateFilename("narration", "mp3"));
    await trimSilence(mp3Src, audioPath);
    await unlink(rawPath).catch(() => {});
    if (mp3Src !== rawPath) await unlink(mp3Src).catch(() => {});

    const duration = await getAudioDuration(audioPath);
    console.log(
      `🎤 Narration [${model}/${voice}]: "${text.substring(0, 30)}..." (${duration.toFixed(2)}s)`
    );
    return { audioPath, duration };
  } catch (error: unknown) {
    if (rawPath) await unlink(rawPath).catch(() => {});
    throw new Error(`Narration failed: ${getErrorMessage(error)}`);
  }
}

/** Convert raw s16le/24kHz/mono PCM (Gemini TTS output) to mp3. */
function pcmToMp3(input: string, output: string): Promise<string> {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .inputOptions(["-f", "s16le", "-ar", "24000", "-ac", "1"])
      .outputOptions(["-c:a", "libmp3lame", "-q:a", "4"])
      .output(output)
      .on("end", () => resolve(output))
      .on("error", (err) => reject(new Error(`PCM→MP3 failed: ${err.message}`)))
      .run();
  });
}

/**
 * Trim leading and trailing silence. The areverse trick: trim leading silence,
 * reverse, trim leading silence again (= original trailing), reverse back.
 */
function trimSilence(input: string, output: string): Promise<string> {
  const trim =
    "silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB:detection=peak";
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .audioFilters(`${trim},areverse,${trim},areverse`)
      .outputOptions(["-c:a", "libmp3lame", "-q:a", "4"])
      .output(output)
      .on("end", () => resolve(output))
      .on("error", (err) => reject(new Error(`Silence trim failed: ${err.message}`)))
      .run();
  });
}

/** Get audio duration via ffprobe. */
export function getAudioDuration(audioPath: string): Promise<number> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(audioPath, (err, metadata) => {
      if (err) {
        console.warn("Could not probe audio duration, defaulting to 3s");
        resolve(3);
        return;
      }
      resolve(metadata.format.duration || 3);
    });
  });
}
