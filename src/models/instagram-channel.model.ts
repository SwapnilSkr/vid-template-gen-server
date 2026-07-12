import { Schema, model, type Document } from "mongoose";

export interface IInstagramChannel extends Document {
  channelKey: string;
  label: string;
  instagramUserId: string;
  username?: string;
  name?: string;
  profilePictureUrl?: string;
  encryptedAccessToken: string;
  tokenExpiresAt?: Date;
  niches: string[];
  status: "active" | "needs_reauth" | "disabled";
  lastError?: string;
  lastConnectedAt?: Date;
  lastPublishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const instagramChannelSchema = new Schema<IInstagramChannel>(
  {
    channelKey: { type: String, required: true, unique: true, index: true },
    label: { type: String, required: true, trim: true },
    instagramUserId: { type: String, required: true, unique: true, index: true },
    username: String,
    name: String,
    profilePictureUrl: String,
    encryptedAccessToken: { type: String, required: true },
    tokenExpiresAt: Date,
    niches: { type: [String], default: [] },
    status: { type: String, enum: ["active", "needs_reauth", "disabled"], default: "active", index: true },
    lastError: String,
    lastConnectedAt: Date,
    lastPublishedAt: Date,
  },
  { timestamps: true }
);

export const InstagramChannel = model<IInstagramChannel>("InstagramChannel", instagramChannelSchema);
