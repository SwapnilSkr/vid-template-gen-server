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

  // Subtitle colors for karaoke highlighting
  subtitleColors: {
    primary: process.env.SUBTITLE_PRIMARY_COLOR || "#FFFFFF",
    secondary: process.env.SUBTITLE_SECONDARY_COLOR || "#00FF00",
  },

  // Subtitle chunk speed multiplier (lower = faster chunks)
  // 1.0 = normal, 0.75 = 1.33x faster, 0.5 = 2x faster, 0.33 = 3x faster
  chunkSpeedMultiplier: parseFloat(
    process.env.CHUNK_SPEED_MULTIPLIER || "0.75"
  ),
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
