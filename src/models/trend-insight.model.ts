import { Schema, model, type Document } from "mongoose";

// ============================================
// Cached per-genre "winning pattern" digest, distilled from TrendReference by
// trend-insight.service. Exists so script/thumbnail prompts read one short
// cached string instead of summarizing raw trend references on every reel
// generation — keeps the LLM context small and the cost near-zero.
// ============================================

export interface ITrendInsight extends Document {
  niche: string;
  genre: string;
  researchVersion?: string;
  digest: string; // short bullet list of winning title/hook/thumbnail patterns
  hooks: string[]; // reusable hook-line templates distilled from top performers (not verbatim titles)
  sampleSize: number; // how many references it was distilled from
  /** Explicit evidence boundary for the planner/UI. These are observed public
   * metadata patterns, not a claim about private competitor retention. */
  evidence?: {
    titlePatterns: string[];
    hookTypes: string[];
    keywordPhrases: string[];
    cautions: string[];
    confidence: "low" | "medium" | "high";
    generatedAt: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

const trendInsightSchema = new Schema<ITrendInsight>(
  {
    niche: { type: String, required: true, trim: true, index: true },
    genre: { type: String, required: true, trim: true, index: true },
    researchVersion: { type: String, trim: true, index: true },
    digest: { type: String, required: true },
    hooks: { type: [String], default: [] },
    sampleSize: { type: Number, default: 0 },
    evidence: {
      titlePatterns: { type: [String], default: [] },
      hookTypes: { type: [String], default: [] },
      keywordPhrases: { type: [String], default: [] },
      cautions: { type: [String], default: [] },
      confidence: { type: String, enum: ["low", "medium", "high"], default: "low" },
      generatedAt: Date,
    },
  },
  { timestamps: true }
);

trendInsightSchema.index({ niche: 1, genre: 1, researchVersion: 1 }, { unique: true });

export const TrendInsight = model<ITrendInsight>("TrendInsight", trendInsightSchema);
