import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { config, validateConfig } from "./config";
import { connectDatabase } from "./db";
import {
  templateRoutes,
  characterRoutes,
  compositionRoutes,
  generateRoutes,
  voiceRoutes,
} from "./routes";
import { initializeStorage } from "./utils";

// Initialize application
async function initialize() {
  console.log("🚀 Starting Video Generator Service...");

  // Validate configuration
  validateConfig();

  // Connect to MongoDB
  await connectDatabase();

  // Initialize storage directories
  await initializeStorage();
}

// Create Elysia app
const app = new Elysia()
  // Global error handler
  .onError(({ error, code }) => {
    console.error(`Error [${code}]:`, error);
    const message =
      error instanceof Error ? error.message : "Internal server error";
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
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
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
  .use(voiceRoutes);

// Start server
initialize()
  .then(() => {
    app.listen(config.port);

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
