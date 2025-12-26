import type { Context } from "elysia";
import {
  createCharacter,
  getCharacter,
  listCharacters,
  updateCharacter,
  deleteCharacter,
} from "../services";
import type {
  TIdParams,
  TCreateCharacterBody,
  TUpdateCharacterBody,
} from "../types/guards";

// ============================================
// Type Definitions for Controller Context
// ============================================

interface UploadedFiles {
  image?: string;
  [key: string]: string | undefined;
}

interface CreateCharacterContext extends Context {
  body: TCreateCharacterBody;
  uploadedFiles: UploadedFiles;
}

interface GetCharacterContext extends Context {
  params: TIdParams;
}

interface UpdateCharacterContext extends Context {
  params: TIdParams;
  body: TUpdateCharacterBody;
  uploadedFiles: UploadedFiles;
}

interface DeleteCharacterContext extends Context {
  params: TIdParams;
}

// ============================================
// Controller Functions
// ============================================

/**
 * Create a new character
 */
export async function createCharacterController({
  body,
  uploadedFiles,
}: CreateCharacterContext) {
  const { name, displayName, voiceId, positionX, positionY, scale, anchor } =
    body;

  try {
    const character = await createCharacter({
      name,
      displayName,
      voiceId,
      imageUrl: uploadedFiles.image!,
      position: {
        x: positionX,
        y: positionY,
        scale,
        anchor: anchor as any,
      },
    });

    return { success: true, data: character };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

/**
 * List all characters
 */
export async function listCharactersController() {
  const characters = await listCharacters();
  return { success: true, data: characters };
}

/**
 * Get a character by ID or name
 */
export async function getCharacterController({ params }: GetCharacterContext) {
  const character = await getCharacter(params.id);
  if (!character) {
    return { success: false, error: "Character not found" };
  }
  return { success: true, data: character };
}

/**
 * Update a character
 */
export async function updateCharacterController({
  params,
  body,
  uploadedFiles,
}: UpdateCharacterContext) {
  try {
    const updates: any = {
      displayName: body.displayName,
      voiceId: body.voiceId,
      position: body.position,
    };

    // If image was uploaded, use the S3 URL from middleware
    if (uploadedFiles.image) {
      updates.imageUrl = uploadedFiles.image;
    }

    const updated = await updateCharacter(params.id, updates);
    if (!updated) {
      return { success: false, error: "Character not found" };
    }
    return { success: true, data: updated };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

/**
 * Delete a character
 */
export async function deleteCharacterController({
  params,
}: DeleteCharacterContext) {
  const deleted = await deleteCharacter(params.id);
  if (!deleted) {
    return { success: false, error: "Character not found" };
  }
  return { success: true, data: { deleted: true } };
}
