import { Schema, model, type Document } from "mongoose";

/**
 * A connected Facebook Page the user administers, used to publish Facebook
 * Reels. Mirrors InstagramChannel: a long-lived (Page) access token is stored
 * encrypted, refreshed opportunistically before publish. Facebook Reels
 * publishing works under Meta Standard Access for Pages the user owns — no App
 * Review — once the Page is added to the Meta app.
 */
export interface IFacebookPage extends Document {
  channelKey: string;
  label: string;
  /** Facebook Page id (the /{page-id}/video_reels target). */
  pageId: string;
  name?: string;
  /** Facebook User id that administers this Page (from the connecting user). */
  userId?: string;
  category?: string;
  pictureUrl?: string;
  /** Encrypted long-lived Page access token. */
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

const facebookPageSchema = new Schema<IFacebookPage>(
  {
    channelKey: { type: String, required: true, unique: true, index: true },
    label: { type: String, required: true, trim: true },
    pageId: { type: String, required: true, unique: true, index: true },
    name: String,
    userId: String,
    category: String,
    pictureUrl: String,
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

export const FacebookPage = model<IFacebookPage>("FacebookPage", facebookPageSchema);
