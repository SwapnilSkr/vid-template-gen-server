import { Schema, model, type Document, type Types } from "mongoose";

export interface ICharacter extends Document {
  _id: Types.ObjectId;
  name: string;
  displayName: string;
  voiceId: string;
  imageUrl: string;
  position: {
    x: number;
    y: number;
    scale: number;
    anchor:
      | "top-left"
      | "top-right"
      | "bottom-left"
      | "bottom-right"
      | "center";
  };
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
    position: {
      x: { type: Number, default: 5 },
      y: { type: Number, default: 95 },
      scale: { type: Number, default: 0.25 },
      anchor: {
        type: String,
        enum: [
          "top-left",
          "top-right",
          "bottom-left",
          "bottom-right",
          "center",
        ],
        default: "bottom-left",
      },
    },
  },
  {
    timestamps: true,
  }
);

export const Character = model<ICharacter>("Character", characterSchema);
