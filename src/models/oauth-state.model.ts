import { Schema, model, type Document } from "mongoose";

export interface IOAuthState extends Document {
  state: string;
  provider: "youtube" | "instagram";
  payload: {
    label: string;
    channelKey?: string;
    privacyStatus: "private" | "unlisted" | "public";
    categoryId: string;
    niches: string[];
  };
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const oauthStateSchema = new Schema<IOAuthState>(
  {
    state: { type: String, required: true, unique: true, index: true },
    provider: { type: String, enum: ["youtube", "instagram"], required: true },
    payload: {
      label: { type: String, required: true },
      channelKey: String,
      privacyStatus: {
        type: String,
        enum: ["private", "unlisted", "public"],
        default: "public",
      },
      categoryId: { type: String, default: "22" },
      niches: { type: [String], default: [] },
    },
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: true }
);

export const OAuthState = model<IOAuthState>("OAuthState", oauthStateSchema);
