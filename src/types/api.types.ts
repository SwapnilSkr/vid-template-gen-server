import type { VideoTemplate } from "./template.types";
import type { Character } from "./character.types";
import type { CompositionJob } from "./composition.types";

// Generic responses
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
}

// Template API
export interface UploadTemplateRequest {
  name: string;
  description?: string;
}

export interface TemplateResponse extends ApiResponse<VideoTemplate> {}
export interface TemplateListResponse extends ApiResponse<VideoTemplate[]> {}

// Character API
export interface CreateCharacterRequest {
  name: string;
  displayName: string;
  voiceId: string;
  defaultPosition?: {
    x: number;
    y: number;
    scale: number;
    anchor: string;
  };
}

export interface CharacterResponse extends ApiResponse<Character> {}
export interface CharacterListResponse extends ApiResponse<Character[]> {}

// Composition API
export interface CompositionResponse extends ApiResponse<CompositionJob> {}
export interface CompositionListResponse
  extends ApiResponse<CompositionJob[]> {}
