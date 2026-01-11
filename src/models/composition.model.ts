import { Schema, model, type Document, type Types } from "mongoose";

// ============================================
// Type Definitions
// ============================================

/**
 * Screen type for composition - determines aspect ratio and positioning defaults
 */
export type ScreenType = "mobile" | "desktop";

/**
 * Character position configuration
 * x, y, and scale are optional - if not provided, calculated from anchor and screenType
 */
export interface ICharacterPosition {
  x?: number; // Percentage (0-100)
  y?: number; // Percentage (0-100)
  scale?: number; // Scale factor (e.g., 0.25 = 25%)
  anchor: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";
}

/**
 * Dialogue line in generated script
 */
export interface IDialogueLine {
  character: Types.ObjectId;
  text: string;
  startTime: number;
  duration: number;
  delay: number; // Pause before this line starts (in seconds)
  speechUrl?: string; // S3 URL of generated speech (for regeneration)
}

/**
 * Composition document interface
 */
export interface IComposition extends Document {
  _id: Types.ObjectId;
  template: Types.ObjectId;
  title: string;
  plot: string;
  screenType: ScreenType;
  characterPositions: Map<string, ICharacterPosition>;
  generatedScript: IDialogueLine[];
  subtitlePosition?: "top" | "center" | "bottom";
  status:
    | "pending"
    | "generating_script"
    | "generating_audio"
    | "compositing"
    | "adding_subtitles"
    | "uploading"
    | "completed"
    | "failed";
  progress: number;
  outputUrl?: string;
  subtitlesUrl?: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================
// Schemas
// ============================================

const characterPositionSchema = new Schema<ICharacterPosition>(
  {
    x: { type: Number, required: false, min: 0, max: 100 },
    y: { type: Number, required: false, min: 0, max: 100 },
    scale: { type: Number, required: false, min: 0.01, max: 2 },
    anchor: {
      type: String,
      enum: ["top-left", "top-right", "bottom-left", "bottom-right", "center"],
      required: true,
    },
  },
  { _id: false }
);

const dialogueLineSchema = new Schema<IDialogueLine>(
  {
    character: {
      type: Schema.Types.ObjectId,
      ref: "Character",
      required: true,
    },
    text: {
      type: String,
      required: true,
    },
    startTime: {
      type: Number,
      required: true,
    },
    duration: {
      type: Number,
      required: true,
    },
    delay: {
      type: Number,
      required: true,
      default: 0.3,
    },
    speechUrl: {
      type: String,
    },
  },
  { _id: false }
);

const compositionSchema = new Schema<IComposition>(
  {
    template: {
      type: Schema.Types.ObjectId,
      ref: "Template",
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    plot: {
      type: String,
      required: true,
    },
    screenType: {
      type: String,
      enum: ["mobile", "desktop"],
      default: "mobile",
    },
    characterPositions: {
      type: Map,
      of: characterPositionSchema,
      default: new Map(),
    },
    generatedScript: [dialogueLineSchema],
    status: {
      type: String,
      enum: [
        "pending",
        "generating_script",
        "generating_audio",
        "compositing",
        "adding_subtitles",
        "uploading",
        "completed",
        "failed",
      ],
      default: "pending",
    },
    progress: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    subtitlePosition: {
      type: String,
      enum: ["top", "center", "bottom"],
      default: "bottom",
    },
    outputUrl: String,
    subtitlesUrl: String,
    error: String,
  },
  {
    timestamps: true,
  }
);

export const Composition = model<IComposition>(
  "Composition",
  compositionSchema
);
