import { Schema, model, type Document } from "mongoose";

/**
 * A connected Threads profile the user owns, used to cross-post the same 9:16
 * render as a Threads video with a strong text hook (+ an optional threaded
 * "Part N" reply). Threads uses a SEPARATE Meta app ("Threads" use case) with
 * its own OAuth and its own Graph host (graph.threads.net). Long-lived Threads
 * tokens (~60 days) are stored encrypted and refreshed before publish.
 */
export interface IThreadsChannel extends Document {
  channelKey: string;
  label: string;
  /** Threads user id (the /{threads-user}/threads target). */
  threadsUserId: string;
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

const threadsChannelSchema = new Schema<IThreadsChannel>(
  {
    channelKey: { type: String, required: true, unique: true, index: true },
    label: { type: String, required: true, trim: true },
    threadsUserId: { type: String, required: true, unique: true, index: true },
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

export const ThreadsChannel = model<IThreadsChannel>("ThreadsChannel", threadsChannelSchema);
