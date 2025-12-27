// Environment configuration
export const config = {
  // Server
  port: parseInt(process.env.PORT || "3000"),
  host: process.env.HOST || "localhost",
  nodeEnv: process.env.NODE_ENV || "development",

  // MongoDB
  mongodbUri:
    process.env.MONGODB_URI || "mongodb://localhost:27017/video-generator",

  // AWS S3
  awsRegion: process.env.AWS_REGION || "us-east-1",
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  s3Bucket: process.env.S3_BUCKET || "",

  // OpenRouter (AI SDK)
  openRouterApiKey: process.env.OPENROUTER_API_KEY || "",
  openRouterModel: process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini",

  // ElevenLabs
  elevenLabsApiKey: process.env.ELEVEN_LABS_API_KEY || "",

  // Storage paths (for local processing)
  storagePath: process.env.STORAGE_PATH || "./storage",
  processingPath: process.env.PROCESSING_PATH || "./storage/processing",

  // FFmpeg
  ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
  ffprobePath: process.env.FFPROBE_PATH || "ffprobe",

  // Limits
  maxFileSizeMB: parseInt(process.env.MAX_FILE_SIZE_MB || "2048"),
  maxVideoDurationSeconds: parseInt(process.env.MAX_VIDEO_DURATION || "300"),
};

// Validate required config
export function validateConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.mongodbUri) {
    errors.push("MONGODB_URI is required");
  }
  if (!config.elevenLabsApiKey) {
    errors.push("ELEVEN_LABS_API_KEY is required for voice generation");
  }
  if (!config.openRouterApiKey) {
    errors.push("OPENROUTER_API_KEY is required for AI script generation");
  }
  if (!config.s3Bucket) {
    errors.push("S3_BUCKET is required for file storage");
  }

  if (errors.length > 0) {
    console.warn("⚠️  Configuration warnings:");
    errors.forEach((e) => console.warn(`   - ${e}`));
  }

  return { valid: errors.length === 0, errors };
}
