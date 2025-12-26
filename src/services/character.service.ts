import { v4 as uuidv4 } from "uuid";
import { join } from "node:path";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { config } from "../config";
import type {
  Character,
  CharacterPosition,
  DEFAULT_CHARACTER_POSITION,
} from "../types";
import { ensureDir, fileExists } from "../utils";

// In-memory character storage
const characters = new Map<string, Character>();
const CHARACTERS_JSON = "characters.json";

/**
 * Load characters from disk on startup
 */
export async function loadCharacters(): Promise<void> {
  try {
    const filePath = join(config.charactersPath, CHARACTERS_JSON);
    if (await fileExists(filePath)) {
      const data = await readFile(filePath, "utf-8");
      const loaded = JSON.parse(data) as Character[];
      for (const char of loaded) {
        char.createdAt = new Date(char.createdAt);
        characters.set(char.id, char);
      }
      console.log(`👥 Loaded ${characters.size} characters`);
    }
  } catch (error) {
    console.warn("Could not load characters:", error);
  }
}

/**
 * Save characters to disk
 */
async function saveCharacters(): Promise<void> {
  const filePath = join(config.charactersPath, CHARACTERS_JSON);
  const data = JSON.stringify(Array.from(characters.values()), null, 2);
  await writeFile(filePath, data);
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
): Promise<Character> {
  await ensureDir(config.charactersPath);

  const id = uuidv4();
  const ext = filename.split(".").pop() || "png";
  const imageFilename = `${id}.${ext}`;
  const imagePath = join(config.charactersPath, imageFilename);

  // Save image file
  await writeFile(imagePath, imageBuffer);

  const defaultPos: CharacterPosition = {
    x: 10,
    y: 70,
    scale: 0.25,
    anchor: "bottom-left",
  };

  const character: Character = {
    id,
    name,
    displayName,
    voiceId,
    imagePath,
    defaultPosition: {
      ...defaultPos,
      ...position,
    } as CharacterPosition,
    createdAt: new Date(),
  };

  characters.set(id, character);
  await saveCharacters();

  console.log(`👤 Created character: ${displayName}`);

  return character;
}

/**
 * Get a character by ID or name
 */
export function getCharacter(idOrName: string): Character | undefined {
  // Try by ID first
  const byId = characters.get(idOrName);
  if (byId) return byId;

  // Try by name
  for (const char of characters.values()) {
    if (char.name.toLowerCase() === idOrName.toLowerCase()) {
      return char;
    }
  }

  return undefined;
}

/**
 * List all characters
 */
export function listCharacters(): Character[] {
  return Array.from(characters.values()).sort((a, b) =>
    a.displayName.localeCompare(b.displayName)
  );
}

/**
 * Update a character
 */
export async function updateCharacter(
  id: string,
  updates: Partial<Omit<Character, "id" | "createdAt">>
): Promise<Character | undefined> {
  const character = characters.get(id);
  if (!character) return undefined;

  Object.assign(character, updates);
  await saveCharacters();

  return character;
}

/**
 * Delete a character
 */
export async function deleteCharacter(id: string): Promise<boolean> {
  const character = characters.get(id);
  if (!character) return false;

  // Delete image file
  try {
    await unlink(character.imagePath);
  } catch (error) {
    console.warn("Could not delete character image:", error);
  }

  characters.delete(id);
  await saveCharacters();

  console.log(`🗑️  Deleted character: ${id}`);

  return true;
}
