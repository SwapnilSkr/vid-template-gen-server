import ffmpeg from "fluent-ffmpeg";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { resolveModels, resolveTtsChoice, type TtsChoice } from "../config/models";
import { getErrorMessage } from "../types";
import { ensureDir, generateFilename } from "../utils";
import { recordOperationLog } from "./operation-log.service";

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

const TTS_MAX_ATTEMPTS = 3;
const TTS_FALLBACK: TtsChoice = {
  model: "google/gemini-3.1-flash-tts-preview",
  voice: "Charon",
  format: "pcm",
};
const IMAGE_FALLBACK_MODEL = "google/gemini-3.1-flash-lite-image";

/**
 * TTS is charged per input character. Normally this comes from OpenRouter's
 * models endpoint; this conservative fallback keeps accounting visible if that
 * endpoint is briefly unavailable. It matches Grok Voice TTS 1.0's published
 * $15 / million character price, rather than silently dropping audio spend.
 */
const DEFAULT_TTS_CHARACTER_PRICE_USD = 0.000015;
const TTS_CHARACTER_PRICE_FALLBACKS: Record<string, number> = {
  "x-ai/grok-voice-tts-1.0": 0.000015,
};

export interface MediaUsageCost {
  costUsd?: number;
  source: "openrouter_usage" | "openrouter_generation" | "estimated";
  generationId?: string;
}

export type MediaUsageCallback = (usage: MediaUsageCost) => void;
export type NarrationProfile = "horror" | "reddit" | "whisper" | "phone" | "tape" | "distant";

interface ImageModelCapability {
  supported_parameters?: Record<string, { type: string; values?: string[] }>;
}

let imageCapabilityCache: Map<string, ImageModelCapability> | undefined;
let ttsCharacterPriceCache: Promise<Map<string, number>> | undefined;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function parseCost(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Fetch OpenRouter's current per-character TTS pricing once per process. */
async function getTtsCharacterPrice(model: string): Promise<number> {
  if (!ttsCharacterPriceCache) {
    ttsCharacterPriceCache = (async () => {
      try {
        const res = await fetch(`${config.openRouterBaseUrl}/models?output_modalities=speech`, {
          headers: { Authorization: `Bearer ${config.openRouterApiKey}` },
        });
        if (!res.ok) throw new Error(`Models API ${res.status}`);
        const data = (await res.json()) as {
          data?: { id?: string; pricing?: { prompt?: number | string } }[];
        };
        return new Map(
          (data.data ?? [])
            .flatMap((item) => {
              const price = parseCost(item.pricing?.prompt);
              return item.id && price !== undefined ? [[item.id, price] as const] : [];
            }),
        );
      } catch (error) {
        console.warn(`⚠️ TTS pricing lookup unavailable: ${getErrorMessage(error)}`);
        return new Map<string, number>();
      }
    })();
  }

  const prices = await ttsCharacterPriceCache;
  return prices.get(model) ?? TTS_CHARACTER_PRICE_FALLBACKS[model] ?? DEFAULT_TTS_CHARACTER_PRICE_USD;
}

async function estimateTtsCost(model: string, text: string): Promise<number> {
  return text.length * (await getTtsCharacterPrice(model));
}

async function fetchGenerationCost(generationId?: string): Promise<number | undefined> {
  if (!generationId) return undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(750 * attempt);
    try {
      const res = await fetch(`${config.openRouterBaseUrl}/generation?id=${encodeURIComponent(generationId)}`, {
        headers: { Authorization: `Bearer ${config.openRouterApiKey}` },
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { data?: { total_cost?: number | string; usage?: number | string } };
      return parseCost(data.data?.total_cost) ?? parseCost(data.data?.usage);
    } catch {
      // Accounting should never break generation.
    }
  }
  return undefined;
}

async function getImageModelCapability(model: string): Promise<ImageModelCapability | undefined> {
  if (!imageCapabilityCache) {
    try {
      const res = await fetch(`${config.openRouterBaseUrl}/images/models`, {
        headers: { Authorization: `Bearer ${config.openRouterApiKey}` },
      });
      const json = (await res.json()) as { data?: (ImageModelCapability & { id: string })[] };
      imageCapabilityCache = new Map((json.data ?? []).map((item) => [item.id, item]));
    } catch {
      imageCapabilityCache = new Map();
    }
  }
  return imageCapabilityCache.get(model);
}

function supportsValue(capability: ImageModelCapability | undefined, key: string, value: string): boolean {
  const descriptor = capability?.supported_parameters?.[key];
  return Boolean(descriptor && (!descriptor.values || descriptor.values.includes(value)));
}

/** Whether a model advertises reference-image / image-editing conditioning
 * (OpenRouter `input_references`). Reference-art styles only take effect on
 * models that support this — otherwise we silently fall back to prompt-only. */
export function supportsReferenceImages(capability: ImageModelCapability | undefined): boolean {
  return Boolean(capability?.supported_parameters?.input_references);
}

/** Public capability probe for the model catalog (reference-art support badge). */
export async function modelSupportsReferenceImages(model: string): Promise<boolean> {
  return supportsReferenceImages(await getImageModelCapability(model));
}

function enumValues(capability: ImageModelCapability | undefined, key: string): string[] {
  return capability?.supported_parameters?.[key]?.values ?? [];
}

function isImageValidationError(status: number, body: string): boolean {
  return status === 400 && /size|pixel|resolution|parameter|aspect|format|quality|background/i.test(body);
}

function imageRequestBodies(
  model: string,
  prompt: string,
  capability: ImageModelCapability | undefined,
  referenceImageUrls?: string[]
): Record<string, unknown>[] {
  const base: Record<string, unknown> = { model, prompt, n: 1 };
  if (supportsValue(capability, "aspect_ratio", "9:16")) base.aspect_ratio = "9:16";
  if (supportsValue(capability, "output_format", "png")) base.output_format = "png";
  // Reference-art conditioning — only when the model advertises it, else the
  // request is rejected. Falls back to prompt-only for unsupported models.
  // Each reference is a chat-style image part: { type: "image_url",
  // image_url: { url } }. The API rejects bare strings and a flat image_url
  // string (Zod: type must be "image_url"; image_url must be an object).
  const refs = referenceImageUrls?.filter(Boolean) ?? [];
  if (refs.length && supportsReferenceImages(capability)) {
    base.input_references = refs.map((url) => ({ type: "image_url", image_url: { url } }));
  }

  const bodies: Record<string, unknown>[] = [];
  const resolutions = enumValues(capability, "resolution");
  if (!resolutions.length) return [base, { model, prompt, n: 1 }];

  const preferred = model.includes("seedream")
    ? ["4K", "2K", "1K", "512"]
    : ["1K", "2K", "4K", "512"];
  const ordered = preferred.filter((value) => resolutions.includes(value));
  for (const value of resolutions) {
    if (!ordered.includes(value)) ordered.push(value);
  }

  for (const resolution of ordered) {
    bodies.push({ ...base, resolution });
  }
  bodies.push({ model, prompt, n: 1 });
  return bodies;
}

/**
 * Generate a still image from a prompt. Returns a local PNG path.
 * Models return square (e.g. 1024x1024); the renderer scales+crops to 9:16.
 */
export async function generateImage(
  prompt: string,
  styleSuffix = "",
  opts: {
    model?: string;
    outputDir?: string;
    onUsage?: MediaUsageCallback;
    /** reference-art images (S3/CDN URLs) → `input_references` on supported models */
    referenceImageUrls?: string[];
  } = {}
): Promise<string> {
  const targetDir = opts.outputDir || config.processingPath;
  const model = opts.model || resolveModels().image;
  await ensureDir(targetDir);

  const fullPrompt = [prompt, styleSuffix, NO_TEXT_SUFFIX]
    .filter(Boolean)
    .join(". ");

  const modelsToTry = model === IMAGE_FALLBACK_MODEL ? [model] : [model, IMAGE_FALLBACK_MODEL];
  const attempt = async (refs?: string[]): Promise<string> => {
    let lastError: unknown;
    for (const activeModel of modelsToTry) {
      try {
        return await generateImageWithModel(activeModel, fullPrompt, prompt, targetDir, opts.onUsage, refs);
      } catch (error: unknown) {
        lastError = error;
        if (activeModel !== modelsToTry[modelsToTry.length - 1]) {
          console.warn(`Image model failed for ${activeModel}; falling back to ${IMAGE_FALLBACK_MODEL}: ${getErrorMessage(error)}`);
          recordOperationLog({
            scope: "external",
            level: "warn",
            event: "openrouter.image_fallback",
            message: `Image generation failed on ${activeModel}; retrying with ${IMAGE_FALLBACK_MODEL}`,
            metadata: { failedModel: activeModel, fallbackModel: IMAGE_FALLBACK_MODEL },
            error,
          });
        }
      }
    }
    throw lastError;
  };

  try {
    return await attempt(opts.referenceImageUrls);
  } catch (error: unknown) {
    // Reference-art conditioning is the most likely thing to be rejected (a bad
    // ref URL, an unsupported model, a content filter). Never let it sink a
    // whole paid reel — retry once prompt-only before giving up.
    if (opts.referenceImageUrls?.length) {
      console.warn(`Reference-art image gen failed (${getErrorMessage(error)}); retrying prompt-only`);
      recordOperationLog({
        scope: "external",
        level: "warn",
        event: "openrouter.image_reference_retry",
        message: "Reference-art image generation failed; retrying without references",
        metadata: { referenceCount: opts.referenceImageUrls.length, model },
        error,
      });
      try {
        return await attempt(undefined);
      } catch (retryError: unknown) {
        throw new Error(`Image generation failed: ${getErrorMessage(retryError)}`);
      }
    }
    throw new Error(`Image generation failed: ${getErrorMessage(error)}`);
  }
}

async function generateImageWithModel(
  model: string,
  fullPrompt: string,
  logPrompt: string,
  targetDir: string,
  onUsage?: MediaUsageCallback,
  referenceImageUrls?: string[]
): Promise<string> {
    const capability = await getImageModelCapability(model);
    const bodies = imageRequestBodies(model, fullPrompt, capability, referenceImageUrls);
    if (referenceImageUrls?.length) {
      console.log(
        supportsReferenceImages(capability)
          ? `🎨 Using ${referenceImageUrls.length} reference-art image(s) for ${model}`
          : `⚠️  ${model} does not support reference images — generating from prompt only`
      );
    }
    let res: Response | undefined;
    let lastErrorText = "";
    for (let attempt = 0; attempt < bodies.length; attempt++) {
      res = await fetch(`${config.openRouterBaseUrl}/images`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.openRouterApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(bodies[attempt]),
      });
      if (res.ok) break;
      lastErrorText = await res.text();
      if (!isImageValidationError(res.status, lastErrorText) || attempt === bodies.length - 1) break;
      console.warn(
        `Image request rejected for ${model} (${String(bodies[attempt].resolution ?? "default")}); retrying alternate supported request`
      );
    }

    if (!res?.ok) {
      throw new Error(`Image API ${res?.status ?? "unknown"}: ${lastErrorText}`);
    }

    const data = (await res.json()) as {
      id?: string;
      usage?: { cost?: number | string };
      data?: { b64_json?: string; media_type?: string }[];
    };
    const responseCost = parseCost(data.usage?.cost);
    const generationCost = responseCost ?? (await fetchGenerationCost(data.id));
    onUsage?.({
      costUsd: generationCost,
      source:
        responseCost !== undefined
          ? "openrouter_usage"
          : generationCost !== undefined
          ? "openrouter_generation"
          : "estimated",
      generationId: data.id,
    });
    const item = data.data?.[0];
    if (!item?.b64_json) {
      throw new Error("No image returned from model");
    }
    if (item.media_type === "image/svg+xml") {
      throw new Error("Vector SVG image returned; choose a raster image model for video generation");
    }

    const buffer = Buffer.from(item.b64_json, "base64");

    const imagePath = join(targetDir, generateFilename("scene", "png"));
    await writeFile(imagePath, buffer);
    console.log(`🖼️  Generated image [${model}]: "${logPrompt.substring(0, 40)}..."`);
    return imagePath;
}

/**
 * Validate a SINGLE image model with a real minimal generation — no fallback,
 * so a broken model surfaces as a failure instead of being silently masked.
 * Used by scripts/validate-models.ts. Cleans up the probe image.
 */
export async function probeImageModel(
  model: string
): Promise<{ ok: boolean; costUsd?: number; error?: string }> {
  let cost: number | undefined;
  try {
    const path = await generateImageWithModel(
      model,
      "a simple red circle centered on a plain white background",
      "validation probe",
      config.processingPath,
      (u) => {
        cost = u.costUsd;
      }
    );
    await unlink(path).catch(() => {});
    return { ok: true, costUsd: cost };
  } catch (error: unknown) {
    return { ok: false, costUsd: cost, error: getErrorMessage(error) };
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
  opts: {
    model?: string;
    voice?: string;
    format?: "mp3" | "pcm";
    outputDir?: string;
    profile?: NarrationProfile;
    onUsage?: MediaUsageCallback;
  } = {}
): Promise<{ audioPath: string; duration: number }> {
  const targetDir = opts.outputDir || config.processingPath;
  await ensureDir(targetDir);

  const primary = resolveTtsChoice(resolveModels().tts, opts);
  const fallback = resolveTtsChoice(TTS_FALLBACK);
  const choices =
    primary.model === fallback.model && primary.voice === fallback.voice
      ? [primary]
      : [primary, fallback];

  let lastError: unknown;
  for (const choice of choices) {
    try {
      return await generateNarrationWithChoice(text, targetDir, choice, opts.profile, opts.onUsage);
    } catch (error: unknown) {
      lastError = error;
      if (choice !== choices[choices.length - 1]) {
        console.warn(
          `TTS failed for ${choice.model}/${choice.voice}; falling back to ${fallback.model}/${fallback.voice}: ${getErrorMessage(error)}`
        );
        recordOperationLog({
          scope: "external",
          level: "warn",
          event: "openrouter.tts_fallback",
          message: `TTS failed for ${choice.model}/${choice.voice}; retrying with ${fallback.model}/${fallback.voice}`,
          metadata: {
            failedModel: choice.model,
            failedVoice: choice.voice,
            fallbackModel: fallback.model,
            fallbackVoice: fallback.voice,
          },
          error,
        });
      }
    }
  }

  throw new Error(`Narration failed: ${getErrorMessage(lastError)}`);
}

async function generateNarrationWithChoice(
  text: string,
  targetDir: string,
  choice: TtsChoice,
  profile?: NarrationProfile,
  onUsage?: MediaUsageCallback
): Promise<{ audioPath: string; duration: number }> {
  const { model, voice, format } = choice; // some models (Gemini) only emit pcm
  let rawPath = "";
  try {
    let res: Response | undefined;
    for (let attempt = 1; attempt <= TTS_MAX_ATTEMPTS; attempt++) {
      res = await fetch(`${config.openRouterBaseUrl}/audio/speech`, {
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
          ...(isHorrorNarrationProfile(profile) ? { speed: profile === "whisper" || profile === "distant" ? 0.86 : 0.9 } : {}),
          // Reddit: a slightly-under-1.0 provider speed makes the read more
          // deliberate/clear (Issue 3). Sent only when it actually differs from
          // natural, and only for models that accept `speed`.
          ...(profile === "reddit" && Number.isFinite(config.redditTtsSpeed) && config.redditTtsSpeed !== 1
            ? { speed: Math.min(Math.max(config.redditTtsSpeed, 0.7), 1.2) }
            : {}),
          ...(profile === "horror" && model === "microsoft/mai-voice-2"
            ? {
                provider: {
                  options: {
                    azure: { style: "sad", styledegree: 1.7 },
                  },
                },
              }
            : {}),
        }),
      });

      if (res.ok || !isRetryableStatus(res.status) || attempt === TTS_MAX_ATTEMPTS) break;
      console.warn(`TTS ${res.status} for ${model}/${voice}; retrying (${attempt}/${TTS_MAX_ATTEMPTS})`);
      await sleep(750 * attempt);
    }

    if (!res) throw new Error("TTS request failed before receiving a response");
    if (!res.ok) {
      throw new Error(`TTS API ${res.status}: ${await res.text()}`);
    }
    const generationId = res.headers.get("x-openrouter-generation-id") ?? undefined;
    const generationCost = await fetchGenerationCost(generationId);
    const estimatedCost = generationCost === undefined ? await estimateTtsCost(model, text) : undefined;
    if (generationCost === undefined) {
      recordOperationLog({
        scope: "external",
        level: "warn",
        event: "openrouter.tts_cost_estimated",
        message: "OpenRouter generation receipt was delayed; stored an estimated TTS cost",
        metadata: { model, voice, generationId, characters: text.length, estimatedCost },
      });
    }
    onUsage?.({
      costUsd: generationCost ?? estimatedCost,
      source: generationCost !== undefined ? "openrouter_generation" : "estimated",
      generationId,
    });

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

    const trimmedPath = join(targetDir, generateFilename("narration_trimmed", "mp3"));
    await trimSilence(mp3Src, trimmedPath);
    const audioPath = join(targetDir, generateFilename("narration", "mp3"));
    if (isHorrorNarrationProfile(profile)) {
      await applyHorrorVoiceTreatment(trimmedPath, audioPath, profile);
      await unlink(trimmedPath).catch(() => {});
    } else if (profile === "reddit") {
      await applyRedditVoiceTreatment(trimmedPath, audioPath);
      await unlink(trimmedPath).catch(() => {});
    } else {
      await trimSilence(trimmedPath, audioPath);
      await unlink(trimmedPath).catch(() => {});
    }
    await unlink(rawPath).catch(() => {});
    if (mp3Src !== rawPath) await unlink(mp3Src).catch(() => {});

    const duration = await getAudioDuration(audioPath);
    console.log(
      `🎤 Narration [${model}/${voice}]: "${text.substring(0, 30)}..." (${duration.toFixed(2)}s)`
    );
    return { audioPath, duration };
  } catch (error: unknown) {
    if (rawPath) await unlink(rawPath).catch(() => {});
    throw error;
  }
}

/**
 * Validate a SINGLE TTS model/voice with a short real synthesis — no fallback.
 * Used by scripts/validate-models.ts. Cleans up the probe audio.
 */
export async function probeTtsVoice(
  model: string,
  voice: string,
  format: "mp3" | "pcm"
): Promise<{ ok: boolean; costUsd?: number; error?: string }> {
  let cost: number | undefined;
  try {
    const { audioPath } = await generateNarrationWithChoice(
      "Testing one two three.",
      config.processingPath,
      { model, voice, format },
      undefined,
      (u) => {
        cost = u.costUsd;
      }
    );
    await unlink(audioPath).catch(() => {});
    return { ok: true, costUsd: cost };
  } catch (error: unknown) {
    return { ok: false, costUsd: cost, error: getErrorMessage(error) };
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

/**
 * Horror narration should sound like a late-night recording, not a clean
 * audiobook read. This intentionally stays subtle: pitch down, darken the top
 * end, add a small room echo, and normalize so captions/render timing still
 * behave predictably.
 */
function isHorrorNarrationProfile(profile?: NarrationProfile): profile is Exclude<NarrationProfile, "reddit"> {
  return profile === "horror" || profile === "whisper" || profile === "phone" || profile === "tape" || profile === "distant";
}

function horrorVoiceFilters(profile: Exclude<NarrationProfile, "reddit">): string {
  const profiles: Record<Exclude<NarrationProfile, "reddit">, string[]> = {
    horror: [
      "aresample=48000",
      "asetrate=44160",
      "aresample=48000",
      "atempo=1.087",
      "highpass=f=65",
      "lowpass=f=3300",
      "tremolo=f=4.8:d=0.035",
      "aecho=0.72:0.45:55|115:0.12|0.07",
      "acompressor=threshold=-22dB:ratio=2.2:attack=8:release=140",
      "loudnorm=I=-18:LRA=8:TP=-1.5",
    ],
    whisper: [
      "aresample=48000",
      "asetrate=43680",
      "aresample=48000",
      "atempo=1.099",
      "highpass=f=120",
      "lowpass=f=2400",
      "equalizer=f=6200:t=q:w=1.4:g=3.8",
      "tremolo=f=6.2:d=0.05",
      "aecho=0.58:0.38:42|88:0.10|0.05",
      "acompressor=threshold=-25dB:ratio=2.8:attack=10:release=190",
      "loudnorm=I=-19:LRA=7:TP=-1.8",
    ],
    phone: [
      "aresample=48000",
      "highpass=f=320",
      "lowpass=f=2900",
      "equalizer=f=1200:t=q:w=1.0:g=3.5",
      "acrusher=bits=10:mix=0.22",
      "acompressor=threshold=-20dB:ratio=3.4:attack=4:release=90",
      "loudnorm=I=-17:LRA=6:TP=-1.5",
    ],
    tape: [
      "aresample=48000",
      "asetrate=44600",
      "aresample=48000",
      "atempo=1.076",
      "highpass=f=85",
      "lowpass=f=3600",
      "tremolo=f=5.5:d=0.025",
      "acrusher=bits=13:mix=0.12",
      "aecho=0.62:0.35:70|140:0.08|0.045",
      "acompressor=threshold=-23dB:ratio=2.4:attack=8:release=150",
      "loudnorm=I=-18:LRA=8:TP=-1.6",
    ],
    distant: [
      "aresample=48000",
      "asetrate=43200",
      "aresample=48000",
      "atempo=1.111",
      "highpass=f=55",
      "lowpass=f=2100",
      "aecho=0.82:0.62:120|240|390:0.18|0.10|0.055",
      "acompressor=threshold=-26dB:ratio=2.1:attack=16:release=240",
      "loudnorm=I=-20:LRA=9:TP=-1.8",
    ],
  };
  return profiles[profile].join(",");
}

function applyHorrorVoiceTreatment(
  input: string,
  output: string,
  profile: Exclude<NarrationProfile, "reddit">
): Promise<string> {
  const filters = horrorVoiceFilters(profile);

  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .audioFilters(filters)
      .outputOptions(["-c:a", "libmp3lame", "-q:a", "4"])
      .output(output)
      .on("end", () => resolve(output))
      .on("error", (err) => reject(new Error(`Horror voice treatment (${profile}) failed: ${err.message}`)))
      .run();
  });
}

/**
 * Reddit narration should sound like a modern "storytime" podcast read — clean,
 * punchy, intimate, and high-clarity so it cuts through on a phone speaker. This
 * chain is deliberately subtle and, crucially, duration-preserving (no
 * asetrate/atempo here) so caption timing stays predictable — tempo is applied
 * separately by the gameplay renderer on the final paced audio.
 *
 * Chain: rumble filter → low-mud cut + a touch of chest warmth → presence /
 * clarity EQ (intelligibility) → static de-ess (tame sibilance) → gentle
 * compression → mild tanh saturation for warmth → peak limiter → EBU R128
 * loudness normalization for consistent, phone-loud output.
 */
function applyRedditVoiceTreatment(input: string, output: string): Promise<string> {
  const filters = [
    "aresample=48000",
    "highpass=f=90", // kill sub-bass rumble
    "equalizer=f=200:t=q:w=1.2:g=-2", // clear low-mid mud
    "equalizer=f=120:t=q:w=1.0:g=1.2", // a touch of chest warmth
    "equalizer=f=3000:t=q:w=1.1:g=2.6", // presence / intelligibility
    "equalizer=f=5200:t=q:w=1.2:g=1.4", // clarity / air
    "equalizer=f=7200:t=q:w=2.4:g=-3", // static de-ess (sibilance control)
    "acompressor=threshold=-20dB:ratio=2.2:attack=6:release=90:makeup=2",
    "asoftclip=type=tanh", // gentle harmonic warmth/saturation
    "alimiter=limit=0.95", // catch peaks introduced by saturation
    "loudnorm=I=-14:LRA=7:TP=-1.0", // consistent loudness for phone speakers
  ].join(",");

  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .audioFilters(filters)
      .outputOptions(["-c:a", "libmp3lame", "-q:a", "4"])
      .output(output)
      .on("end", () => resolve(output))
      .on("error", (err) => reject(new Error(`Reddit voice treatment failed: ${err.message}`)))
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

// ============================================
// Hero video generation — OpenRouter's async /videos endpoint (submit → poll
// → download). This is the one genuinely expensive, genuinely slow (minutes,
// not seconds) call in the whole pipeline, which is why it's gated behind
// `heroPolicy` in the niche recipe and only ever used for ONE scene per reel.
// Confirmed request/response shape against OpenRouter's own docs 2026-07-03
// (POST /videos -> {id, status, polling_url}; GET polling_url -> {status,
// unsigned_urls} once status:"completed").
// ============================================

export interface HeroVideoOptions {
  model?: string;
  durationSec?: number; // clip length OpenRouter generates, default 5
  aspectRatio?: string; // default "9:16"
  outputDir?: string;
  pollIntervalMs?: number; // default 30s — these jobs take minutes, not seconds
  maxPollAttempts?: number; // default 60 (30 min ceiling)
  onUsage?: MediaUsageCallback;
  /** first-frame image (S3/CDN URL) → image-to-video via `frame_images`.
   *  This is how a generated still is animated into real motion; the reference
   *  art style baked into the still therefore carries into the moving clip. */
  frameImageUrl?: string;
}

export interface HeroVideoResult {
  videoPath: string;
  durationSec: number;
}

interface VideoJobResponse {
  id: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled" | "expired";
  polling_url?: string;
  unsigned_urls?: string[];
  error?: unknown;
  usage?: { cost?: number | string };
  total_cost?: number | string;
  cost?: number | string;
}

/**
 * Generate the single AI-video "hero shot" for a `hybrid_scene` reel.
 * Submits, polls until terminal, downloads the result. `generate_audio` is
 * always false — narration/sound design for the scene are handled separately
 * and mixed in during render, not baked in by the video model.
 */
/** Snap a requested clip length to a duration every current video model accepts.
 *  veo-3.1 only takes 4/6/8s (rejects 5/7); seedance accepts these too. The clip
 *  is looped/trimmed to the narration afterward, so exact length doesn't matter. */
function snapVideoDuration(sec: number): number {
  const allowed = [4, 6, 8];
  return allowed.reduce((best, v) => (Math.abs(v - sec) < Math.abs(best - sec) ? v : best), allowed[0]);
}

export async function generateHeroVideo(
  prompt: string,
  opts: HeroVideoOptions = {}
): Promise<HeroVideoResult> {
  const model = opts.model || resolveModels().video;
  const durationSec = snapVideoDuration(opts.durationSec ?? 5);
  const targetDir = opts.outputDir || config.processingPath;
  await ensureDir(targetDir);

  const fullPrompt = [prompt, NO_TEXT_SUFFIX].filter(Boolean).join(". ");

  const submitRes = await fetch(`${config.openRouterBaseUrl}/videos`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openRouterApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      prompt: fullPrompt,
      duration: durationSec,
      aspect_ratio: opts.aspectRatio ?? "9:16",
      generate_audio: false,
      // Present → image-to-video (animate the still), absent → text-to-video.
      // Each frame is { type, frame_type, image_url:{url} } (chat-style part +
      // required frame_type); a bare URL or flat image_url string is rejected.
      ...(opts.frameImageUrl
        ? {
            frame_images: [
              { type: "image_url", frame_type: "first_frame", image_url: { url: opts.frameImageUrl } },
            ],
          }
        : {}),
    }),
  });
  if (!submitRes.ok) {
    throw new Error(`Video submit failed (${submitRes.status}): ${await submitRes.text()}`);
  }
  const job = (await submitRes.json()) as VideoJobResponse;
  const pollUrl = job.polling_url || `${config.openRouterBaseUrl}/videos/${job.id}`;

  const pollIntervalMs = opts.pollIntervalMs ?? 30_000;
  const maxAttempts = opts.maxPollAttempts ?? 60;

  let final: VideoJobResponse | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(pollIntervalMs);
    const pollRes = await fetch(pollUrl, {
      headers: { Authorization: `Bearer ${config.openRouterApiKey}` },
    });
    if (!pollRes.ok) {
      throw new Error(`Video poll failed (${pollRes.status}): ${await pollRes.text()}`);
    }
    final = (await pollRes.json()) as VideoJobResponse;
    if (final.status === "completed") break;
    if (final.status === "failed" || final.status === "cancelled" || final.status === "expired") {
      throw new Error(`Hero video generation ${final.status}: ${JSON.stringify(final.error ?? "")}`);
    }
  }
  if (final?.status !== "completed") {
    throw new Error(`Hero video generation timed out after ${maxAttempts} polls`);
  }
  const finalCost = parseCost(final.total_cost) ?? parseCost(final.cost) ?? parseCost(final.usage?.cost);
  opts.onUsage?.({
    costUsd: finalCost,
    source: finalCost !== undefined ? "openrouter_usage" : "estimated",
    generationId: final.id ?? job.id,
  });

  const videoUrl = final.unsigned_urls?.[0];
  if (!videoUrl) throw new Error("Hero video completed but no download URL returned");

  const dlRes = await fetch(videoUrl, {
    headers: videoUrl.includes("openrouter.ai")
      ? { Authorization: `Bearer ${config.openRouterApiKey}` }
      : {},
  });
  if (!dlRes.ok) throw new Error(`Hero video download failed (${dlRes.status})`);
  const buffer = Buffer.from(await dlRes.arrayBuffer());

  const videoPath = join(targetDir, generateFilename("hero", "mp4"));
  await writeFile(videoPath, buffer);
  console.log(
    `🎬 ${opts.frameImageUrl ? "Motion clip (img2vid)" : "Hero video"} [${model}]: "${prompt.substring(0, 40)}..." (${durationSec}s)`
  );
  return { videoPath, durationSec };
}

/**
 * Animate a still into a real moving clip (image-to-video). Same OpenRouter
 * `/videos` job as `generateHeroVideo`, but always seeded with a first-frame
 * image. Used by the motion engine to bring reference-art stills to life.
 */
export const generateMotionClip = generateHeroVideo;
