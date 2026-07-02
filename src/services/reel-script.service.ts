import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import { config } from "../config";
import { resolveModels, type Tier } from "../config/models";
import { getRecipe } from "../config/niche-styles";
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
  const llm = resolveModels(tier).llm;
  const trendBlock = await buildTrendBlock(niche, genre);
  const horrorRules =
    recipe.niche === "horror"
      ? `
HORROR QUALITY BAR:
- Write like a believable first-person incident report, not a campfire story.
- Use concrete sensory details: sounds, distances, timestamps, object positions.
- The fear must come from implication and pattern-breaking, not gore or jump-scare wording.
- The last scene must reveal that the threat was present earlier, or that escape made it worse.
- Avoid these words unless unavoidable: creepy, terrifying, scary, demon, monster, haunted, suddenly.
- If the script could fit any random horror video, rewrite it to be more specific to this topic.
`
      : "";

  const prompt = `You are a viral short-form video scriptwriter. Produce a vertical faceless reel.

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
    const { text } = await generateText({ model: openrouter(llm), prompt });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in model response");
    const parsed = JSON.parse(jsonMatch[0]) as PlannedReel;

    if (!parsed.scenes?.length) throw new Error("No scenes returned");

    console.log(`📝 Planned "${parsed.title}" — ${parsed.scenes.length} scenes (${recipe.niche})`);
    return parsed;
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
