/**
 * Audio Test Routes
 * Routes for testing audio merging functionality
 */
import { Elysia, t } from "elysia";
import {
  runAudioTestController,
  runCustomAudioTestController,
  listTestFilesController,
  cleanupTestFilesController,
} from "../controllers/audio.controller";

export const audioRoutes = new Elysia({ prefix: "/api/audio" })
  // Run basic audio merge test
  .get("/test", runAudioTestController, {
    detail: {
      summary: "Run basic audio merge test",
      description:
        "Tests audio merging with generated test tones on a sample video. " +
        "Creates 3 audio segments at different timestamps and merges them onto the video.",
      tags: ["Audio Test"],
    },
  })

  // Run custom audio merge test
  .post("/test", runCustomAudioTestController, {
    body: t.Object({
      videoUrl: t.Optional(t.String()),
      audioConfigs: t.Array(
        t.Object({
          startTime: t.Number(),
          frequency: t.Optional(t.Number()),
          duration: t.Optional(t.Number()),
        })
      ),
    }),
    detail: {
      summary: "Run custom audio merge test",
      description:
        "Test audio merging with custom configuration. " +
        "Specify video URL and audio segments with start times.",
      tags: ["Audio Test"],
    },
  })

  // List test output files
  .get("/test/files", listTestFilesController, {
    detail: {
      summary: "List test output files",
      description: "List all generated test output files",
      tags: ["Audio Test"],
    },
  })

  // Clean up test files
  .delete("/test/files", cleanupTestFilesController, {
    detail: {
      summary: "Clean up test files",
      description: "Delete all test output files",
      tags: ["Audio Test"],
    },
  });
