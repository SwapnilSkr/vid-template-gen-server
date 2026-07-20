import { Schema, model, type Document, type Types } from "mongoose";

/**
 * Platforms for which we can collect first-party metrics. This deliberately
 * excludes competitor/research sources: these documents only ever represent
 * analytics for accounts that the user has connected to this application.
 */
export type OwnedAnalyticsPlatform = "youtube" | "instagram" | "facebook" | "threads";

export type OwnedAnalyticsFetchSource = "api" | "manual_import" | "backfill";

export type PerformanceEvidenceConfidence = "low" | "medium" | "high";

export interface IOwnedMetricSnapshotReel {
  id: Types.ObjectId;
  niche?: string;
  genre?: string;
  /** Captured so a later edit to the Reel cannot rewrite historical context. */
  partNumber?: number;
  seriesKey?: string;
}

export interface IOwnedMetricSnapshotAccount {
  /** Connected-channel key, e.g. YouTubeChannel.channelKey. */
  key: string;
  label?: string;
  /** Native platform account/Page/profile id, when the provider supplied one. */
  platformAccountId?: string;
}

export interface IOwnedMetricSnapshotMedia {
  /** Provider media/post id. A Threads text post and an Instagram Reel are both media. */
  id: string;
  containerId?: string;
  type?: "short" | "reel" | "video" | "post" | "text" | "unknown";
  url?: string;
}

export interface IOwnedMetricSnapshotPublish {
  status?: "pending" | "uploading" | "published" | "failed" | "unknown";
  publishedAt?: Date;
  /** The provider's original publish time, if it differs from our job time. */
  providerPublishedAt?: Date;
}

export interface IOwnedMetricSnapshotFetch {
  /** The immutable observation time. Never use updatedAt as a metric time. */
  fetchedAt: Date;
  source: OwnedAnalyticsFetchSource;
  providerApiVersion?: string;
  collectorVersion?: string;
  requestId?: string;
}

/**
 * Normalised first-party counters. A provider may omit any counter; omission
 * is intentional and is described by `available`, rather than treated as 0.
 * `provider` preserves additional response fields without making every API
 * difference part of the product schema.
 */
export interface IOwnedMetricSnapshotRaw {
  views?: number;
  impressions?: number;
  reach?: number;
  plays?: number;
  engagedViews?: number;
  watchTimeSeconds?: number;
  averageViewDurationSeconds?: number;
  averageViewPercentage?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  reposts?: number;
  quotes?: number;
  profileVisits?: number;
  follows?: number;
  subscribersGained?: number;
  provider?: Record<string, unknown>;
}

export interface IOwnedMetricSnapshotAvailable {
  /** Fields successfully returned by the provider for this exact observation. */
  metrics: string[];
  /** Insight dimensions (for example non-follower reach) available at fetch time. */
  insights: string[];
  /** Explicit gaps prevent aggregation from silently treating unavailable data as zero. */
  missing: string[];
  limitations: string[];
}

/**
 * Compact creative and derived context attached to an observation. It lets
 * aggregation compare like with like without rehydrating a mutable Reel.
 */
export interface IOwnedMetricSnapshotFeatures {
  hookType?: string;
  narrativeFormat?: "standalone" | "series" | "update" | "unknown";
  durationSeconds?: number;
  title?: string;
  titleLength?: number;
  captionLength?: number;
  keywordPhrases: string[];
  hashtags: string[];
  firstCommentKind?: "discussion" | "series_navigation" | "story_request" | "none" | "unknown";
  /** Controlled experiment and derived-rate values. Must remain small; raw API data belongs in `raw`. */
  attributes?: Record<string, unknown>;
}

/** Immutable first-party analytics observation for one published destination. */
export interface IOwnedMetricSnapshot extends Document {
  _id: Types.ObjectId;
  reel: IOwnedMetricSnapshotReel;
  platform: OwnedAnalyticsPlatform;
  account: IOwnedMetricSnapshotAccount;
  media: IOwnedMetricSnapshotMedia;
  publish: IOwnedMetricSnapshotPublish;
  fetch: IOwnedMetricSnapshotFetch;
  raw: IOwnedMetricSnapshotRaw;
  available: IOwnedMetricSnapshotAvailable;
  features: IOwnedMetricSnapshotFeatures;
  createdAt: Date;
}

const ownedMetricSnapshotSchema = new Schema<IOwnedMetricSnapshot>(
  {
    reel: {
      id: { type: Schema.Types.ObjectId, ref: "Reel", required: true },
      niche: { type: String, trim: true },
      genre: { type: String, trim: true },
      partNumber: { type: Number, min: 1 },
      seriesKey: { type: String, trim: true },
    },
    platform: {
      type: String,
      enum: ["youtube", "instagram", "facebook", "threads"],
      required: true,
    },
    account: {
      key: { type: String, required: true, trim: true },
      label: { type: String, trim: true },
      platformAccountId: { type: String, trim: true },
    },
    media: {
      id: { type: String, required: true, trim: true },
      containerId: { type: String, trim: true },
      type: { type: String, enum: ["short", "reel", "video", "post", "text", "unknown"] },
      url: { type: String, trim: true },
    },
    publish: {
      status: { type: String, enum: ["pending", "uploading", "published", "failed", "unknown"] },
      publishedAt: Date,
      providerPublishedAt: Date,
    },
    fetch: {
      fetchedAt: { type: Date, required: true },
      source: { type: String, enum: ["api", "manual_import", "backfill"], required: true },
      providerApiVersion: { type: String, trim: true },
      collectorVersion: { type: String, trim: true },
      requestId: { type: String, trim: true },
    },
    raw: {
      views: { type: Number, min: 0 },
      impressions: { type: Number, min: 0 },
      reach: { type: Number, min: 0 },
      plays: { type: Number, min: 0 },
      engagedViews: { type: Number, min: 0 },
      watchTimeSeconds: { type: Number, min: 0 },
      averageViewDurationSeconds: { type: Number, min: 0 },
      averageViewPercentage: { type: Number, min: 0, max: 100 },
      likes: { type: Number, min: 0 },
      comments: { type: Number, min: 0 },
      shares: { type: Number, min: 0 },
      saves: { type: Number, min: 0 },
      reposts: { type: Number, min: 0 },
      quotes: { type: Number, min: 0 },
      profileVisits: { type: Number, min: 0 },
      follows: { type: Number, min: 0 },
      subscribersGained: { type: Number, min: 0 },
      provider: { type: Schema.Types.Mixed },
    },
    available: {
      metrics: { type: [String], default: [] },
      insights: { type: [String], default: [] },
      missing: { type: [String], default: [] },
      limitations: { type: [String], default: [] },
    },
    features: {
      hookType: { type: String, trim: true },
      narrativeFormat: { type: String, enum: ["standalone", "series", "update", "unknown"] },
      durationSeconds: { type: Number, min: 0 },
      title: { type: String, trim: true },
      titleLength: { type: Number, min: 0 },
      captionLength: { type: Number, min: 0 },
      keywordPhrases: { type: [String], default: [] },
      hashtags: { type: [String], default: [] },
      firstCommentKind: {
        type: String,
        enum: ["discussion", "series_navigation", "story_request", "none", "unknown"],
      },
      attributes: { type: Schema.Types.Mixed },
    },
    createdAt: { type: Date, default: () => new Date(), immutable: true },
  },
  { versionKey: false }
);

// A snapshot is append-only. Services should create a fresh row for every
// fetch; mutation would make velocity and historical comparisons unreliable.
ownedMetricSnapshotSchema.pre("save", function preventSavedSnapshotMutation() {
  if (!this.isNew) {
    throw new Error("OwnedMetricSnapshot is immutable; create a new snapshot instead.");
  }
});

function preventSnapshotQueryMutation() {
  throw new Error("OwnedMetricSnapshot is immutable; create a new snapshot instead.");
}

ownedMetricSnapshotSchema.pre("updateOne", preventSnapshotQueryMutation);
ownedMetricSnapshotSchema.pre("updateMany", preventSnapshotQueryMutation);
ownedMetricSnapshotSchema.pre("findOneAndUpdate", preventSnapshotQueryMutation);
ownedMetricSnapshotSchema.pre("replaceOne", preventSnapshotQueryMutation);
ownedMetricSnapshotSchema.pre("findOneAndReplace", preventSnapshotQueryMutation);

ownedMetricSnapshotSchema.index({ platform: 1, "account.key": 1, "fetch.fetchedAt": -1 });
ownedMetricSnapshotSchema.index({ "reel.id": 1, platform: 1, "account.key": 1, "fetch.fetchedAt": -1 });
ownedMetricSnapshotSchema.index({ platform: 1, "account.key": 1, "media.id": 1, "fetch.fetchedAt": -1 });
ownedMetricSnapshotSchema.index({ platform: 1, "reel.genre": 1, "fetch.fetchedAt": -1 });
ownedMetricSnapshotSchema.index({ "publish.publishedAt": -1, platform: 1 });

export const OwnedMetricSnapshot = model<IOwnedMetricSnapshot>(
  "OwnedMetricSnapshot",
  ownedMetricSnapshotSchema
);

export interface IPerformanceEvidenceCardAccount {
  /** `all` pools the user's comparable owned accounts on this platform. */
  scope: "all" | "account";
  key?: string;
  label?: string;
}

export interface IPerformanceEvidenceCardWindow {
  /** Stable aggregation bucket, e.g. `last_90d`. */
  key: string;
  startsAt: Date;
  endsAt: Date;
  days: number;
}

export interface IPerformanceEvidenceCardGuidance {
  /** Short, prompt-ready plain-language conclusion. */
  summary: string;
  hookPatterns: string[];
  titlePatterns: string[];
  keywordPhrases: string[];
  interactionPatterns: string[];
  cautions: string[];
}

export interface IPerformanceEvidenceCardConfidence {
  level: PerformanceEvidenceConfidence;
  score: number;
  sampleSize: number;
  reelCount: number;
  snapshotCount: number;
  reasons: string[];
}

/**
 * A small, retrieval-ready aggregation of owned analytics. The LLM receives
 * cards, never thousands of raw snapshot rows. `account.scope = all` is the
 * explicitly keyed all-accounts variant, not an ambiguous missing account.
 */
export interface IPerformanceEvidenceCard extends Document {
  _id: Types.ObjectId;
  platform: OwnedAnalyticsPlatform;
  account: IPerformanceEvidenceCardAccount;
  genre: string;
  window: IPerformanceEvidenceCardWindow;
  guidance: IPerformanceEvidenceCardGuidance;
  confidence: IPerformanceEvidenceCardConfidence;
  source: {
    aggregatorVersion?: string;
    inputFingerprint?: string;
    generatedAt: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

const performanceEvidenceCardSchema = new Schema<IPerformanceEvidenceCard>(
  {
    platform: {
      type: String,
      enum: ["youtube", "instagram", "facebook", "threads"],
      required: true,
    },
    account: {
      scope: { type: String, enum: ["all", "account"], required: true },
      key: { type: String, trim: true },
      label: { type: String, trim: true },
    },
    genre: { type: String, required: true, trim: true },
    window: {
      key: { type: String, required: true, trim: true },
      startsAt: { type: Date, required: true },
      endsAt: { type: Date, required: true },
      days: { type: Number, required: true, min: 1 },
    },
    guidance: {
      summary: { type: String, required: true, trim: true },
      hookPatterns: { type: [String], default: [] },
      titlePatterns: { type: [String], default: [] },
      keywordPhrases: { type: [String], default: [] },
      interactionPatterns: { type: [String], default: [] },
      cautions: { type: [String], default: [] },
    },
    confidence: {
      level: { type: String, enum: ["low", "medium", "high"], required: true },
      score: { type: Number, required: true, min: 0, max: 1 },
      sampleSize: { type: Number, required: true, min: 0 },
      reelCount: { type: Number, required: true, min: 0 },
      snapshotCount: { type: Number, required: true, min: 0 },
      reasons: { type: [String], default: [] },
    },
    source: {
      aggregatorVersion: { type: String, trim: true },
      inputFingerprint: { type: String, trim: true },
      generatedAt: { type: Date, required: true },
    },
  },
  { timestamps: true }
);

/** A pooled card must not quietly carry an account key, and a per-account card needs one. */
performanceEvidenceCardSchema.pre("validate", function validateEvidenceCardAccount() {
  if (this.account.scope === "account" && !this.account.key) {
    throw new Error("PerformanceEvidenceCard account.key is required when account.scope is 'account'.");
  }
  if (this.account.scope === "all" && this.account.key) {
    throw new Error("PerformanceEvidenceCard account.key must be omitted when account.scope is 'all'.");
  }
});

// Exact retrieval key used by the copy/planning layer.
performanceEvidenceCardSchema.index(
  { platform: 1, "account.scope": 1, "account.key": 1, genre: 1, "window.key": 1 },
  { unique: true }
);
performanceEvidenceCardSchema.index({ platform: 1, genre: 1, "window.endsAt": -1, "confidence.score": -1 });
performanceEvidenceCardSchema.index({ "source.generatedAt": -1 });

export const PerformanceEvidenceCard = model<IPerformanceEvidenceCard>(
  "PerformanceEvidenceCard",
  performanceEvidenceCardSchema
);
