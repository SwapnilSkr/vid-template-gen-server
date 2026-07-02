import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import { config } from "../config";
import { resolveModels, type Tier } from "../config/models";
import { getRecipe, type NicheRecipe } from "../config/niche-styles";
import { getErrorMessage } from "../types";
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

export interface PlannedScene {
  narration: string;
  visualPrompt: string;
}

export interface PlannedReel {
  title: string;
  hook: string;
  scenes: PlannedScene[];
}

function planningModelFor(recipe: NicheRecipe, tier: Tier): string {
  return process.env.LLM_MODEL || recipe.scriptModel || resolveModels(tier).llm;
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
  const tooLong = plan.scenes.some((scene) => countWords(scene.narration) > 24);
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
  genre?: string
): Promise<PlannedReel> {
  const recipe = getRecipe(niche);
  const llm = planningModelFor(recipe, tier);
  const trendBlock = await buildTrendBlock(niche, genre);
  const horrorRules =
    recipe.niche === "horror"
      ? `
HORROR QUALITY BAR:
- Write like a believable first-person witness account recorded after the fact, not a campfire story.
- Every scene narration must be 8-22 words. Short enough to whisper without sounding bored.
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

  const prompt = `You are a ${recipe.niche === "horror" ? "literary short-form horror writer and audio-first scene planner" : "viral short-form video scriptwriter"}. Produce a vertical faceless reel.

NICHE: ${recipe.displayName}
TOPIC: ${topic}
DIRECTION: ${recipe.scriptGuide}${trendBlock}
${horrorRules}

RULES:
- Exactly ${recipe.sceneCount} scenes. Each scene = ONE narration beat of 1-2 sentences (max ~30 words) AND one vivid image description.
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
    const { text } = await generateText({
      model: openrouter(llm),
      prompt,
      temperature: recipe.niche === "horror" ? 0.85 : undefined,
    });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in model response");
    const parsed = JSON.parse(jsonMatch[0]) as PlannedReel;

    if (!parsed.scenes?.length) throw new Error("No scenes returned");
    const planned = recipe.niche === "horror" ? tightenHorrorPlan(parsed) : parsed;
    if (recipe.niche === "horror") {
      const warnings = horrorQualityWarnings(planned);
      if (warnings.length) console.warn(`⚠️ Horror script quality warning: ${warnings.join(", ")}`);
    }

    console.log(`📝 Planned "${planned.title}" — ${planned.scenes.length} scenes (${recipe.niche}) via ${llm}`);
    return planned;
  } catch (error: unknown) {
    throw new Error(`Reel planning failed: ${getErrorMessage(error)}`);
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
