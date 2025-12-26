export interface Character {
  id: string;
  name: string;
  displayName: string;
  voiceId: string;
  imagePath: string;
  defaultPosition: CharacterPosition;
  createdAt: Date;
}

export interface CharacterPosition {
  x: number; // 0-100% from left
  y: number; // 0-100% from top
  scale: number; // 1.0 = original size
  anchor: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";
}

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
};
