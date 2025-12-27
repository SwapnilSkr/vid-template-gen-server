import type { Context } from "elysia";
import {
  createTemplateWithProcessing,
  getTemplate,
  listTemplates,
  updateTemplateWithProcessing,
  deleteTemplate,
  addCharactersToTemplate,
  removeCharactersFromTemplate,
} from "../services";
import type {
  TIdParams,
  TCreateTemplateBody,
  TUpdateTemplateBody,
  TTemplateCharactersBody,
  TTemplateQuery,
} from "../types/guards";
import { getErrorMessage } from "../types";

// ============================================
// Type Definitions for Controller Context
// ============================================

interface LocalFiles {
  video?: string;
  [key: string]: string | undefined;
}

interface CreateTemplateContext extends Omit<Context, "query"> {
  body: TCreateTemplateBody;
  query: TTemplateQuery;
  localFiles: LocalFiles;
}

interface UpdateTemplateContext extends Omit<Context, "query"> {
  params: TIdParams;
  body: TUpdateTemplateBody;
  query: TTemplateQuery;
  localFiles: LocalFiles;
}

interface GetTemplateContext extends Context {
  params: TIdParams;
}

interface TemplateCharactersContext extends Context {
  params: TIdParams;
  body: TTemplateCharactersBody;
}

interface DeleteTemplateContext extends Context {
  params: TIdParams;
}

// ============================================
// Controller Functions
// ============================================

/**
 * Create a new template
 */
export async function createTemplateController({
  body,
  query,
  localFiles,
}: CreateTemplateContext) {
  const { name, description, video } = body;
  const { trimStart, keepDuration, removeAudio } = query;
  const localPath = localFiles.video;

  if (!localPath) {
    return { success: false, error: "Video file is required" };
  }

  try {
    const template = await createTemplateWithProcessing(
      localPath,
      { name, description: description || "", originalName: video.name },
      { trimStart, keepDuration, removeAudio }
    );

    return { success: true, data: template };
  } catch (error: unknown) {
    return { success: false, error: getErrorMessage(error) };
  }
}

/**
 * List all templates
 */
export async function listTemplatesController() {
  const templates = await listTemplates();
  return { success: true, data: templates };
}

/**
 * Get a template by ID
 */
export async function getTemplateController({ params }: GetTemplateContext) {
  const template = await getTemplate(params.id);
  if (!template) {
    return { success: false, error: "Template not found" };
  }
  return { success: true, data: template };
}

/**
 * Add characters to a template
 */
export async function addCharactersToTemplateController({
  params,
  body,
}: TemplateCharactersContext) {
  try {
    const template = await addCharactersToTemplate(
      params.id,
      body.characterIds
    );
    if (!template) {
      return { success: false, error: "Template not found" };
    }
    return { success: true, data: template };
  } catch (error: unknown) {
    return { success: false, error: getErrorMessage(error) };
  }
}

/**
 * Remove characters from a template
 */
export async function removeCharactersFromTemplateController({
  params,
  body,
}: TemplateCharactersContext) {
  try {
    const template = await removeCharactersFromTemplate(
      params.id,
      body.characterIds
    );
    if (!template) {
      return { success: false, error: "Template not found" };
    }
    return { success: true, data: template };
  } catch (error: unknown) {
    return { success: false, error: getErrorMessage(error) };
  }
}

/**
 * Update a template
 */
export async function updateTemplateController({
  params,
  body,
  query,
  localFiles,
}: UpdateTemplateContext) {
  const { name, description, video } = body;
  const { trimStart, keepDuration, removeAudio } = query;
  const localPath = localFiles.video;

  try {
    const updated = await updateTemplateWithProcessing(
      params.id,
      {
        name,
        description,
        localPath,
        originalName: video?.name,
      },
      { trimStart, keepDuration, removeAudio }
    );

    if (!updated) {
      return { success: false, error: "Template not found" };
    }
    return { success: true, data: updated };
  } catch (error: unknown) {
    return { success: false, error: getErrorMessage(error) };
  }
}

/**
 * Delete a template
 */
export async function deleteTemplateController({
  params,
}: DeleteTemplateContext) {
  const deleted = await deleteTemplate(params.id);
  if (!deleted) {
    return { success: false, error: "Template not found" };
  }
  return { success: true, data: { deleted: true } };
}
