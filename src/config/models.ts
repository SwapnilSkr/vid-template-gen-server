// ============================================
// OpenRouter model registry — the ONE place to swap models.
//
// Every service resolves models through `resolveModels(tier)` instead of
// hardcoding slugs, so changing a model = edit this file (or set an env var).
// Nothing in the render/pipeline architecture depends on a specific model.
//
// Override precedence:  per-field env var  >  tier default (here)
//   MODEL_TIER=cheap|value|premium   picks the column
//   LLM_MODEL / IMAGE_MODEL / TTS_MODEL / TTS_VOICE / TTS_FORMAT / VIDEO_MODEL
//     override individual fields regardless of tier
// ============================================

export type Tier = "cheap" | "value" | "premium";

export interface TtsChoice {
  model: string;
  voice: string;
  format: "mp3" | "pcm"; // Gemini TTS only emits pcm; others emit mp3
}

export interface ModelSet {
  llm: string; // script / scene-graph planning
  image: string; // still generation
  tts: TtsChoice; // narration
  video: string; // hero shots (Wave 3+)
}

// Researched budget-first defaults (2026-07). Prices indicative, see
// docs/architecture/model-selection.md.
export const REGISTRY: Record<Tier, ModelSet> = {
  cheap: {
    llm: "deepseek/deepseek-v4-flash", // ~$0.10/$0.20 per Mtok
    image: "google/gemini-2.5-flash-image", // ~$0.04/img, proven in lab
    tts: { model: "google/gemini-3.1-flash-tts-preview", voice: "Charon", format: "pcm" }, // natural; cost delta is negligible
    video: "bytedance/seedance-2.0-fast", // ~$0.022/s
  },
  value: {
    llm: "google/gemini-2.5-flash",
    image: "google/gemini-3.1-flash-image", // newer Nano-Banana generation
    tts: { model: "google/gemini-3.1-flash-tts-preview", voice: "Charon", format: "pcm" }, // natural, still cheap
    video: "google/veo-3.1-fast", // ~$0.09/s, native audio
  },
  premium: {
    llm: "google/gemini-2.5-flash",
    image: "google/gemini-3-pro-image", // ~$0.13/img, 4K
    tts: { model: "microsoft/mai-voice-2", voice: "en-US-Harper:MAI-Voice-2", format: "mp3" },
    video: "google/veo-3.1", // ~$0.18/s
  },
};

export interface TtsVoiceOption {
  model: string;
  voice: string;
  format: "mp3" | "pcm";
  label: string;
}

/**
 * Cross-model voice catalog for the revoice/compare UI. OpenRouter's TTS
 * catalog (2026-07 audit, see openrouter.ai/collections/text-to-speech-models)
 * lists 9 models total. We ship 5 of them below — every entry here has been
 * LIVE-TESTED against OpenRouter's /audio/speech endpoint, not just sourced
 * from docs. Two listed-but-untested models were tried and dropped because
 * they 400'd with "model does not exist" under every slug variant we tried
 * (mistralai/voxtral-mini-tts[-2603], openai/gpt-4o-mini-tts[-2025-12-15]) —
 * likely gated/region-locked despite being publicly listed. Re-test before
 * re-adding. Also skipped: two Zyphra Zonos v0.1 variants + Sesame CSM-1B,
 * whose voice-naming isn't documented with enough confidence to guess IDs.
 *  - Gemini TTS: 30 official voices (Google Gemini API docs) — 10 picked here.
 *  - Kokoro-82M: 54 voices/8 languages (hexgrad/Kokoro-82M VOICES.md) — 10 English (US+UK) picked here.
 *  - MAI-Voice-2: 10+ locales (Microsoft Azure MAI-Voice docs) — all 7 English (US+AU) voices included.
 *  - Orpheus-3B: 8 voices total (canopyai/Orpheus-TTS) — all included; supports <laugh>/<sigh>/<gasp> emotive tags in text.
 *  - Grok Voice TTS 1.0: 5 voices total (xAI) — all included.
 * Extend this list as more voices get validated in the render lab — don't
 * assume it's the full provider catalog.
 */
export const TTS_VOICE_CATALOG: TtsVoiceOption[] = [
  // --- Google Gemini 3.1 Flash TTS (pcm) ---
  { model: "google/gemini-3.1-flash-tts-preview", voice: "Charon", format: "pcm", label: "Charon — informative (default)" },
  { model: "google/gemini-3.1-flash-tts-preview", voice: "Puck", format: "pcm", label: "Puck — upbeat" },
  { model: "google/gemini-3.1-flash-tts-preview", voice: "Zephyr", format: "pcm", label: "Zephyr — bright" },
  { model: "google/gemini-3.1-flash-tts-preview", voice: "Kore", format: "pcm", label: "Kore — firm" },
  { model: "google/gemini-3.1-flash-tts-preview", voice: "Fenrir", format: "pcm", label: "Fenrir — excitable" },
  { model: "google/gemini-3.1-flash-tts-preview", voice: "Leda", format: "pcm", label: "Leda — youthful" },
  { model: "google/gemini-3.1-flash-tts-preview", voice: "Orus", format: "pcm", label: "Orus — firm, deep" },
  { model: "google/gemini-3.1-flash-tts-preview", voice: "Aoede", format: "pcm", label: "Aoede — breezy" },
  { model: "google/gemini-3.1-flash-tts-preview", voice: "Autonoe", format: "pcm", label: "Autonoe — bright" },
  { model: "google/gemini-3.1-flash-tts-preview", voice: "Sulafat", format: "pcm", label: "Sulafat — warm" },

  // --- Kokoro-82M (mp3) — American (am_/af_) + British (bm_/bf_) English ---
  { model: "hexgrad/kokoro-82m", voice: "am_onyx", format: "mp3", label: "Onyx (Kokoro, US male) — deep, moody" },
  { model: "hexgrad/kokoro-82m", voice: "am_adam", format: "mp3", label: "Adam (Kokoro, US male) — neutral" },
  { model: "hexgrad/kokoro-82m", voice: "am_michael", format: "mp3", label: "Michael (Kokoro, US male) — warm" },
  { model: "hexgrad/kokoro-82m", voice: "am_fenrir", format: "mp3", label: "Fenrir (Kokoro, US male) — intense" },
  { model: "hexgrad/kokoro-82m", voice: "am_puck", format: "mp3", label: "Puck (Kokoro, US male) — playful" },
  { model: "hexgrad/kokoro-82m", voice: "af_bella", format: "mp3", label: "Bella (Kokoro, US female) — warm" },
  { model: "hexgrad/kokoro-82m", voice: "af_nicole", format: "mp3", label: "Nicole (Kokoro, US female) — soft" },
  { model: "hexgrad/kokoro-82m", voice: "af_sky", format: "mp3", label: "Sky (Kokoro, US female) — bright" },
  { model: "hexgrad/kokoro-82m", voice: "bm_george", format: "mp3", label: "George (Kokoro, UK male) — formal" },
  { model: "hexgrad/kokoro-82m", voice: "bf_emma", format: "mp3", label: "Emma (Kokoro, UK female) — clear" },

  // --- Microsoft MAI-Voice-2 (mp3) — all English locales ---
  { model: "microsoft/mai-voice-2", voice: "en-US-Harper:MAI-Voice-2", format: "mp3", label: "Harper (MAI Voice 2, US female) — expressive, default" },
  { model: "microsoft/mai-voice-2", voice: "en-US-Olivia:MAI-Voice-2", format: "mp3", label: "Olivia (MAI Voice 2, US female) — expressive" },
  { model: "microsoft/mai-voice-2", voice: "en-US-Iris:MAI-Voice-2", format: "mp3", label: "Iris (MAI Voice 2, US female)" },
  { model: "microsoft/mai-voice-2", voice: "en-US-Ethan:MAI-Voice-2", format: "mp3", label: "Ethan (MAI Voice 2, US male) — expressive" },
  { model: "microsoft/mai-voice-2", voice: "en-US-Grant:MAI-Voice-2", format: "mp3", label: "Grant (MAI Voice 2, US male)" },
  { model: "microsoft/mai-voice-2", voice: "en-US-Jasper:MAI-Voice-2", format: "mp3", label: "Jasper (MAI Voice 2, US male)" },
  { model: "microsoft/mai-voice-2", voice: "en-AU-Lisa:MAI-Voice-2", format: "mp3", label: "Lisa (MAI Voice 2, AU female) — expressive" },

  // --- Canopy Labs Orpheus-3B (mp3) — all 8 voices, supports <laugh>/<sigh>/<gasp> tags in narration text ---
  { model: "canopylabs/orpheus-3b-0.1-ft", voice: "tara", format: "mp3", label: "Tara (Orpheus) — female, conversational" },
  { model: "canopylabs/orpheus-3b-0.1-ft", voice: "leah", format: "mp3", label: "Leah (Orpheus) — female, warm" },
  { model: "canopylabs/orpheus-3b-0.1-ft", voice: "jess", format: "mp3", label: "Jess (Orpheus) — female, energetic" },
  { model: "canopylabs/orpheus-3b-0.1-ft", voice: "mia", format: "mp3", label: "Mia (Orpheus) — female, professional" },
  { model: "canopylabs/orpheus-3b-0.1-ft", voice: "zoe", format: "mp3", label: "Zoe (Orpheus) — female, calm" },
  { model: "canopylabs/orpheus-3b-0.1-ft", voice: "leo", format: "mp3", label: "Leo (Orpheus) — male, authoritative" },
  { model: "canopylabs/orpheus-3b-0.1-ft", voice: "dan", format: "mp3", label: "Dan (Orpheus) — male, casual" },
  { model: "canopylabs/orpheus-3b-0.1-ft", voice: "zac", format: "mp3", label: "Zac (Orpheus) — male, dynamic" },

  // --- xAI Grok Voice TTS 1.0 (mp3) — all 5 voices ---
  { model: "x-ai/grok-voice-tts-1.0", voice: "Eve", format: "mp3", label: "Eve (Grok Voice)" },
  { model: "x-ai/grok-voice-tts-1.0", voice: "Ara", format: "mp3", label: "Ara (Grok Voice)" },
  { model: "x-ai/grok-voice-tts-1.0", voice: "Rex", format: "mp3", label: "Rex (Grok Voice)" },
  { model: "x-ai/grok-voice-tts-1.0", voice: "Sal", format: "mp3", label: "Sal (Grok Voice)" },
  { model: "x-ai/grok-voice-tts-1.0", voice: "Leo", format: "mp3", label: "Leo (Grok Voice)" },
];

const ENV_TIER = (process.env.MODEL_TIER as Tier) || "cheap";

/** Resolve the model set for a tier, applying per-field env overrides. */
export function resolveModels(tier: Tier = ENV_TIER): ModelSet {
  const base = REGISTRY[tier] ?? REGISTRY.cheap;
  return {
    llm: process.env.LLM_MODEL || base.llm,
    image: process.env.IMAGE_MODEL || base.image,
    tts: {
      model: process.env.TTS_MODEL || base.tts.model,
      voice: process.env.TTS_VOICE || base.tts.voice,
      format: (process.env.TTS_FORMAT as "mp3" | "pcm") || base.tts.format,
    },
    video: process.env.VIDEO_MODEL || base.video,
  };
}
