import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import { config } from "../config";
import { resolveModels, type Tier } from "../config/models";
import { getRecipe, type NicheRecipe } from "../config/niche-styles";
import { getErrorMessage } from "../types";
import type { IStoryBible } from "../models/reel.model";
import { getTrendInsight } from "./trend-insight.service";

const openrouter = createOpenRouter({ apiKey: config.openRouterApiKey });

/** Format the cached trend digest + reusable hook templates into one prompt
 * block (undefined/empty pieces are omitted, e.g. no genre or no data yet). */
async function buildTrendBlock(niche: string, genre?: string): Promise<string> {
  const insight = await getTrendInsight(niche, genre);
  if (!insight) return "";
  const hookBlock = insight.hooks.length
    ? `\nPROVEN HOOK-LINE TEMPLATES (adapt one to this topic, don't reuse verbatim):\n${insight.hooks.map((h) => `- ${h}`).join("\n")}\n`
    : "";
  return `\nCURRENT WINNING PATTERNS (from trending videos in this genre this week):\n${insight.digest}\n${hookBlock}`;
}

// Per-token prices (USD/token) for the planners we actually use, so the cost
// ledger reflects the REAL script model + every pass (the two-pass horror
// planner makes two calls). Keeps expensive models from hiding in a flat
// estimate. Update when a model's price changes; unknown models use DEFAULT.
const LLM_PRICE: Record<string, { in: number; out: number }> = {
  "deepseek/deepseek-v4-flash": { in: 0.1e-6, out: 0.2e-6 },
  "google/gemini-2.5-flash": { in: 0.3e-6, out: 2.5e-6 },
  "anthropic/claude-sonnet-5": { in: 3e-6, out: 15e-6 },
};
const LLM_PRICE_DEFAULT = { in: 0.5e-6, out: 1.5e-6 };

export interface LlmUsageLine {
  label: string;
  model: string;
  costUsd: number;
}

export type LlmUsageCallback = (usage: LlmUsageLine) => void;

function reportLlmUsage(
  onUsage: LlmUsageCallback | undefined,
  label: string,
  model: string,
  usage: { inputTokens?: number; outputTokens?: number } | undefined
): void {
  if (!onUsage) return;
  const price = LLM_PRICE[model] ?? LLM_PRICE_DEFAULT;
  const inTok = usage?.inputTokens ?? 0;
  const outTok = usage?.outputTokens ?? 0;
  onUsage({ label, model, costUsd: inTok * price.in + outTok * price.out });
}

export interface PlannedScene {
  narration: string;
  visualPrompt: string;
}

export interface PlannedReel {
  title: string;
  hook: string;
  scenes: PlannedScene[];
  /** deep story materials — present for horror (two-pass planner) */
  storyBible?: IStoryBible;
}

function planningModelFor(recipe: NicheRecipe, tier: Tier): string {
  return process.env.LLM_MODEL || recipe.scriptModel || resolveModels(tier).llm;
}

function isHorrorRecipe(recipe: NicheRecipe): boolean {
  return recipe.niche.startsWith("horror");
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function tightenHorrorPlan(plan: PlannedReel): PlannedReel {
  return {
    ...plan,
    scenes: plan.scenes.map((scene) => ({
      ...scene,
      narration: scene.narration
        .replace(/\b(creepy|terrifying|scary|demon|monster|haunted|suddenly)\b/gi, "")
        .replace(/\s+/g, " ")
        .trim(),
    })),
  };
}

function horrorQualityWarnings(plan: PlannedReel): string[] {
  const warnings: string[] = [];
  const narration = plan.scenes.map((scene) => scene.narration).join(" ").toLowerCase();
  const banned = /\b(creepy|terrifying|scary|demon|monster|haunted|suddenly)\b/i;
  if (banned.test(narration)) {
    warnings.push("generic horror wording");
  }
  const hasPersonalWitness = /\b(i|me|my|we|us|our)\b/i.test(narration);
  if (!hasPersonalWitness) {
    warnings.push("not a personal witness account");
  }
  const tooShort = plan.scenes.reduce((sum, scene) => sum + countWords(scene.narration), 0) < 140;
  if (tooShort) {
    warnings.push("short for a complete one-minute story");
  }
  const tooLong = plan.scenes.some((scene) => countWords(scene.narration) > 38);
  if (tooLong) {
    warnings.push("long narration beats");
  }
  return warnings;
}

/**
 * Plan a reel: title, hook, and an ordered scene graph (narration + visual
 * prompt per scene). Niche behaviour (tone, scene count, structure) comes from
 * the niche recipe (config/niche-styles.ts). The chosen VISUAL STYLE suffix is
 * applied later by reel.service, so the planner only describes raw imagery.
 */
export async function planReel(
  niche: string,
  topic: string,
  tier: Tier = "value",
  genre?: string,
  onLlmUsage?: LlmUsageCallback
): Promise<PlannedReel> {
  const recipe = getRecipe(niche);
  // Horror runs a two-pass planner (story bible → scene script) for depth.
  if (isHorrorRecipe(recipe)) return planHorrorReel(niche, topic, tier, genre, onLlmUsage);
  const llm = planningModelFor(recipe, tier);
  const trendBlock = await buildTrendBlock(niche, genre);
  const horror = isHorrorRecipe(recipe);
  const horrorRules =
    horror
      ? `
HORROR QUALITY BAR:
- Write like a believable first-person witness account recorded after the fact, not a campfire story.
- Target a finished 55-75 second story. Every scene narration must be 16-32 words, with one clear new plot beat.
- Use this arc across the scenes: ordinary setup, first wrong detail, attempted explanation, investigation, escalation, personal implication, failed escape, reveal, consequence.
- Use concrete sensory details: sounds, distances, timestamps, object positions, temperature, pressure, reflections.
- The fear must come from implication and pattern-breaking, not gore, monsters, jump-scare wording, or lore.
- The last scene must quietly prove the danger was already in the room, or that escape made it worse.
- Make the narrator sound scared to speak too loudly. Use one deliberate pause in the whole script, not constant ellipses.
- Avoid these words unless unavoidable: creepy, terrifying, scary, demon, monster, haunted, suddenly.
- If the script could fit any random horror video, rewrite it to be more specific to this topic.

BAD HORROR LINE:
"I found a creepy recorder and suddenly heard a terrifying voice."

GOOD HORROR LINE:
"The recorder was under my pillow again. This time, the metal was warm."
`
      : "";

  const prompt = `You are a ${horror ? "literary short-form horror writer and audio-first scene planner" : "viral short-form video scriptwriter"}. Produce a vertical faceless reel.

NICHE: ${recipe.displayName}
TOPIC: ${topic}
DIRECTION: ${recipe.scriptGuide}${trendBlock}
${horrorRules}

RULES:
- Exactly ${recipe.sceneCount} scenes. Each scene = ONE narration beat of 1-2 sentences ${horror ? "(16-32 words)" : "(max ~30 words)"} AND one vivid image description.
- Scene 1's narration is the HOOK — grab attention in the first 3 seconds, sound-off-friendly.
- Narration must read naturally aloud (spell out numbers as words, e.g. "fifteen eighteen" not "1518").
- visualPrompt: describe ONLY the scene's imagery (subject, setting, mood, lighting). Do NOT include style words, camera jargon, or any text/words-in-image.
- Continuous story: each scene flows into the next. No repetition.
- Each narration beat must add new information; do not restate the premise.

OUTPUT JSON ONLY (no markdown):
{
  "title": "catchy title",
  "hook": "the on-screen hook text (<= 8 words)",
  "scenes": [
    { "narration": "spoken line", "visualPrompt": "image description" }
  ]
}`;

  try {
    const { text, usage } = await generateText({
      model: openrouter(llm),
      prompt,
      temperature: horror ? 0.85 : undefined,
    });
    reportLlmUsage(onLlmUsage, "Script planning", llm, usage);

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in model response");
    const parsed = JSON.parse(jsonMatch[0]) as PlannedReel;

    if (!parsed.scenes?.length) throw new Error("No scenes returned");
    const planned = horror ? tightenHorrorPlan(parsed) : parsed;
    if (horror) {
      const warnings = horrorQualityWarnings(planned);
      if (warnings.length) console.warn(`⚠️ Horror script quality warning: ${warnings.join(", ")}`);
    }

    console.log(`📝 Planned "${planned.title}" — ${planned.scenes.length} scenes (${recipe.niche}) via ${llm}`);
    return planned;
  } catch (error: unknown) {
    throw new Error(`Reel planning failed: ${getErrorMessage(error)}`);
  }
}

function extractJson<T>(text: string): T {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in model response");
  return JSON.parse(match[0]) as T;
}

/**
 * Two-pass in-depth horror planner. Pass 1 develops a STORY BIBLE (premise,
 * the ordinary anchor object, the single impossible rule, an escalation ladder,
 * sound cues, art-direction motifs, and the recontextualizing final line).
 * Pass 2 dramatizes that bible into the exact scene graph — so every reel has a
 * real, coherent arc with a recurring object and a payoff, instead of a thin
 * one-shot script. The recurring motifs also keep the reference-art style
 * consistent across scenes.
 */
export async function planHorrorReel(
  niche: string,
  topic: string,
  tier: Tier = "value",
  genre?: string,
  onLlmUsage?: LlmUsageCallback
): Promise<PlannedReel> {
  const recipe = getRecipe(niche);
  const llm = planningModelFor(recipe, tier);
  const trendBlock = await buildTrendBlock(niche, genre);
  const seed = topic?.trim() && topic.trim().toLowerCase() !== "auto" ? topic.trim() : "";

  // ---- Pass 1: Story Bible ----
  const biblePrompt = `You are a literary horror author developing a short, believable first-person horror story for a 60-second vertical video. Genre flavor: ${genre ?? "unsettling everyday horror"}.
${seed ? `SEED IDEA: ${seed}` : "Invent an original, specific premise."}${trendBlock}

Develop the story's foundations. The horror must come from an ordinary object or place quietly breaking one impossible rule, escalating until the narrator is personally trapped — no monsters, no gore, no clichés.

OUTPUT JSON ONLY (no markdown):
{
  "premise": "one-sentence logline",
  "setting": "specific place + time",
  "protagonist": "who is telling this, one line",
  "anchorObject": "the single ordinary object/place that becomes impossible",
  "impossibleRule": "the one supernatural law this story obeys",
  "escalation": ["beat 1 (ordinary)", "beat 2 (first wrong detail)", "... 6-9 escalating beats ending in personal danger + a final consequence"],
  "soundCues": ["one concrete diegetic sound per major beat"],
  "artDirection": "recurring visual motifs, palette, lighting, and how the anchor object should always look — so every shot feels like one story",
  "finalTwist": "the last spoken line that recontextualizes everything"
}`;

  let bible: IStoryBible;
  try {
    const { text, usage } = await generateText({ model: openrouter(llm), prompt: biblePrompt, temperature: 0.9 });
    reportLlmUsage(onLlmUsage, "Story bible", llm, usage);
    bible = extractJson<IStoryBible>(text);
    if (!bible.anchorObject || !bible.impossibleRule || !bible.escalation?.length) {
      throw new Error("Incomplete story bible");
    }
  } catch (error: unknown) {
    throw new Error(`Horror story-bible pass failed: ${getErrorMessage(error)}`);
  }
  console.log(`📖 Story bible: "${bible.premise}" — anchor: ${bible.anchorObject}`);

  // ---- Pass 2: Scene script from the bible ----
  const scriptPrompt = `You are dramatizing a developed horror story into a ${recipe.sceneCount}-scene vertical reel. Follow the STORY BIBLE exactly — same anchor object, same rule, same escalation order, ending on the final twist.

STORY BIBLE:
- Premise: ${bible.premise}
- Setting: ${bible.setting}
- Narrator: ${bible.protagonist}
- Anchor object: ${bible.anchorObject}
- Impossible rule: ${bible.impossibleRule}
- Escalation: ${bible.escalation.map((b, i) => `${i + 1}. ${b}`).join("  ")}
- Art direction (apply to EVERY visualPrompt): ${bible.artDirection}
- Final line: ${bible.finalTwist}

HORROR QUALITY BAR:
- Believable first-person witness account recorded after the fact, not a campfire story.
- Target a finished 55-75 second story. Each scene narration is 16-32 words, ONE clear new beat, in the escalation order above.
- Concrete sensory detail: sounds, distances, timestamps, object positions, temperature, reflections.
- Fear from implication and pattern-breaking, never gore, monsters, jump-scare wording, or lore.
- The FINAL scene must land the final twist and quietly prove the danger was already in the room.
- Avoid: creepy, terrifying, scary, demon, monster, haunted, suddenly.
- Each visualPrompt describes ONLY imagery (subject, setting, mood, lighting) and MUST re-use the art-direction motifs and show the anchor object consistently. No style words, no text-in-image.

OUTPUT JSON ONLY (no markdown):
{
  "title": "catchy title",
  "hook": "on-screen hook text (<= 8 words)",
  "scenes": [ { "narration": "spoken line", "visualPrompt": "image description" } ]
}
Exactly ${recipe.sceneCount} scenes. Scene 1's narration is the HOOK — grab attention in the first 3 seconds.`;

  try {
    const { text, usage } = await generateText({ model: openrouter(llm), prompt: scriptPrompt, temperature: 0.85 });
    reportLlmUsage(onLlmUsage, "Scene script", llm, usage);
    const parsed = extractJson<PlannedReel>(text);
    if (!parsed.scenes?.length) throw new Error("No scenes returned");
    const planned = tightenHorrorPlan(parsed);
    planned.storyBible = bible;
    const warnings = horrorQualityWarnings(planned);
    if (warnings.length) console.warn(`⚠️ Horror script quality warning: ${warnings.join(", ")}`);
    console.log(`📝 Planned "${planned.title}" — ${planned.scenes.length} scenes (${recipe.niche}) via ${llm} [2-pass]`);
    return planned;
  } catch (error: unknown) {
    throw new Error(`Horror scene-script pass failed: ${getErrorMessage(error)}`);
  }
}

export interface RedditStory {
  title: string; // the curiosity-gap hook (also the post title card)
  body: string; // first-person narration read over gameplay
  source?: "llm" | "hybrid" | "verbatim";
  subreddit?: string;
  author?: string;
  upvotes?: number;
  comments?: number;
  ageHours?: number;
  partNumber?: number;
  partCount?: number;
}

/**
 * Plan a Reddit-style story (AITA / confession / revenge) for the gameplay
 * overlay format. The title IS the hook; the body is read start-to-finish over
 * a looping gameplay background with bouncing word captions.
 */
export async function planRedditStory(
  topic: string,
  tier: Tier = "value",
  genre?: string
): Promise<RedditStory> {
  const llm = resolveModels(tier).llm;
  const recipe = getRecipe("reddit");
  const trendBlock = await buildTrendBlock("reddit", genre);

  const prompt = `You write viral Reddit-style short-form stories read aloud over gameplay footage.

TOPIC/SEED: ${topic}
DIRECTION: ${recipe.scriptGuide}${trendBlock}

RULES:
- The TITLE is a curiosity-gap hook (r/AITA or r/confession style), max ~12 words, no clickbait emojis.
- BODY: first person, conversational, 90-160 words, 5-10 short punchy sentences. Escalating tension, satisfying payoff/twist in the last sentence.
- Read naturally aloud: spell out numbers, no markdown, no headings, no emojis, no "edit:"/"update:".

OUTPUT JSON ONLY (no markdown):
{ "title": "the post title / hook", "body": "the full story to narrate" }`;

  try {
    const { text } = await generateText({ model: openrouter(llm), prompt });
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in model response");
    const parsed = JSON.parse(jsonMatch[0]) as RedditStory;
    if (!parsed.title || !parsed.body) throw new Error("Missing title/body");
    console.log(`📝 Reddit story: "${parsed.title}" (${parsed.body.split(/\s+/).length} words)`);
    return parsed;
  } catch (error: unknown) {
    throw new Error(`Reddit story planning failed: ${getErrorMessage(error)}`);
  }
}
