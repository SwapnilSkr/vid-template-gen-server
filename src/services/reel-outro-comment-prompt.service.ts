import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import { config } from "../config";
import { resolveModels } from "../config/models";
import { Reel, type IReel } from "../models";
import { getErrorMessage } from "../types";
import { applyMeasuredCostsToReel, type MeasuredCostInput } from "./reel-cost.service";
import { deleteS3Urls } from "./s3.service";
import { reportLlmUsage, type LlmUsageCallback } from "./reel-script.service";
import { invalidateFinalDestinationRenders } from "./reel-outro.service";
import { recordOperationLog } from "./operation-log.service";
import { platformCopyRules } from "./platform-copy-rules.service";

const openrouter = createOpenRouter({ apiKey: config.openRouterApiKey });

/** Kept only for unavailable-AI/missing-source cases. Normal planning writes a
 * short question generated from the exact story part instead. */
export const DEFAULT_OUTRO_COMMENT_PROMPT = "What would you have done in this situation?";
const LEGACY_GENERIC_PROMPTS = new Set([
  "who was in the wrong? drop your take in the comments.",
  DEFAULT_OUTRO_COMMENT_PROMPT.toLocaleLowerCase(),
]);

export type OutroCommentPromptScope = "primary" | "inheriting" | "all";

function storySource(reel: IReel): string {
  if (reel.redditStory) {
    return [
      reel.redditStory.title,
      reel.redditStory.body,
      reel.partNumber && reel.partCount && reel.partCount > 1
        ? `Part ${reel.partNumber} of ${reel.partCount}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 2_800);
  }

  return [reel.title, reel.hook, reel.topic, ...reel.scenes.map((scene) => scene.narration)]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 2_800);
}

function fallbackPrompt(reel: IReel): string {
  const subject = (reel.redditStory?.title ?? reel.title ?? reel.hook ?? "").trim();
  if (subject) return "After this part, what would you have done differently?";
  return DEFAULT_OUTRO_COMMENT_PROMPT;
}

function cleanPrompt(value: string | undefined): string | undefined {
  const text = value
    ?.replace(/[\r\n]+/g, " ")
    .replace(/^\s*["'“”]+|["'“”]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  const bounded = text.length <= 120 ? text : text.slice(0, 120).replace(/\s+\S*$/, "").trim();
  if (!bounded) return undefined;
  return /[?!.]$/.test(bounded) ? bounded : `${bounded}?`;
}

function extractPrompt(text: string): string | undefined {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return cleanPrompt(text);
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return typeof parsed.commentPrompt === "string" ? cleanPrompt(parsed.commentPrompt) : undefined;
  } catch {
    return cleanPrompt(text);
  }
}

async function generatePrompt(
  reel: IReel,
  onLlmUsage?: LlmUsageCallback,
): Promise<{ prompt: string; source: "ai" | "fallback"; model?: string }> {
  const source = storySource(reel);
  const model = resolveModels("cheap").llm;
  if (!source || !config.openRouterApiKey) {
    return { prompt: fallbackPrompt(reel), source: "fallback" };
  }

  const partContext =
    reel.partNumber && reel.partCount && reel.partCount > 1
      ? `This is part ${reel.partNumber} of ${reel.partCount}. Only use information in this part; do not spoil later parts.`
      : "This is a standalone or final part.";
  try {
    const { text, usage } = await generateText({
      model: openrouter(model),
      prompt: `Write one addictive comment question for the branded outro of this short-form story video.

STORY MATERIAL FOR THIS EXACT REEL PART:
${source}

Rules:
- Output JSON only: {"commentPrompt":"..."}.
- ${partContext}
- 7–18 natural words, 120 characters maximum, and exactly one provocative question.
- Make the question specific to the decision, relationship, accusation, reveal, or consequence in this part. It must make viewers want to choose a side or explain what they would do.
- Never use generic phrasing such as "Who was in the wrong?", "Drop your take", "What do you think?", or "Comment below".
- Do not repeat four consecutive words from the source title, give a CTA, mention a part number, add hashtags/emojis, invent facts, or spoil future updates.

${platformCopyRules("youtube")}

Use the story material and the platform defaults only. This one global outro question may be used on more than one platform, so do not import YouTube research or another platform's analytics into it.`,
    });
    reportLlmUsage(onLlmUsage, "Outro comment prompt", model, usage);
    const prompt = extractPrompt(text);
    if (!prompt) throw new Error("Outro comment prompt model returned invalid copy");
    return { prompt, source: "ai", model };
  } catch (error: unknown) {
    console.warn(`Outro comment prompt generation failed, using fallback: ${getErrorMessage(error)}`);
    recordOperationLog({
      scope: "external",
      level: "warn",
      event: "outro.comment_prompt_ai_fallback",
      message: "Story-specific outro comment prompt generation failed; saved a guarded fallback",
      reelId: reel._id.toString(),
      error,
    });
    return { prompt: fallbackPrompt(reel), source: "fallback" };
  }
}

/** Ensure every newly planned reel has a generated primary outro question.
 * Blank extra destinations inherit this primary value at render time. */
export async function ensureReelOutroCommentPrompt(
  reel: IReel,
  onLlmUsage?: LlmUsageCallback,
): Promise<string> {
  const existing = cleanPrompt(reel.outro?.commentPrompt);
  // Upgrade previous static defaults whenever this reel next plans/renders.
  // A distinct creator-written prompt remains an explicit override.
  if (existing && !LEGACY_GENERIC_PROMPTS.has(existing.toLocaleLowerCase())) {
    if (reel.outro?.commentPrompt !== existing) {
      reel.outro = { ...(reel.outro ?? {}), commentPrompt: existing };
      reel.markModified("outro");
    }
    return existing;
  }

  const generated = await generatePrompt(reel, onLlmUsage);
  reel.outro = { ...(reel.outro ?? {}), commentPrompt: generated.prompt };
  reel.markModified("outro");
  recordOperationLog({
    scope: "system",
    event: "outro.comment_prompt_generated",
    message: "Generated a story-specific branded-outro comment prompt",
    reelId: reel._id.toString(),
    metadata: { source: generated.source, model: generated.model, partNumber: reel.partNumber },
  });
  return generated.prompt;
}

/** Replace the primary prompt on demand. This invalidates only the primary
 * output plus destinations that inherit the primary prompt; all body media,
 * scene assets, and narration remain cached. */
/**
 * Regenerate the global story question and apply it deliberately:
 * - primary: freeze inheriting extras on their prior effective prompt
 * - inheriting: blank extras continue to inherit the new global prompt
 * - all: overwrite every extra draft with the generated prompt
 */
export async function regenerateReelOutroCommentPrompt(
  reelId: string,
  scope: OutroCommentPromptScope = "inheriting",
): Promise<IReel> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  const measuredCosts: MeasuredCostInput[] = [];
  const generated = await generatePrompt(reel, (usage) => {
    measuredCosts.push({ ...usage, source: "actual" });
  });

  const previousPrompt = cleanPrompt(reel.outro?.commentPrompt) ?? DEFAULT_OUTRO_COMMENT_PROMPT;
  const previousAudio = reel.outroAudioUrl;
  reel.outro = { ...(reel.outro ?? {}), commentPrompt: generated.prompt };
  reel.outroAudioUrl = undefined;
  reel.outroAudioSignature = undefined;
  reel.markModified("outro");

  const changedDestinationIds: string[] = [];
  for (const destination of reel.destinations ?? []) {
    const explicitPrompt = cleanPrompt(destination.outro?.commentPrompt);
    const previousEffectivePrompt = explicitPrompt ?? previousPrompt;

    if (scope === "primary" && !explicitPrompt) {
      // Freeze an inherited draft before changing the global question. Its
      // existing output/TTS stays valid because the effective string is equal.
      destination.outro = { ...(destination.outro ?? {}), commentPrompt: previousEffectivePrompt };
      continue;
    }
    if (scope === "all" && previousEffectivePrompt !== generated.prompt) {
      destination.outro = { ...(destination.outro ?? {}), commentPrompt: generated.prompt };
      changedDestinationIds.push(destination.id);
      continue;
    }
    if (scope === "inheriting" && !explicitPrompt && previousEffectivePrompt !== generated.prompt) {
      changedDestinationIds.push(destination.id);
    }
  }
  if ((reel.destinations ?? []).length) reel.markModified("destinations");
  const staleOutputs = invalidateFinalDestinationRenders(reel, {
    reason: "Primary story-specific outro comment prompt changed",
    includePrimary: true,
    includeExtras: changedDestinationIds.length > 0,
    extraDestinationIds: changedDestinationIds,
    clearOutroAudio: true,
  });
  applyMeasuredCostsToReel(reel, measuredCosts, "Outro comment prompt");
  await reel.save();
  await deleteS3Urls([previousAudio, ...staleOutputs]);

  recordOperationLog({
    scope: "system",
    event: "outro.comment_prompt_regenerated",
    message: "Regenerated the primary story-specific outro comment prompt",
    reelId,
    metadata: {
      source: generated.source,
      model: generated.model,
      scope,
      affectedDestinationCount: changedDestinationIds.length,
    },
  });
  return reel;
}
