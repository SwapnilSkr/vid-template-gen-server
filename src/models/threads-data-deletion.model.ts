import { Schema, model, type Document } from "mongoose";

/** A short-lived receipt for Meta's signed data-deletion callback. It stores
 * no token or profile content; the user id is retained only so the request can
 * be audited until the confirmation URL expires. */
export interface IThreadsDataDeletionRequest extends Document {
  confirmationCode: string;
  threadsUserId: string;
  deletedChannelCount: number;
  completedAt: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const threadsDataDeletionRequestSchema = new Schema<IThreadsDataDeletionRequest>(
  {
    confirmationCode: { type: String, required: true, unique: true, index: true },
    threadsUserId: { type: String, required: true, index: true },
    deletedChannelCount: { type: Number, required: true },
    completedAt: { type: Date, required: true },
    // The public confirmation URL only needs to exist long enough for Meta and
    // the account owner to verify the request was processed.
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true },
);

export const ThreadsDataDeletionRequest = model<IThreadsDataDeletionRequest>(
  "ThreadsDataDeletionRequest",
  threadsDataDeletionRequestSchema,
);
