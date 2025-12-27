import type { Context } from "elysia";
import {
  createCharacter,
  getCharacter,
  listCharacters,
  updateCharacter,
  deleteCharacter,
  type CharacterPosition,
} from "../services";
import type { ICharacter } from "../models";
import type {
  TIdParams,
  TCreateCharacterBody,
  TUpdateCharacterBody,
} from "../types/guards";
import { getErrorMessage } from "../types";

// ============================================
// Type Definitions for Controller Context
// ============================================

/**
 * Anchor position type - matches the model definition
 */
type CharacterAnchor =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "center";

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

/**
 * Character update data structure - matches service expectation
 */
type CharacterUpdateData = Partial<
  Pick<ICharacter, "displayName" | "voiceId" | "position" | "imageUrl">
>;

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
        anchor: anchor as CharacterAnchor,
      },
    });

    return { success: true, data: character };
  } catch (error: unknown) {
    return { success: false, error: getErrorMessage(error) };
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
    const updates: CharacterUpdateData = {
      displayName: body.displayName,
      voiceId: body.voiceId,
    };

    if (body.position) {
      // Body position is fully specified
      updates.position = {
        x: (body.position as CharacterPosition).x,
        y: (body.position as CharacterPosition).y,
        scale: (body.position as CharacterPosition).scale,
        anchor: (body.position as CharacterPosition).anchor as CharacterAnchor,
      };
    } else if (
      body.positionX !== undefined ||
      body.positionY !== undefined ||
      body.scale !== undefined ||
      body.anchor !== undefined
    ) {
      // Build position from individual fields with defaults
      updates.position = {
        x: body.positionX ?? 50,
        y: body.positionY ?? 75,
        scale: body.scale ?? 0.25,
        anchor: (body.anchor as CharacterAnchor) ?? "bottom-left",
      };
    }

    if (uploadedFiles.image) {
      updates.imageUrl = uploadedFiles.image;
    }

    const updated = await updateCharacter(params.id, updates);
    if (!updated) {
      return { success: false, error: "Character not found" };
    }
    return { success: true, data: updated };
  } catch (error: unknown) {
    return { success: false, error: getErrorMessage(error) };
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
