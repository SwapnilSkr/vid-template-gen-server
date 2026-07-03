import {
  TTS_VOICE_CATALOG,
  resolveTtsChoice,
  type TtsChoice,
  type TtsVoiceOption,
} from "../config/models";
import type { IVoiceOverride } from "../models";

type NarratorGender = "female" | "male" | "unknown";

interface VoiceProfile {
  gender: NarratorGender;
  weight: number;
}

const VOICE_PROFILES: Record<string, VoiceProfile> = {
  Charon: { gender: "male", weight: 5 },
  Puck: { gender: "male", weight: 3 },
  Zephyr: { gender: "male", weight: 2 },
  Kore: { gender: "female", weight: 4 },
  Fenrir: { gender: "male", weight: 3 },
  Leda: { gender: "female", weight: 5 },
  Orus: { gender: "male", weight: 4 },
  Aoede: { gender: "female", weight: 4 },
  Autonoe: { gender: "female", weight: 3 },
  Sulafat: { gender: "female", weight: 5 },

  am_onyx: { gender: "male", weight: 5 },
  am_adam: { gender: "male", weight: 4 },
  am_michael: { gender: "male", weight: 5 },
  am_fenrir: { gender: "male", weight: 3 },
  am_puck: { gender: "male", weight: 3 },
  af_bella: { gender: "female", weight: 5 },
  af_nicole: { gender: "female", weight: 5 },
  af_sky: { gender: "female", weight: 3 },
  bm_george: { gender: "male", weight: 4 },
  bf_emma: { gender: "female", weight: 4 },

  "en-US-Harper:MAI-Voice-2": { gender: "female", weight: 5 },
  "en-US-Olivia:MAI-Voice-2": { gender: "female", weight: 5 },
  "en-US-Iris:MAI-Voice-2": { gender: "female", weight: 4 },
  "en-US-Ethan:MAI-Voice-2": { gender: "male", weight: 5 },
  "en-US-Grant:MAI-Voice-2": { gender: "male", weight: 4 },
  "en-US-Jasper:MAI-Voice-2": { gender: "male", weight: 4 },
  "en-AU-Lisa:MAI-Voice-2": { gender: "female", weight: 4 },

  tara: { gender: "female", weight: 4 },
  leah: { gender: "female", weight: 5 },
  jess: { gender: "female", weight: 3 },
  mia: { gender: "female", weight: 4 },
  zoe: { gender: "female", weight: 5 },
  leo: { gender: "male", weight: 4 },
  dan: { gender: "male", weight: 5 },
  zac: { gender: "male", weight: 3 },

  Rex: { gender: "male", weight: 5 },
  Sal: { gender: "male", weight: 4 },
  Leo: { gender: "male", weight: 4 },
  Eve: { gender: "female", weight: 5 },
  Ara: { gender: "female", weight: 4 },
};

const RELATIONSHIP_HINTS: { pattern: RegExp; gender: Exclude<NarratorGender, "unknown">; weight: number }[] = [
  { pattern: /\bmy husband\b/i, gender: "female", weight: 3 },
  { pattern: /\bmy wife\b/i, gender: "male", weight: 3 },
  { pattern: /\bi(?:'|’)m (?:a )?(?:woman|girl|female|mom|mother|daughter|sister|bride|girlfriend)\b/i, gender: "female", weight: 4 },
  { pattern: /\bi(?:'|’)m (?:a )?(?:man|guy|male|dad|father|son|brother|groom|boyfriend)\b/i, gender: "male", weight: 4 },
  { pattern: /\b(?:as|being) (?:a )?(?:woman|girl|female|mom|mother|daughter|sister|bride)\b/i, gender: "female", weight: 3 },
  { pattern: /\b(?:as|being) (?:a )?(?:man|guy|male|dad|father|son|brother|groom)\b/i, gender: "male", weight: 3 },
];

function inferNarratorGender(title: string, body: string): NarratorGender {
  const text = `${title}\n${body}`;
  let female = 0;
  let male = 0;

  for (const match of text.matchAll(/\b(?:i(?:'|’)m|i am|me)\s*[([, ]?\s*(\d{1,2})\s*([mf])\b/gi)) {
    if (match[2]?.toLowerCase() === "f") female += 6;
    if (match[2]?.toLowerCase() === "m") male += 6;
  }
  for (const match of text.matchAll(/\b(?:i(?:'|’)m|i am|me)\s*[([, ]?\s*([mf])\s*(\d{1,2})\b/gi)) {
    if (match[1]?.toLowerCase() === "f") female += 4;
    if (match[1]?.toLowerCase() === "m") male += 4;
  }
  for (const hint of RELATIONSHIP_HINTS) {
    if (hint.pattern.test(text)) {
      if (hint.gender === "female") female += hint.weight;
      else male += hint.weight;
    }
  }

  if (female >= male + 2) return "female";
  if (male >= female + 2) return "male";
  return "unknown";
}

function voiceProfile(choice: Pick<TtsChoice, "voice">): VoiceProfile {
  return VOICE_PROFILES[choice.voice] ?? { gender: "unknown", weight: 0 };
}

function compatible(choice: TtsChoice, gender: NarratorGender): boolean {
  if (gender === "unknown") return true;
  const profile = voiceProfile(choice);
  return profile.gender === "unknown" || profile.gender === gender;
}

function bestMatchingVoice(current: TtsChoice, gender: Exclude<NarratorGender, "unknown">): TtsVoiceOption {
  const candidates = TTS_VOICE_CATALOG.filter((option) => voiceProfile(option).gender === gender);
  return candidates
    .map((option) => ({
      option,
      score:
        (option.model === current.model ? 100 : 0) +
        voiceProfile(option).weight +
        (option.model === "x-ai/grok-voice-tts-1.0" ? 4 : 0) +
        (option.model === "google/gemini-3.1-flash-tts-preview" ? 3 : 0) +
        (option.format === current.format ? 2 : 0),
    }))
    .sort((a, b) => b.score - a.score)[0].option;
}

export function resolveStoryMatchedTts(
  base: TtsChoice,
  nicheVoice: Partial<TtsChoice>,
  explicitVoice: IVoiceOverride | undefined,
  story: { title: string; body: string }
): TtsChoice {
  const current = resolveTtsChoice(base, nicheVoice, explicitVoice ?? {});
  const gender = inferNarratorGender(story.title, story.body);
  if (gender === "unknown" || compatible(current, gender)) return current;

  const matched = bestMatchingVoice(current, gender);
  return { model: matched.model, voice: matched.voice, format: matched.format };
}
