import { config } from "../config";
import { getRecipe } from "../config/niche-styles";
import { getJson } from "./s3.service";
import { resolveModels, resolveTtsChoice, TTS_VOICE_CATALOG, type Tier, type TtsVoiceOption } from "../config/models";

export interface PricedTtsVoiceOption extends TtsVoiceOption {
  provider: string;
  priceLabel: string;
  unitPriceLabel: string;
  priceNote: string;
  recommendedFor?: string[];
}

export interface ImageModelOption {
  model: string;
  label: string;
  priceLabel: string;
  priceNote: string;
  recommendedTier: "cheap" | "value" | "premium";
  /** advertises OpenRouter `input_references` → can follow reference-art styles */
  supportsReferenceArt: boolean;
  /** last validation result (scripts/validate-models.ts) — undefined = untested */
  healthy?: boolean;
}

// Health report written by scripts/validate-models.ts to S3. When present, the
// image-model list is filtered to models that PASSED a real generation, so the
// picker can never offer a model that would fail mid-reel.
interface ModelHealth {
  images?: Record<string, { ok: boolean; error?: string; costUsd?: number }>;
  generatedAt?: string;
}

let modelHealthCache: { at: number; data: ModelHealth } | undefined;

async function fetchModelHealth(): Promise<ModelHealth> {
  if (modelHealthCache && Date.now() - modelHealthCache.at < 60_000) return modelHealthCache.data;
  // Read straight from S3 (not the CDN) — CloudFront caches this file and
  // ignores query cache-busters, so it would serve a stale report.
  const data = (await getJson<ModelHealth>("model-health.json")) ?? {};
  modelHealthCache = { at: Date.now(), data };
  return data;
}

export interface ReelDefaultOption {
  niche: string;
  tier: Tier;
  tts: PricedTtsVoiceOption;
  scriptModel: string;
}

interface OpenRouterModel {
  id: string;
  name?: string;
  description?: string;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  supported_parameters?: Record<string, { type: string; values?: string[] }>;
  endpoints?: string;
}

interface OpenRouterImageEndpoint {
  provider_name?: string;
  pricing?: { billable: string; unit: string; cost_usd: number; variant?: string }[];
}

const VOICE_PROVIDER_LABELS: Record<string, string> = {
  "google/gemini-3.1-flash-tts-preview": "Gemini Flash TTS",
  "hexgrad/kokoro-82m": "Kokoro",
  "microsoft/mai-voice-2": "MAI Voice 2",
  "canopylabs/orpheus-3b-0.1-ft": "Orpheus-3B",
  "x-ai/grok-voice-tts-1.0": "Grok Voice",
};

const VOICE_PRICE_LABELS: Record<string, { priceLabel: string; priceNote: string; recommendedFor?: string[] }> = {
  "google/gemini-3.1-flash-tts-preview": {
    priceLabel: "usage-priced",
    priceNote: "OpenRouter TTS bills per character; exact per-request cost is captured when the endpoint exposes generation usage.",
  },
  "hexgrad/kokoro-82m": {
    priceLabel: "low",
    priceNote: "Cheap fallback, but less natural for retention.",
  },
  "microsoft/mai-voice-2": {
    priceLabel: "premium",
    priceNote: "Expressive voice option; exact cost is captured when OpenRouter exposes generation usage.",
  },
  "canopylabs/orpheus-3b-0.1-ft": {
    priceLabel: "low/medium",
    priceNote: "Good fit for natural drama; exact cost is captured when OpenRouter exposes generation usage.",
    recommendedFor: ["drama"],
  },
  "x-ai/grok-voice-tts-1.0": {
    priceLabel: "usage-priced",
    priceNote: "Supports richer voice control than the basic catalog voices; horror output also gets backend voice treatment.",
    recommendedFor: ["horror", "reddit"],
  },
};

async function fetchOpenRouterModels(): Promise<OpenRouterModel[]> {
  const res = await fetch(`${config.openRouterBaseUrl}/images/models`, {
    headers: { Authorization: `Bearer ${config.openRouterApiKey}` },
  });
  if (!res.ok) throw new Error(`OpenRouter models API ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data?: OpenRouterModel[] };
  return json.data ?? [];
}

async function fetchImageEndpoints(modelId: string): Promise<OpenRouterImageEndpoint[]> {
  const res = await fetch(`${config.openRouterBaseUrl}/images/models/${modelId}/endpoints`, {
    headers: { Authorization: `Bearer ${config.openRouterApiKey}` },
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { endpoints?: OpenRouterImageEndpoint[] };
  return json.endpoints ?? [];
}

function imagePriceLabel(endpoint?: OpenRouterImageEndpoint): string {
  const output = endpoint?.pricing?.filter((item) => item.billable === "output_image") ?? [];
  const image = output.find((item) => item.unit === "image" && !item.variant) ?? output.find((item) => item.unit === "image");
  if (image) return `$${image.cost_usd.toFixed(3)}/${image.variant ? `${image.variant} ` : ""}image`;
  const mp = output.find((item) => item.unit === "megapixel");
  if (mp) return `$${mp.cost_usd.toFixed(3)}/MP`;
  const token = output.find((item) => item.unit === "token");
  if (token) return `$${(token.cost_usd * 1_000_000).toFixed(2)}/M output tokens`;
  return "live usage-priced";
}

function isConcreteImageModel(model: OpenRouterModel): boolean {
  const input = model.architecture?.input_modalities ?? [];
  const output = model.architecture?.output_modalities ?? [];
  return (
    model.id !== "openrouter/auto" &&
    !model.id.includes("vector") &&
    input.includes("text") &&
    output.includes("image")
  );
}

function cheapestOutputCost(endpoint?: OpenRouterImageEndpoint): number {
  const costs = endpoint?.pricing?.filter((item) => item.billable === "output_image").map((item) => item.cost_usd) ?? [];
  return Math.min(...costs, Number.POSITIVE_INFINITY);
}

function imageTier(model: OpenRouterModel, endpoint?: OpenRouterImageEndpoint): ImageModelOption["recommendedTier"] {
  const cost = cheapestOutputCost(endpoint);
  if (model.id.includes("lite") || model.id.includes("mini") || cost <= 0.02) return "cheap";
  if (model.id.includes("pro") || model.id.includes("max") || cost >= 0.04) return "premium";
  return "value";
}

export function listPricedTtsVoices(): PricedTtsVoiceOption[] {
  const priority: Record<string, number> = {
    "x-ai/grok-voice-tts-1.0": 0,
    "canopylabs/orpheus-3b-0.1-ft": 1,
    "google/gemini-3.1-flash-tts-preview": 2,
    "microsoft/mai-voice-2": 3,
    "hexgrad/kokoro-82m": 4,
  };

  return [...TTS_VOICE_CATALOG]
    .sort((a, b) => (priority[a.model] ?? 99) - (priority[b.model] ?? 99))
    .map((voice) => {
      const pricing = VOICE_PRICE_LABELS[voice.model] ?? {
        priceLabel: "usage-priced",
        priceNote: "Exact cost is captured when OpenRouter exposes generation usage.",
      };
      return {
        ...voice,
        provider: VOICE_PROVIDER_LABELS[voice.model] ?? voice.model,
        unitPriceLabel: "shown after generation when exact usage is exposed",
        ...pricing,
      };
    });
}

export function getReelDefaults(niche: string, tier: Tier = "cheap"): ReelDefaultOption {
  const recipe = getRecipe(niche);
  const scriptModel = process.env.LLM_MODEL || recipe.scriptModel || resolveModels(tier).llm;
  const resolved = resolveTtsChoice(resolveModels(tier).tts, recipe.voice ?? {});
  const voice =
    listPricedTtsVoices().find((option) => option.model === resolved.model && option.voice === resolved.voice) ?? {
      ...resolved,
      label: `${resolved.voice} (${resolved.model})`,
      provider: resolved.model,
      priceLabel: "usage-priced",
      unitPriceLabel: "shown after generation when exact usage is exposed",
      priceNote: "Exact cost is captured when OpenRouter exposes generation usage.",
    };
  return { niche, tier, tts: voice, scriptModel };
}

export async function listImageModels(): Promise<ImageModelOption[]> {
  const [models, health] = await Promise.all([
    fetchOpenRouterModels().catch(() => []),
    fetchModelHealth(),
  ]);
  const concrete = models.filter(isConcreteImageModel);
  const endpointEntries = await Promise.all(
    concrete.map(async (model) => [model.id, (await fetchImageEndpoints(model.id))[0]] as const)
  );
  const endpoints = new Map(endpointEntries);
  return concrete
    .filter((model) => {
      const endpoint = endpoints.get(model.id);
      return Boolean(endpoint?.pricing?.some((item) => item.billable === "output_image"));
    })
    .sort((a, b) => cheapestOutputCost(endpoints.get(a.id)) - cheapestOutputCost(endpoints.get(b.id)))
    .map((model): ImageModelOption => {
      const endpoint = endpoints.get(model.id);
      const supportsReferenceArt = Boolean(model.supported_parameters?.input_references);
      const healthEntry = health.images?.[model.id];
      return {
        model: model.id,
        label: model.name ?? model.id,
        priceLabel: imagePriceLabel(endpoint),
        priceNote:
          `${endpoint?.provider_name ? `${endpoint.provider_name}. ` : ""}Raster image model from OpenRouter's dedicated Images API.` +
          `${supportsReferenceArt ? " Supports reference-art styles." : " No reference-art support (prompt-only)."}` +
          " Exact request cost is captured from usage after generation.",
        recommendedTier: imageTier(model, endpoint),
        supportsReferenceArt,
        healthy: healthEntry ? healthEntry.ok : undefined,
      };
    })
    // When a health report exists, only surface models that PASSED validation
    // (drop the ones that failed) so the picker can't offer a broken model.
    .filter((option) => (health.images ? health.images[option.model]?.ok !== false : true));
}
