import { Schema, model, type Document, type Types } from "mongoose";

export interface IDialogueLine {
  character: Types.ObjectId;
  text: string;
  startTime: number;
  duration: number;
}

export interface IComposition extends Document {
  _id: Types.ObjectId;
  template: Types.ObjectId;
  title: string;
  plot: string;
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
