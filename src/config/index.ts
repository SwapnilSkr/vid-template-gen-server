import { resolve } from "node:path";

/** Resolve storage-ish paths to absolute so Windows services / PM2 / monorepo
 *  launches with a different cwd still find the same directories. */
function absPath(envValue: string | undefined, fallback: string): string {
  return resolve(envValue?.trim() || fallback);
}

// Environment configuration
export const config = {
  // Server
  port: parseInt(process.env.PORT || "3000"),
  host: process.env.HOST || "localhost",
  nodeEnv: process.env.NODE_ENV || "development",

  // MongoDB
  mongodbUri:
    process.env.MONGODB_URI || "mongodb://localhost:27017/video-generator",

  // Redis (BullMQ job queue — reel + composition pipelines run as staged,
  // crash-resumable background jobs instead of fire-and-forget)
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  queueConcurrency: parseInt(process.env.QUEUE_CONCURRENCY || "2"),

  // AWS S3
  awsRegion: process.env.AWS_REGION || "us-east-1",
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  s3Bucket: process.env.S3_BUCKET || "",

  // OpenRouter (AI SDK)
  openRouterApiKey: process.env.OPENROUTER_API_KEY || "",
  openRouterModel: process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini",
  openRouterBaseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",

  // OpenRouter media models (single-provider stack: images + TTS)
  // Images: Gemini "Nano Banana" workhorse. TTS: Kokoro (cheap bulk narration).
  imageModel: process.env.IMAGE_MODEL || "google/gemini-2.5-flash-image",
  ttsModel: process.env.TTS_MODEL || "hexgrad/kokoro-82m",
  ttsVoice: process.env.TTS_VOICE || "am_michael",

  // ElevenLabs
  elevenLabsApiKey: process.env.ELEVEN_LABS_API_KEY || "",

  // Storage paths (for local processing) — absolute so cwd doesn't matter
  storagePath: absPath(process.env.STORAGE_PATH, "./storage"),
  processingPath: absPath(process.env.PROCESSING_PATH, "./storage/processing"),

  // FFmpeg
  ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
  ffprobePath: process.env.FFPROBE_PATH || "ffprobe",
  // libx264 speed/quality tradeoff for final passes (caption burn, mix, FX).
  // Scene clips already use veryfast. Docker/CPU-bound hosts: veryfast|ultrafast.
  ffmpegPreset: process.env.FFMPEG_PRESET || "veryfast",

  // Gameplay background clips (Reddit/AITA format) — user-supplied .mp4 loops
  gameplayDir: absPath(process.env.GAMEPLAY_DIR, "./storage/gameplay"),

  // CloudFront CDN in front of the public S3 bucket (empty = fall back to S3 URL)
  cdnUrl: (process.env.CLOUDFRONT_URL || "").replace(/\/$/, ""),

  // Reddit app (for hybrid/verbatim story sourcing). Create at
  // https://www.reddit.com/prefs/apps (type "script" or "web app"). Read-only
  // app-only OAuth is enough. Leave empty to use LLM-only story sourcing.
  // Default story sourcing mode for auto reels: llm | hybrid | verbatim
  storyMode: process.env.STORY_MODE || "llm",

  // Scheduled story bank top-up (keeps the Reddit reel pipeline fed).
  // Runs in-process; checks the bank every `storyTopUpIntervalMs` and, if
  // fewer than `storyTopUpThreshold` unused stories remain, generates
  // `storyTopUpCount` more in `storyTopUpMode`. Set STORY_TOPUP_ENABLED=false
  // to disable (e.g. if running multiple server instances — only one should
  // top up, or trigger scripts/topup-stories.ts via external cron instead).
  storyTopUpEnabled: process.env.STORY_TOPUP_ENABLED !== "false",
  storyTopUpIntervalMs: parseInt(process.env.STORY_TOPUP_INTERVAL_MS || String(30 * 60 * 1000)), // 30 min
  storyTopUpThreshold: parseInt(process.env.STORY_TOPUP_THRESHOLD || "10"),
  storyTopUpCount: parseInt(process.env.STORY_TOPUP_COUNT || "15"),
  storyTopUpMode: process.env.STORY_TOPUP_MODE || process.env.STORY_MODE || "llm",

  // YouTube auto-posting (YouTube Data API v3, OAuth2 "Desktop app" client).
  // Get YOUTUBE_CLIENT_ID/SECRET from Google Cloud Console, then run
  // `bun scripts/youtube-authorize.ts` once to mint YOUTUBE_REFRESH_TOKEN.
  youtubeClientId: process.env.YOUTUBE_CLIENT_ID || "",
  youtubeClientSecret: process.env.YOUTUBE_CLIENT_SECRET || "",
  youtubeRefreshToken: process.env.YOUTUBE_REFRESH_TOKEN || "",
  youtubeChannelsJson: process.env.YOUTUBE_CHANNELS_JSON || "",
  youtubeTokenEncryptionKey: process.env.YOUTUBE_TOKEN_ENCRYPTION_KEY || "",
  youtubeConnectClientId:
    process.env.YOUTUBE_CONNECT_CLIENT_ID || process.env.YOUTUBE_CLIENT_ID || "",
  youtubeConnectClientSecret:
    process.env.YOUTUBE_CONNECT_CLIENT_SECRET || process.env.YOUTUBE_CLIENT_SECRET || "",
  youtubeRedirectUri:
    process.env.YOUTUBE_REDIRECT_URI || "http://localhost:53682/oauth2callback",
  youtubeConnectRedirectUri:
    process.env.YOUTUBE_CONNECT_REDIRECT_URI ||
    process.env.YOUTUBE_REDIRECT_URI ||
    "http://localhost:3000/api/youtube/connect/callback",
  // 22 = "People & Blogs" (safe default for faceless niche content)
  youtubeCategoryId: process.env.YOUTUBE_CATEGORY_ID || "22",
  youtubePrivacyStatus: (process.env.YOUTUBE_PRIVACY_STATUS || "private") as
    | "private"
    | "unlisted"
    | "public",
  // Auto-enqueue a YouTube publish job as soon as a reel finishes rendering.
  // Defaults off so videos can be reviewed before they go out.
  autoPublishYoutube: process.env.AUTO_PUBLISH_YOUTUBE === "true",

  // Instagram API with Instagram Login. In development mode, the connected
  // professional accounts must belong to people added to the Meta app roles.
  instagramAppId: process.env.INSTAGRAM_APP_ID || "",
  instagramAppSecret: process.env.INSTAGRAM_APP_SECRET || "",
  instagramRedirectUri:
    process.env.INSTAGRAM_REDIRECT_URI || "http://localhost:3000/api/instagram/connect/callback",
  instagramApiVersion: process.env.INSTAGRAM_API_VERSION || "v25.0",
  // Meta fetches and transcodes the public MP4 asynchronously.  Short Reels
  // often finish quickly, but busy periods and slower S3 fetches can take
  // several minutes. Keep this below the publishing worker's one-hour lock.
  instagramProcessingTimeoutMs: parseInt(
    process.env.INSTAGRAM_PROCESSING_TIMEOUT_MS || String(10 * 60 * 1000)
  ),

  // YouTube Data API v3 *read* access (search/videos.list) for the trend
  // scout — a plain API key from Google Cloud Console, separate from the
  // OAuth publish credentials above (those write to OUR channel; this only
  // reads public data). 10,000 units/day free; search.list = 100u, videos.list = 1u.
  youtubeDataApiKey: process.env.YOUTUBE_DATA_API_KEY || "",
  trendScoutEnabled: process.env.TREND_SCOUT_ENABLED !== "false",

  redditClientId: process.env.REDDIT_CLIENT_ID || "",
  redditClientSecret: process.env.REDDIT_CLIENT_SECRET || "",
  // NB: Reddit's WAF blocked the "recommended" descriptive UA at some IPs;
  // a browser UA gets through reliably. Override via REDDIT_USER_AGENT if needed.
  redditUserAgent:
    process.env.REDDIT_USER_AGENT ||
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",

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

  // Reddit/gameplay narration pacing. Captions follow the processed audio, so
  // these are the controls that actually affect Reddit reel feel.
  redditNarrationTempo: parseFloat(process.env.REDDIT_NARRATION_TEMPO || "1.12"),
  redditSentenceGapSeconds: parseFloat(process.env.REDDIT_SENTENCE_GAP_SECONDS || "0.12"),
  redditTitleGapSeconds: parseFloat(process.env.REDDIT_TITLE_GAP_SECONDS || "0.2"),
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
