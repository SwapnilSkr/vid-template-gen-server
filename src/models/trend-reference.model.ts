import { Schema, model, type Document, type Types } from "mongoose";

export type TrendPlatform =
  | "youtube_shorts"
  | "instagram_reels"
  | "tiktok"
  | "reddit"
  | "unknown";

export type TrendReferenceStatus =
  | "candidate"
  | "reviewed"
  | "approved"
  | "rejected"
  | "archived";

/** Which scout scan found/last refreshed this reference — lets the daily
 *  (rolling week) and weekly (rolling month) scans coexist without
 *  clobbering each other's records. */
export type TrendScanWindow = "last_48h" | "last_30d" | "weekly_scan" | "monthly_scan";

export interface ITrendMetrics {
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  durationSec?: number;
  postedAt?: Date;
  capturedAt?: Date;
}

/** Immutable public-metric observation. Repeated captures reveal public view
 * velocity without pretending we can see a competitor's private retention. */
export interface ITrendMetricCapture extends ITrendMetrics {
  capturedAt: Date;
}

export interface ITrendCreativeAnalysis {
  hookType?: "accusation" | "consequence" | "question" | "reversal" | "confession" | "reveal" | "other";
  titlePattern?: string;
  keywordPhrases?: string[];
  narrativeFormat?: "standalone" | "series" | "update" | "unknown";
  notes?: string;
  model?: string;
  analyzedAt?: Date;
}

export interface ITrendReference extends Document {
  _id: Types.ObjectId;
  niche: string;
  researchVersion?: string;
  genre?: string;
  /** A public Short may match several genre queries. `genre` is legacy/display
   * primary; it must not overwrite the complete match set. */
  genreIds: string[];
  sourceUrl: string;
  platform: TrendPlatform;
  metrics: ITrendMetrics;
  notes?: string;
  status: TrendReferenceStatus;

  /** platform video id (e.g. YouTube videoId) — dedup key for upserts */
  externalId?: string;
  title?: string;
  description?: string;
  /** their thumbnail — captured for internal design reference only, never republished */
  thumbnailUrl?: string;
  channelTitle?: string;
  tags?: string[];
  /** derived from metrics.postedAt (UTC) for the posting-time histogram */
  dayOfWeek?: number; // 0 (Sun) - 6 (Sat)
  hourUtc?: number; // 0-23
  scanWindow?: TrendScanWindow;
  metricHistory: ITrendMetricCapture[];
  analysis?: ITrendCreativeAnalysis;

  createdAt: Date;
  updatedAt: Date;
}

const trendMetricsSchema = new Schema<ITrendMetrics>(
  {
    views: { type: Number, min: 0 },
    likes: { type: Number, min: 0 },
    comments: { type: Number, min: 0 },
    shares: { type: Number, min: 0 },
    saves: { type: Number, min: 0 },
    durationSec: { type: Number, min: 0 },
    postedAt: Date,
    capturedAt: Date,
  },
  { _id: false }
);

const trendCreativeAnalysisSchema = new Schema<ITrendCreativeAnalysis>(
  {
    hookType: { type: String, enum: ["accusation", "consequence", "question", "reversal", "confession", "reveal", "other"] },
    titlePattern: String,
    keywordPhrases: { type: [String], default: [] },
    narrativeFormat: { type: String, enum: ["standalone", "series", "update", "unknown"] },
    notes: String,
    model: String,
    analyzedAt: Date,
  },
  { _id: false }
);

const trendReferenceSchema = new Schema<ITrendReference>(
  {
    niche: { type: String, required: true, trim: true, index: true },
    researchVersion: { type: String, trim: true, index: true },
    genre: { type: String, trim: true, index: true },
    genreIds: { type: [String], default: [], index: true },
    sourceUrl: { type: String, required: true, trim: true, unique: true },
    platform: {
      type: String,
      enum: ["youtube_shorts", "instagram_reels", "tiktok", "reddit", "unknown"],
      required: true,
      index: true,
    },
    metrics: { type: trendMetricsSchema, default: () => ({ capturedAt: new Date() }) },
    notes: { type: String, trim: true },
    status: {
      type: String,
      enum: ["candidate", "reviewed", "approved", "rejected", "archived"],
      default: "candidate",
      index: true,
    },
    externalId: { type: String, trim: true, index: true, sparse: true, unique: true },
    title: { type: String, trim: true },
    description: { type: String, trim: true },
    thumbnailUrl: String,
    channelTitle: { type: String, trim: true },
    tags: { type: [String], default: [] },
    dayOfWeek: { type: Number, min: 0, max: 6 },
    hourUtc: { type: Number, min: 0, max: 23 },
    scanWindow: {
      type: String,
      enum: ["last_48h", "last_30d", "weekly_scan", "monthly_scan"],
    },
    metricHistory: { type: [trendMetricsSchema], default: [] },
    analysis: trendCreativeAnalysisSchema,
  },
  { timestamps: true }
);

trendReferenceSchema.index({ niche: 1, genre: 1, platform: 1, status: 1 });
trendReferenceSchema.index({ niche: 1, genreIds: 1, platform: 1, status: 1 });
trendReferenceSchema.index({ "metrics.views": -1, "metrics.likes": -1 });
trendReferenceSchema.index({ niche: 1, genre: 1, dayOfWeek: 1, hourUtc: 1 });

export const TrendReference = model<ITrendReference>(
  "TrendReference",
  trendReferenceSchema
);
