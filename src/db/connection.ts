import mongoose from "mongoose";
import { config } from "../config";

let isConnected = false;

export async function connectDatabase(): Promise<void> {
  if (isConnected) return;

  try {
    await mongoose.connect(config.mongodbUri);
    isConnected = true;
    console.log("🗄️  Connected to MongoDB");
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error);
    throw error;
  }
}

export async function disconnectDatabase(): Promise<void> {
  if (!isConnected) return;

  await mongoose.disconnect();
  isConnected = false;
  console.log("🗄️  Disconnected from MongoDB");
}

export { mongoose };
