import { Schema, model, type Document, type Types } from "mongoose";

export type YtImportStatus =
  | "pending"
  | "downloading"
  | "uploading"
  | "extracting_frames"
  | "completed"
  | "failed";

export type YtImportStorage = "local" | "s3";

export interface IYtImportCaptionCue {
  startSec: number;
  endSec: number;
  text: string;
}

export interface IYtImportFrameMeta {
  index: number;
  timestampSec: number;
  /** API-relative path or CDN URL */
  url: string;
}

export interface IYtImport extends Document {
  _id: Types.ObjectId;
  /** Clean folder prefix, e.g. dQw4w9WgXcQ_never-gonna-give-you-up */
  assetId: string;
  youtubeVideoId: string;
  sourceUrl: string;
  title: string;
  channelTitle: string;
  thumbnailUrl?: string;
  durationSec?: number;

  storage: YtImportStorage;
  downloadCaptions: boolean;
  extractFrames: boolean;
  /** Inclusive range for frame extraction (seconds). end unset = video end. */
  frameRangeStartSec?: number;
  frameRangeEndSec?: number;

  status: YtImportStatus;
  progress: number;
  error?: string;

  /** Public delivery URL (S3/CDN) or null when stored locally */
  videoUrl?: string;
  audioUrl?: string;
  captionsUrl?: string;

  /** Absolute local directory when storage=local */
  localDir?: string;
  /** S3 key prefix when storage=s3, e.g. yt-imports/dQw4w9WgXcQ_slug/ */
  s3Prefix?: string;

  captions?: IYtImportCaptionCue[];
  frameCount: number;
  fps?: number;
  framesExtracted: boolean;

  createdAt: Date;
  updatedAt: Date;
}

const captionCueSchema = new Schema<IYtImportCaptionCue>(
  {
    startSec: { type: Number, required: true },
    endSec: { type: Number, required: true },
    text: { type: String, required: true },
  },
  { _id: false }
);

const ytImportSchema = new Schema<IYtImport>(
  {
    assetId: { type: String, required: true, unique: true, trim: true, index: true },
    youtubeVideoId: { type: String, required: true, trim: true, index: true },
    sourceUrl: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    channelTitle: { type: String, required: true, trim: true },
    thumbnailUrl: { type: String, trim: true },
    durationSec: { type: Number, min: 0 },

    storage: { type: String, enum: ["local", "s3"], required: true },
    downloadCaptions: { type: Boolean, default: true },
    extractFrames: { type: Boolean, default: false },
    frameRangeStartSec: { type: Number, min: 0 },
    frameRangeEndSec: { type: Number, min: 0 },

    status: {
      type: String,
      enum: ["pending", "downloading", "uploading", "extracting_frames", "completed", "failed"],
      default: "pending",
      index: true,
    },
    progress: { type: Number, default: 0, min: 0, max: 100 },
    error: { type: String },

    videoUrl: { type: String, trim: true },
    audioUrl: { type: String, trim: true },
    captionsUrl: { type: String, trim: true },

    localDir: { type: String, trim: true },
    s3Prefix: { type: String, trim: true },

    captions: [captionCueSchema],
    frameCount: { type: Number, default: 0, min: 0 },
    fps: { type: Number, min: 0 },
    framesExtracted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const YtImport = model<IYtImport>("YtImport", ytImportSchema);
