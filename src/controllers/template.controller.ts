import type { Context } from "elysia";
import {
  createTemplate,
  getTemplate,
  listTemplates,
  deleteTemplate,
  addCharactersToTemplate,
  removeCharactersFromTemplate,
} from "../services";
import type {
  TIdParams,
  TCreateTemplateBody,
  TTemplateCharactersBody,
} from "../types/guards";

// ============================================
// Type Definitions for Controller Context
// ============================================

interface UploadedFiles {
  video?: string;
  [key: string]: string | undefined;
}

interface CreateTemplateContext extends Context {
  body: TCreateTemplateBody;
  uploadedFiles: UploadedFiles;
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
  uploadedFiles,
}: CreateTemplateContext) {
  const { name, description } = body;

  try {
    const template = await createTemplate(
      uploadedFiles.video!,
      name,
      description || ""
    );

    return { success: true, data: template };
  } catch (error: any) {
    return { success: false, error: error.message };
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
  } catch (error: any) {
    return { success: false, error: error.message };
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
  } catch (error: any) {
    return { success: false, error: error.message };
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
