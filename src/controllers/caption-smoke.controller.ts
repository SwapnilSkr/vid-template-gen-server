import type { Context } from "elysia";
import { runCaptionSmokeTest } from "../services/caption-smoke.service";

/**
 * GET /api/maintenance/caption-smoke
 * Front→backend smoke: burns ASS captions onto a blue test video and verifies
 * pixels changed. Also exercises the one-space path trap that used to drop
 * captions on many Macs.
 *
 * Query: keepOutput=1 to leave the MP4 on disk for inspection.
 */
export async function runCaptionSmokeController({
  query,
}: Context<{ query: { keepOutput?: string } }>) {
  console.log("🧪 Starting caption burn smoke test…");
  const keepOutput =
    query.keepOutput === "1" ||
    query.keepOutput === "true" ||
    query.keepOutput === "yes";
  const result = await runCaptionSmokeTest({ keepOutput });
  return {
    success: result.success,
    message: result.message,
    result,
  };
}
