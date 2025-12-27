import { Schema, model, type Document, type Types } from "mongoose";

export interface ITemplate extends Document {
  _id: Types.ObjectId;
  name: string;
  description: string;
  videoUrl: string;
  thumbnailUrl?: string;
  duration: number | null;
  dimensions: {
    width: number;
    height: number;
  };
  frameRate: number;
  characters: Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const templateSchema = new Schema<ITemplate>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
    },
    videoUrl: {
      type: String,
      required: true,
    },
    thumbnailUrl: {
      type: String,
    },
    duration: {
      type: Number,
      default: null,
    },
    dimensions: {
      width: { type: Number, required: true },
      height: { type: Number, required: true },
    },
    frameRate: {
      type: Number,
      default: 30,
    },
    characters: [
      {
        type: Schema.Types.ObjectId,
        ref: "Character",
      },
    ],
  },
  {
    timestamps: true,
  }
);

export const Template = model<ITemplate>("Template", templateSchema);
