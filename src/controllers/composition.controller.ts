import type { Context } from "elysia";
import {
  createComposition,
  getComposition,
  listCompositions,
  regenerateComposition,
} from "../services";
import type {
  TIdParams,
  TCreateCompositionBody,
  TRegenerateCompositionBody,
} from "../types/guards";
import { getErrorMessage } from "../types";

// ============================================
// Type Definitions for Controller Context
// ============================================

interface CreateCompositionContext extends Context {
  body: TCreateCompositionBody;
}

interface GetCompositionContext extends Context {
  params: TIdParams;
}

interface ListCompositionsContext extends Context {
  query: { limit?: string };
}

interface RegenerateCompositionContext extends Context {
  params: TIdParams;
  body: TRegenerateCompositionBody;
}

// ============================================
// Controller Functions
// ============================================

/**
 * Create a new composition (start video generation job)
 */
export async function createCompositionController({
  body,
}: CreateCompositionContext) {
  try {
    const job = await createComposition(
      body.templateId,
      body.plot,
      body.title,
      body.subtitlePosition
    );
    return {
      success: true,
      data: job,
      message: "Composition started! Check status for progress.",
    };
  } catch (error: unknown) {
    return { success: false, error: getErrorMessage(error) };
  }
}

/**
 * List all compositions
 */
export async function listCompositionsController({
  query,
}: ListCompositionsContext) {
  const limit = query.limit ? parseInt(query.limit) : 50;
  const compositions = await listCompositions(limit);
  return { success: true, data: compositions };
}

/**
 * Get composition status
 */
export async function getCompositionStatusController({
  params,
}: GetCompositionContext) {
  const composition = await getComposition(params.id);
  if (!composition) {
    return { success: false, error: "Composition not found" };
  }
  return {
    success: true,
    data: {
      id: composition._id,
      status: composition.status,
      progress: composition.progress,
      title: composition.title,
      script: composition.generatedScript,
      outputUrl: composition.outputUrl,
      error: composition.error,
    },
  };
}

/**
 * Download completed composition
 */
export async function downloadCompositionController({
  params,
  set,
}: GetCompositionContext) {
  const composition = await getComposition(params.id);
  if (!composition) {
    set.status = 404;
    return { success: false, error: "Composition not found" };
  }

  if (composition.status !== "completed") {
    set.status = 400;
    return {
      success: false,
      error: `Composition not completed. Current status: ${composition.status}`,
      progress: composition.progress,
    };
  }

  if (!composition.outputUrl) {
    set.status = 404;
    return { success: false, error: "Output not available" };
  }

  // Return S3 URL for download
  return {
    success: true,
    data: {
      downloadUrl: composition.outputUrl,
      subtitlesUrl: composition.subtitlesUrl,
    },
  };
}

/**
 * Generate composition (alias endpoint) - Create
 */
export async function generateCompositionController({
  body,
}: CreateCompositionContext) {
  try {
    const job = await createComposition(
      body.templateId,
      body.plot,
      body.title,
      body.subtitlePosition
    );
    return {
      success: true,
      data: {
        id: job._id,
        status: job.status,
        message: "AI is generating the script...",
      },
    };
  } catch (error: unknown) {
    return { success: false, error: getErrorMessage(error) };
  }
}

/**
 * Get generated composition (alias endpoint)
 */
export async function getGeneratedCompositionController({
  params,
}: GetCompositionContext) {
  const composition = await getComposition(params.id);
  if (!composition) {
    return { success: false, error: "Not found" };
  }
  return {
    success: true,
    data: {
      id: composition._id,
      status: composition.status,
      progress: composition.progress,
      title: composition.title,
      script: composition.generatedScript,
      outputUrl: composition.outputUrl,
      subtitlesUrl: composition.subtitlesUrl,
      error: composition.error,
    },
  };
}

/**
 * Regenerate composition video using existing speech files
 * Saves ElevenLabs API costs by reusing already generated audio
 */
export async function regenerateCompositionController({
  params,
  body,
}: RegenerateCompositionContext) {
  try {
    const composition = await regenerateComposition(
      params.id,
      body.delays,
      body.subtitlePosition
    );
    return {
      success: true,
      data: {
        id: composition._id,
        status: composition.status,
        progress: composition.progress,
        message:
          "Regenerating video with existing audio files... Check status for progress.",
      },
    };
  } catch (error: unknown) {
    return { success: false, error: getErrorMessage(error) };
  }
}
