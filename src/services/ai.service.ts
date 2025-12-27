import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import { config } from "../config";
import type { ICharacter } from "../models";
import { getErrorMessage } from "../types";

// Initialize OpenRouter client
const openrouter = createOpenRouter({
  apiKey: config.openRouterApiKey,
});

export interface GeneratedDialogue {
  characterName: string;
  text: string;
}

export interface GeneratedScript {
  title: string;
  dialogues: GeneratedDialogue[];
}

/**
 * Generate a dialogue script from a plot description
 */
export async function generateScript(
  plot: string,
  characters: ICharacter[],
  maxDuration: number | null = 60
): Promise<GeneratedScript> {
  const characterList = characters
    .map(
      (c) =>
        `- ${c.displayName} (${c.name}): A character who will speak in the video`
    )
    .join("\n");

  const durationValue = maxDuration ?? 60;

  const prompt = `You are a script writer for short-form video content. Generate a dialogue script based on the following:

PLOT: ${plot}

CHARACTERS:
${characterList}

REQUIREMENTS:
- The video should be approximately ${durationValue} seconds long
- Each character should have natural, conversational dialogue
- Keep each line SHORT (under 15 words) for easy listening
- Create 6-10 dialogue lines total
- Make it entertaining and engaging
- Characters should interact naturally with each other

OUTPUT FORMAT (JSON only, no markdown):
{
  "title": "A catchy title for this video",
  "dialogues": [
    { "characterName": "character_name_here", "text": "What they say" },
    { "characterName": "other_character", "text": "Their response" }
  ]
}

Generate the script now:`;

  try {
    const { text } = await generateText({
      model: openrouter(config.openRouterModel),
      prompt,
    });

    // Parse JSON response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Failed to parse script from AI response");
    }

    const script = JSON.parse(jsonMatch[0]) as GeneratedScript;

    // Validate character names exist
    const characterNames = new Set(characters.map((c) => c.name.toLowerCase()));
    for (const dialogue of script.dialogues) {
      if (!characterNames.has(dialogue.characterName.toLowerCase())) {
        // Try to match by display name
        const match = characters.find(
          (c) =>
            c.displayName
              .toLowerCase()
              .includes(dialogue.characterName.toLowerCase()) ||
            dialogue.characterName.toLowerCase().includes(c.name.toLowerCase())
        );
        if (match) {
          dialogue.characterName = match.name;
        } else {
          throw new Error(
            `Unknown character in script: ${dialogue.characterName}`
          );
        }
      }
    }

    console.log(
      `📝 Generated script with ${script.dialogues.length} dialogue lines`
    );

    return script;
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    console.error("AI script generation failed:", message);
    throw new Error(`Failed to generate script: ${message}`);
  }
}

/**
 * Generate a video title from plot
 */
export async function generateTitle(plot: string): Promise<string> {
  try {
    const { text } = await generateText({
      model: openrouter(config.openRouterModel),
      prompt: `Generate a short, catchy video title (max 10 words) for this content: "${plot}". Return only the title, no quotes or explanation.`,
    });

    return text.trim().replace(/^["']|["']$/g, "");
  } catch (error: unknown) {
    return "Untitled Video";
  }
}
