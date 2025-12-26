import { Character, type ICharacter } from "../models";
import { uploadImage, deleteFromS3 } from "./s3.service";

export interface CharacterPosition {
  x: number;
  y: number;
  scale: number;
  anchor: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";
}

/**
 * Create a new character
 */
export async function createCharacter(
  imageBuffer: Buffer,
  filename: string,
  name: string,
  displayName: string,
  voiceId: string,
  position?: Partial<CharacterPosition>
): Promise<ICharacter> {
  // Upload image to S3
  const imageUrl = await uploadImage(imageBuffer, "characters", filename);

  // Create character in DB
  const character = new Character({
    name: name.toLowerCase().trim(),
    displayName,
    voiceId,
    imageUrl,
    position: {
      x: position?.x ?? 50,
      y: position?.y ?? 75,
      scale: position?.scale ?? 0.25,
      anchor: position?.anchor ?? "bottom-left",
    },
  });

  await character.save();
  console.log(`👤 Created character: ${displayName}`);

  return character;
}

/**
 * Get a character by ID or name
 */
export async function getCharacter(
  idOrName: string
): Promise<ICharacter | null> {
  // Try by ID first
  if (idOrName.match(/^[0-9a-fA-F]{24}$/)) {
    const byId = await Character.findById(idOrName);
    if (byId) return byId;
  }

  // Try by name
  return Character.findOne({ name: idOrName.toLowerCase() });
}

/**
 * List all characters
 */
export async function listCharacters(): Promise<ICharacter[]> {
  return Character.find().sort({ displayName: 1 });
}

/**
 * Update a character
 */
export async function updateCharacter(
  id: string,
  updates: Partial<Pick<ICharacter, "displayName" | "voiceId" | "position">>
): Promise<ICharacter | null> {
  const character = await Character.findByIdAndUpdate(
    id,
    { $set: updates },
    { new: true }
  );

  return character;
}

/**
 * Delete a character
 */
export async function deleteCharacter(id: string): Promise<boolean> {
  const character = await Character.findById(id);
  if (!character) return false;

  // Delete image from S3
  if (character.imageUrl) {
    await deleteFromS3(character.imageUrl).catch(console.error);
  }

  await Character.findByIdAndDelete(id);
  console.log(`🗑️  Deleted character: ${id}`);

  return true;
}

/**
 * Get multiple characters by IDs
 */
export async function getCharactersByIds(ids: string[]): Promise<ICharacter[]> {
  return Character.find({ _id: { $in: ids } });
}
