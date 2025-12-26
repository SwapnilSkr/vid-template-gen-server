import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { staticPlugin } from "@elysiajs/static";
import { config, validateConfig } from "./config";
import { templateRoutes, characterRoutes, compositionRoutes } from "./routes";
import { loadTemplates, loadCharacters } from "./services";
import { initializeStorage } from "./utils";

// Initialize application
async function initialize() {
  console.log("🚀 Starting Video Generator Service...");

  // Validate configuration
  validateConfig();

  // Initialize storage directories
  await initializeStorage();

  // Load existing data
  await loadTemplates();
  await loadCharacters();
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

  // Serve static files from storage/output
  .use(
    staticPlugin({
      assets: config.outputPath,
      prefix: "/files",
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
    version: "1.0.0",
    endpoints: {
      templates: "/api/templates",
      characters: "/api/characters",
      compositions: "/api/compositions",
      health: "/health",
    },
  }))

  // Mount routes
  .use(templateRoutes)
  .use(characterRoutes)
  .use(compositionRoutes);

// Start server
initialize().then(() => {
  app.listen(config.port);

  console.log(`
╔════════════════════════════════════════════════════╗
║     🎬 Video Generator Service                     ║
╠════════════════════════════════════════════════════╣
║  Server: http://${config.host}:${config.port}                    ║
║                                                    ║
║  Endpoints:                                        ║
║    • POST   /api/templates          Upload template║
║    • GET    /api/templates          List templates ║
║    • POST   /api/characters         Create char    ║
║    • GET    /api/characters         List chars     ║
║    • POST   /api/compositions       Start render   ║
║    • GET    /api/compositions/:id/status           ║
║    • GET    /api/compositions/:id/download         ║
╚════════════════════════════════════════════════════╝
  `);
});

export type App = typeof app;
