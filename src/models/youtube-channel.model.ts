import { Schema, model, type Document } from "mongoose";

export interface IYouTubeChannel extends Document {
  channelKey: string;
  label: string;
  googleChannelId?: string;
  googleChannelTitle?: string;
  logoUrl?: string;
  encryptedRefreshToken: string;
  privacyStatus: "private" | "unlisted" | "public";
  categoryId: string;
  niches: string[];
  status: "active" | "needs_reauth" | "disabled";
  lastError?: string;
  lastConnectedAt?: Date;
  lastPublishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const youtubeChannelSchema = new Schema<IYouTubeChannel>(
  {
    channelKey: { type: String, required: true, unique: true, index: true },
    label: { type: String, required: true, trim: true },
    googleChannelId: { type: String, index: true },
    googleChannelTitle: String,
    logoUrl: String,
    encryptedRefreshToken: { type: String, required: true },
    privacyStatus: {
      type: String,
      enum: ["private", "unlisted", "public"],
      default: "public",
    },
    categoryId: { type: String, default: "22" },
    niches: { type: [String], default: [] },
    status: {
      type: String,
      enum: ["active", "needs_reauth", "disabled"],
      default: "active",
      index: true,
    },
    lastError: String,
    lastConnectedAt: Date,
    lastPublishedAt: Date,
  },
  { timestamps: true }
);

export const YouTubeChannel = model<IYouTubeChannel>(
  "YouTubeChannel",
  youtubeChannelSchema
);
