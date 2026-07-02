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
  digest: string; // short bullet list of winning title/hook/thumbnail patterns
  hooks: string[]; // reusable hook-line templates distilled from top performers (not verbatim titles)
  sampleSize: number; // how many references it was distilled from
  createdAt: Date;
  updatedAt: Date;
}

const trendInsightSchema = new Schema<ITrendInsight>(
  {
    niche: { type: String, required: true, trim: true, index: true },
    genre: { type: String, required: true, trim: true, index: true },
    digest: { type: String, required: true },
    hooks: { type: [String], default: [] },
    sampleSize: { type: Number, default: 0 },
  },
  { timestamps: true }
);

trendInsightSchema.index({ niche: 1, genre: 1 }, { unique: true });

export const TrendInsight = model<ITrendInsight>("TrendInsight", trendInsightSchema);
