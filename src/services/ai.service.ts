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
  delay: number; // Seconds of pause before this line (for natural conversation flow)
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
- Add natural conversation delays before each line (in seconds):
  * 0.1-0.3s for quick responses/interruptions
  * 0.3-0.6s for normal conversational flow
  * 0.6-1.0s for thoughtful pauses, topic changes, or dramatic effect
  * 1.0-1.5s for long pauses after important statements or jokes
  * First line should have 0 delay

OUTPUT FORMAT (JSON only, no markdown):
{
  "title": "A catchy title for this video",
  "dialogues": [
    { "characterName": "character_name_here", "text": "What they say", "delay": 0 },
    { "characterName": "other_character", "text": "Their response", "delay": 0.4 }
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
  } catch (_error: unknown) {
    return "Untitled Video";
  }
}
