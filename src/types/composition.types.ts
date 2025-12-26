import type { CharacterPosition } from "./character.types";

export interface DialogueLine {
  characterId: string;
  text: string;
  startTime: number; // seconds
  duration?: number; // auto-calculated from audio
  position?: CharacterPosition; // override default
}

export interface CompositionRequest {
  templateId: string;
  title: string;
  dialogue: DialogueLine[];
  outputSettings?: OutputSettings;
}

export interface OutputSettings {
  resolution?: "720p" | "1080p" | "4k";
  format?: "mp4" | "webm";
  quality?: "low" | "medium" | "high";
}

export interface CompositionJob {
  id: string;
  status: CompositionStatus;
  progress: number; // 0-100
  templateId: string;
  title: string;
  dialogue: DialogueLine[];
  outputPath?: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

export type CompositionStatus =
  | "pending"
  | "processing_audio"
  | "processing_video"
  | "compositing"
  | "finalizing"
  | "completed"
  | "failed";

export interface AudioSegment {
  characterId: string;
  text: string;
  audioPath: string;
  startTime: number;
  duration: number;
}

export interface VideoSegment {
  characterId: string;
  imagePath: string;
  position: CharacterPosition;
  startTime: number;
  endTime: number;
}
