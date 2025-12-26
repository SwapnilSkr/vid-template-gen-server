// Environment configuration
export const config = {
  // Server
  port: parseInt(process.env.PORT || "3000"),
  host: process.env.HOST || "localhost",

  // ElevenLabs
  elevenLabsApiKey: process.env.ELEVEN_LABS_API_KEY || "",

  // AI SDK
  googleApiKey: process.env.GOOGLE_API_KEY || "",

  // Storage paths
  storagePath: process.env.STORAGE_PATH || "./storage",
  templatesPath: process.env.TEMPLATES_PATH || "./storage/templates",
  charactersPath: process.env.CHARACTERS_PATH || "./storage/characters",
  processingPath: process.env.PROCESSING_PATH || "./storage/processing",
  outputPath: process.env.OUTPUT_PATH || "./storage/output",

  // FFmpeg
  ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
  ffprobePath: process.env.FFPROBE_PATH || "ffprobe",

  // Limits
  maxFileSizeMB: parseInt(process.env.MAX_FILE_SIZE_MB || "500"),
  maxVideoDurationSeconds: parseInt(process.env.MAX_VIDEO_DURATION || "300"),
};

// Validate required config
export function validateConfig(): void {
  if (!config.elevenLabsApiKey) {
    console.warn(
      "⚠️  ELEVEN_LABS_API_KEY not set - voice generation will fail"
    );
  }
}
