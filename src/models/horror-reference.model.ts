import { Schema, model, type Document, type Types } from "mongoose";

export type HorrorReferenceSource = "project_gutenberg";
export type HorrorReferenceLicense = "public_domain" | "unknown";
export type HorrorReferenceStatus = "candidate" | "approved" | "rejected" | "archived";

export interface IHorrorReference extends Document {
  _id: Types.ObjectId;
  source: HorrorReferenceSource;
  sourceUrl: string;
  externalId: string;
  title: string;
  author?: string;
  language?: string;
  license: HorrorReferenceLicense;
  status: HorrorReferenceStatus;
  subjects: string[];
  genreTags: string[];
  downloads?: number;
  textUrl?: string;
  excerpt: string;
  promptBrief: string;
  qualityScore: number;
  usedInReelIds: Types.ObjectId[];
  lastScrapedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const horrorReferenceSchema = new Schema<IHorrorReference>(
  {
    source: {
      type: String,
      enum: ["project_gutenberg"],
      required: true,
      index: true,
    },
    sourceUrl: { type: String, required: true, trim: true, unique: true },
    externalId: { type: String, required: true, trim: true, unique: true },
    title: { type: String, required: true, trim: true },
    author: { type: String, trim: true },
    language: { type: String, trim: true },
    license: {
      type: String,
      enum: ["public_domain", "unknown"],
      default: "unknown",
      index: true,
    },
    status: {
      type: String,
      enum: ["candidate", "approved", "rejected", "archived"],
      default: "candidate",
      index: true,
    },
    subjects: { type: [String], default: [] },
    genreTags: { type: [String], default: [] },
    downloads: { type: Number, min: 0 },
    textUrl: String,
    excerpt: { type: String, required: true },
    promptBrief: { type: String, required: true },
    qualityScore: { type: Number, default: 0, index: true },
    usedInReelIds: [{ type: Schema.Types.ObjectId, ref: "Reel" }],
    lastScrapedAt: { type: Date, default: () => new Date(), index: true },
  },
  { timestamps: true }
);

horrorReferenceSchema.index({ status: 1, license: 1, qualityScore: -1 });
horrorReferenceSchema.index({ genreTags: 1, qualityScore: -1 });

export const HorrorReference = model<IHorrorReference>(
  "HorrorReference",
  horrorReferenceSchema
);
