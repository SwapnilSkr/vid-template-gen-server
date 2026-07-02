import type { ICharacterPosition } from "../models";

/**
 * @deprecated - Use ICharacterPosition from models instead
 */
export interface Character {
  id: string;
  name: string;
  displayName: string;
  voiceId: string;
  imagePath: string;
  createdAt: Date;
}

/**
 * Character position - all fields required
 */
export type CharacterPosition = Required<ICharacterPosition>;

export interface VoiceSettings {
  stability: number; // 0-1
  similarityBoost: number; // 0-1
  style: number; // 0-1
  useSpeakerBoost: boolean;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0.5,
  useSpeakerBoost: true,
};

export const DEFAULT_CHARACTER_POSITION: CharacterPosition = {
  x: 50,
  y: 80,
  scale: 0.3,
  anchor: "bottom-left",
  animation: "none",
  animationDuration: 0.3,
};
