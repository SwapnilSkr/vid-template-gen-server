export interface VideoTemplate {
  id: string;
  name: string;
  description: string;
  filePath: string;
  duration: number; // in seconds
  width: number;
  height: number;
  frameRate: number;
  createdAt: Date;
  thumbnailPath?: string;
}

export interface TemplateMetadata {
  duration: number | null;
  width: number;
  height: number;
  frameRate: number;
  codec: string;
  bitrate: number;
}
