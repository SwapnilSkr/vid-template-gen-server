import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import "./config/ffmpeg-bootstrap"; // must run before any fluent-ffmpeg import side-effects matter
import { config, validateConfig } from "./config";
import { connectDatabase } from "./db";
import {
  templateRoutes,
  characterRoutes,
  compositionRoutes,
  generateRoutes,
  reelRoutes,
  voiceRoutes,
  audioRoutes,
  metaRoutes,
  trendRoutes,
  maintenanceRoutes,
  youtubeRoutes,
  ytImportRoutes,
  storyRoutes,
  instagramRoutes,
  operationLogRoutes,
} from "./routes";
import { initializeStorage } from "./utils";
import { ensureYtImportsStorage } from "./services/yt-import.service";
import { cleanupLocalProcessingOnStartup } from "./services/local-cleanup.service";
import { cleanupGameplayDownloadCache } from "./services/gameplay-cache.service";
import { startStoryTopUpScheduler } from "./services/story-scheduler.service";
import { startHygieneScheduler } from "./services/hygiene-scheduler.service";
import { startWorkers } from "./queue/workers";
import { checkFfmpegCapability } from "./services/ffmpeg-capability.service";
import { writeOperationLog } from "./services/operation-log.service";

interface RequestTrace {
  id: string;
  startedAt: number;
  method: string;
  path: string;
  query: Record<string, string>;
}

const requestTraces = new WeakMap<Request, RequestTrace>();

function requestTraceFor(request: Request): RequestTrace {
  const existing = requestTraces.get(request);
  if (existing) return existing;
  const url = new URL(request.url);
  const trace = {
    id: crypto.randomUUID(),
    startedAt: performance.now(),
    method: request.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
  };
  requestTraces.set(request, trace);
  return trace;
}

function numericStatus(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function responseFailure(response: unknown): { failed: boolean; message?: string } {
  if (!response || typeof response !== "object") return { failed: false };
  const candidate = response as { success?: unknown; error?: unknown };
  return candidate.success === false
    ? { failed: true, message: typeof candidate.error === "string" ? candidate.error : "Request returned failure" }
    : { failed: false };
}

function logCaptionCapability(): void {
  const cap = checkFfmpegCapability({ fresh: true });
  if (!cap.ok) {
    console.warn(`⚠️  ${cap.message}`);
    for (const hint of cap.fixHints) console.warn(`   → ${hint}`);
    return;
  }
  console.log(
    `🔤 ${cap.message} · ${cap.fontCount} font(s) in ${cap.fontsDir}`
  );
}

// Initialize application
async function initialize() {
  console.log("🚀 Starting Video Generator Service...");

  // Validate configuration
  validateConfig();
  logCaptionCapability();

  // Connect to MongoDB
  await connectDatabase();

  // Initialize storage directories
  await initializeStorage();
  await ensureYtImportsStorage();
  await cleanupLocalProcessingOnStartup();
  const gameplayCleanup = await cleanupGameplayDownloadCache(false);
  if (gameplayCleanup.deleted > 0) {
    console.log(`🧹 Gameplay cache startup cleanup: deleted ${gameplayCleanup.deleted} clip(s) (${Math.round(gameplayCleanup.bytesDeleted / 1024 / 1024)} MB)`);
  }
}

// Create Elysia app
const app = new Elysia({
  serve: {
    maxRequestBodySize: config.maxFileSizeMB * 1024 * 1024, // Convert MB to bytes
  },
})
  // Every API action gets a correlation id and a durable, redacted Mongo log.
  // Worker and provider events use the same Operations feed (see queue/workers).
  .onRequest(({ request, set }) => {
    const trace = requestTraceFor(request);
    set.headers["x-request-id"] = trace.id;
  })
  .onAfterHandle(async ({ request, response, set }) => {
    const trace = requestTraceFor(request);
    // CORS preflights are browser transport plumbing, not a user operation. They
    // would otherwise dominate the feed for every JSON mutation and hide the
    // request that actually matters.
    if (trace.method === "OPTIONS") return;
    const status = numericStatus(set.status) ?? 200;
    const failure = responseFailure(response);
    // The Operations screen polls and manages its own storage. Persisting
    // successful reads/deletes would refill the very feed a user just cleared;
    // genuine management-plane failures still remain observable.
    const successfulOperationsManagement =
      trace.path.startsWith("/api/operations") &&
      (trace.method === "GET" || trace.method === "DELETE") &&
      !failure.failed &&
      status < 400;
    if (successfulOperationsManagement) return;
    await writeOperationLog({
      requestId: trace.id,
      scope: "api",
      level: failure.failed || status >= 500 ? "error" : status >= 400 ? "warn" : "info",
      event: failure.failed ? "api.request_failed" : "api.request_completed",
      message: failure.message ?? `${trace.method} ${trace.path} completed`,
      method: trace.method,
      path: trace.path,
      status,
      durationMs: Math.round(performance.now() - trace.startedAt),
      metadata: { query: trace.query },
    });
  })
  // Global error handler
  .onError(async ({ error, code, request, set }) => {
    const trace = requestTraceFor(request);
    console.error(`Error [${code}]:`, error);
    const message =
      error instanceof Error ? error.message : "Internal server error";
    await writeOperationLog({
      requestId: trace.id,
      scope: "api",
      level: "error",
      event: "api.unhandled_error",
      message,
      method: trace.method,
      path: trace.path,
      status: numericStatus(set.status) ?? 500,
      durationMs: Math.round(performance.now() - trace.startedAt),
      metadata: { code, query: trace.query },
      error,
    });
    return {
      success: false,
      error: message,
      code,
    };
  })

  // Enable CORS
  .use(
    cors({
      origin: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    })
  )

  // Health check
  .get("/health", () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }))

  // API info
  .get("/", () => ({
    name: "Video Generator API",
    version: "2.0.0",
    endpoints: {
      templates: "/api/templates",
      characters: "/api/characters",
      compositions: "/api/compositions",
      voices: "/api/voices",
      generate: "/api/generate",
      reels: "/api/reels",
      health: "/health",
    },
    usage: {
      step1: "POST /api/templates - Upload a background video template",
      step2:
        "POST /api/characters - Create characters with images and voice IDs",
      step3: "POST /api/templates/:id/characters - Add characters to template",
      step4: "GET /api/voices - List available ElevenLabs voices",
      step5: "PATCH /api/characters/:id/voice - Update character voice ID",
      step6:
        "POST /api/generate - Generate video with just templateId and plot!",
    },
  }))

  // Mount routes
  .use(templateRoutes)
  .use(characterRoutes)
  .use(compositionRoutes)
  .use(generateRoutes)
  .use(reelRoutes)
  .use(voiceRoutes)
  .use(audioRoutes)
  .use(metaRoutes)
  .use(trendRoutes)
  .use(youtubeRoutes)
  .use(instagramRoutes)
  .use(ytImportRoutes)
  .use(storyRoutes)
  .use(operationLogRoutes)
  .use(maintenanceRoutes);

// Start server
initialize()
  .then(() => {
    app.listen(config.port);
    startWorkers();
    startStoryTopUpScheduler();
    startHygieneScheduler();

    console.log(`
╔════════════════════════════════════════════════════════╗
║     🎬 Video Generator API v2.0                        ║
╠════════════════════════════════════════════════════════╣
║  Server: http://${config.host}:${config.port}                          ║
║  MongoDB: Connected                                    ║
║                                                        ║
║  One-Command Generation:                               ║
║    POST /api/generate                                  ║
║    { "templateId": "...", "plot": "Your story..." }    ║
║                                                        ║
║  Endpoints:                                            ║
║    • POST   /api/templates           Upload template   ║
║    • POST   /api/templates/:id/characters  Add chars   ║
║    • POST   /api/characters          Create character  ║
║    • POST   /api/generate            One-command gen   ║
║    • GET    /api/generate/:id        Check status      ║
╚════════════════════════════════════════════════════════╝
  `);
  })
  .catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });

export type App = typeof app;
