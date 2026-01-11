import { Schema, model, type Document, type Types } from "mongoose";

export interface ICharacter extends Document {
  _id: Types.ObjectId;
  name: string;
  displayName: string;
  voiceId: string;
  imageUrl: string;
  createdAt: Date;
  updatedAt: Date;
}

const characterSchema = new Schema<ICharacter>(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    displayName: {
      type: String,
      required: true,
      trim: true,
    },
    voiceId: {
      type: String,
      required: true,
    },
    imageUrl: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

export const Character = model<ICharacter>("Character", characterSchema);
