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

  // Operations log: Mongo-backed request, queue, worker, and fallback history.
  // A TTL index removes entries after this period; individual rows can be
  // deleted earlier in the Operations screen.
  operationLogRetentionDays: Math.max(1, parseInt(process.env.OPERATION_LOG_RETENTION_DAYS || "30")),
  // Mirror every durable server-side operation record to stdout. Set false in
  // a managed environment only when the process logger already captures Mongo
  // records through another integration.
  operationLogConsole: process.env.OPERATION_LOG_CONSOLE !== "false",

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
    process.env.INSTAGRAM_PROCESSING_TIMEOUT_MS || String(20 * 60 * 1000)
  ),

  // ============================================================
  // Distribution / virality engine (own-media only). All of the flags below
  // gate NEW behaviour off by default so nothing runs until the user finishes
  // the per-platform Meta/Google setup. Never build cross-account automation
  // here — only actions on the account's OWN posts are safe to automate.
  // ============================================================

  // Post a single pinned-style FIRST comment on our own post right after it
  // publishes (curiosity prompt + series link). Own-media only; off by default.
  instagramAutoFirstComment: process.env.INSTAGRAM_AUTO_FIRST_COMMENT === "true",
  youtubeAutoFirstComment: process.env.YOUTUBE_AUTO_FIRST_COMMENT === "true",
  facebookAutoFirstComment: process.env.FACEBOOK_AUTO_FIRST_COMMENT === "true",
  threadsAutoFirstReply: process.env.THREADS_AUTO_FIRST_REPLY === "true",

  // Conservative per-platform daily publish guards. New accounts are throttled
  // harder by the 2025–2026 recommendation algorithms, so these sit well under
  // the documented hard API caps (IG ~100/day, FB 30/day, Threads 250/day,
  // YouTube 100 uploads/day). Set to 0 to disable a guard.
  instagramDailyLimit: parseInt(process.env.INSTAGRAM_DAILY_LIMIT || "25"),
  youtubeDailyLimit: parseInt(process.env.YOUTUBE_DAILY_LIMIT || "100"),
  facebookDailyLimit: parseInt(process.env.FACEBOOK_DAILY_LIMIT || "30"),
  threadsDailyLimit: parseInt(process.env.THREADS_DAILY_LIMIT || "250"),

  // ---- Facebook Reels (Page publishing). Facebook Login for Business uses
  // the parent Meta App ID/secret of the app that owns its Configuration ID.
  // Do not fall back to Instagram Login credentials: Meta can issue separate
  // Instagram client IDs that Facebook's OAuth dialog rejects as an app ID.
  // Requires scopes: pages_show_list, pages_read_engagement, pages_manage_posts,
  // business_management (for Business Portfolio-owned Pages), plus
  // pages_manage_engagement for own-post first comments. ----
  facebookReelsEnabled: process.env.FACEBOOK_REELS_ENABLED === "true",
  facebookAppId: process.env.FACEBOOK_APP_ID || "",
  facebookAppSecret: process.env.FACEBOOK_APP_SECRET || "",
  // Facebook Login for Business creates a configuration under the app. Its
  // Configuration ID is required in the Business Login OAuth dialog; it is
  // distinct from the app's App ID and App Secret.
  facebookLoginConfigId: process.env.FACEBOOK_LOGIN_CONFIG_ID || "",
  facebookRedirectUri:
    process.env.FACEBOOK_REDIRECT_URI || "http://localhost:3000/api/facebook/connect/callback",
  facebookApiVersion: process.env.FACEBOOK_API_VERSION || "v21.0",
  facebookProcessingTimeoutMs: parseInt(
    process.env.FACEBOOK_PROCESSING_TIMEOUT_MS || String(10 * 60 * 1000)
  ),

  // ---- Threads. SEPARATE Meta "Threads" use-case app with its own OAuth and
  // its own Graph host (graph.threads.net). Scopes: threads_basic,
  // threads_content_publish, threads_manage_replies, threads_read_replies. ----
  threadsEnabled: process.env.THREADS_ENABLED === "true",
  threadsAppId: process.env.THREADS_APP_ID || "",
  threadsAppSecret: process.env.THREADS_APP_SECRET || "",
  threadsRedirectUri:
    process.env.THREADS_REDIRECT_URI || "http://localhost:3000/api/threads/connect/callback",
  threadsApiVersion: process.env.THREADS_API_VERSION || "v1.0",
  // Threads processes the pulled video async like IG; a short fixed wait before
  // publish is the documented pattern, then we poll the container status.
  threadsProcessingTimeoutMs: parseInt(
    process.env.THREADS_PROCESSING_TIMEOUT_MS || String(15 * 60 * 1000)
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

  // Followup/update discovery: a candidate the LLM adjudicator scores at or above
  // this confidence (0..1) is auto-included as a genuine continuation; below it we
  // fall back to deterministic signals (embedded link / title mirror / update cue).
  updateAiConfidence: parseFloat(process.env.UPDATE_AI_CONFIDENCE_THRESHOLD || "0.7"),

  // Limits
  maxFileSizeMB: parseInt(process.env.MAX_FILE_SIZE_MB || "2048"),
  maxVideoDurationSeconds: parseInt(process.env.MAX_VIDEO_DURATION || "300"),

  // Subtitle colors for karaoke highlighting
  subtitleColors: {
    primary: process.env.SUBTITLE_PRIMARY_COLOR || "#FFFFFF",
    secondary: process.env.SUBTITLE_SECONDARY_COLOR || "#00FF00",
  },

  // Karaoke caption chunk speed multiplier. DEPRECATED as a compression knob:
  // captions must never run faster than the real narration audio (Issue 1), so
  // any value below 1.0 is clamped to 1.0 in generateKaraokeAssContent. Kept
  // only for backward-compat of the env var; leave at 1.0.
  chunkSpeedMultiplier: parseFloat(
    process.env.CHUNK_SPEED_MULTIPLIER || "1"
  ),

  // Forced word alignment (provider-independent caption sync). This runs the
  // local whisper.cpp CLI over the FINAL paced Reddit narration, so it works
  // with OpenRouter or any future TTS provider. It is deliberately opt-in: run
  // `bun run whisper:install` locally, or use the Docker image which includes
  // the CLI + base.en model.
  whisperAlignmentEnabled: process.env.WHISPER_ALIGNMENT_ENABLED === "true",
  whisperCliPath: process.env.WHISPER_CLI_PATH || "whisper-cli",
  whisperModelPath: absPath(
    process.env.WHISPER_MODEL_PATH,
    "./storage/whisper/ggml-base.en.bin"
  ),

  // Reddit/gameplay narration pacing. Captions follow the processed audio, so
  // these are the controls that actually affect Reddit reel feel. Tuned for a
  // deliberate, clear "storytime" read rather than a rushed one:
  //  - redditTtsSpeed: provider `speed` param sent to TTS (1.0 = natural;
  //    <1 = slower/clearer). Applied only when the model supports `speed`.
  //  - redditNarrationTempo: post-hoc ffmpeg atempo on the rendered audio
  //    (kept modest so it doesn't sound chipmunky; 1.0 = untouched).
  //  - *GapSeconds: deliberate silence inserted BETWEEN segments so sentences
  //    breathe without the dead air TTS bakes into each clip.
  redditTtsSpeed: parseFloat(process.env.REDDIT_TTS_SPEED || "0.97"),
  redditNarrationTempo: parseFloat(process.env.REDDIT_NARRATION_TEMPO || "1.04"),
  redditSentenceGapSeconds: parseFloat(process.env.REDDIT_SENTENCE_GAP_SECONDS || "0.22"),
  redditTitleGapSeconds: parseFloat(process.env.REDDIT_TITLE_GAP_SECONDS || "0.35"),
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
