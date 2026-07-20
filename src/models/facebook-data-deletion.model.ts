import { Schema, model, type Document } from "mongoose";

/** Short-lived, non-sensitive receipt for Meta's Facebook data-deletion
 * callback. The confirmation URL must remain available after the local OAuth
 * credentials and Page metadata have been deleted. */
export interface IFacebookDataDeletionRequest extends Document {
  confirmationCode: string;
  facebookUserId: string;
  deletedPageCount: number;
  completedAt: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const facebookDataDeletionRequestSchema = new Schema<IFacebookDataDeletionRequest>(
  {
    confirmationCode: { type: String, required: true, unique: true, index: true },
    facebookUserId: { type: String, required: true, index: true },
    deletedPageCount: { type: Number, required: true },
    completedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true },
);

export const FacebookDataDeletionRequest = model<IFacebookDataDeletionRequest>(
  "FacebookDataDeletionRequest",
  facebookDataDeletionRequestSchema,
);
