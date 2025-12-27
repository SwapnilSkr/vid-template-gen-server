/**
 * Audio Test Controller
 * Handles audio merging test endpoints
 */
import type { Context } from "elysia";
import {
  testAudioMerge,
  testAudioMergeCustom,
  listTestOutputs,
  cleanupTestFiles,
} from "../services/audio.service";

/**
 * GET /api/audio/test
 * Run the basic audio merge test with generated test tones
 */
export async function runAudioTestController(): Promise<{
  success: boolean;
  message: string;
  result: Awaited<ReturnType<typeof testAudioMerge>>;
}> {
  console.log("🧪 Starting audio merge test...");

  const result = await testAudioMerge();

  return {
    success: result.success,
    message: result.success
      ? "Audio merge test completed successfully!"
      : `Audio merge test failed: ${result.error}`,
    result,
  };
}

/**
 * POST /api/audio/test
 * Run a custom audio merge test
 * Body: { videoUrl?: string, audioConfigs: [{ startTime: number, frequency?: number, duration?: number }] }
 */
export async function runCustomAudioTestController({
  body,
}: Context<{
  body: {
    videoUrl?: string;
    audioConfigs: {
      startTime: number;
      frequency?: number;
      duration?: number;
    }[];
  };
}>): Promise<{
  success: boolean;
  message: string;
  result: Awaited<ReturnType<typeof testAudioMergeCustom>>;
}> {
  const { videoUrl, audioConfigs } = body;

  if (!audioConfigs || audioConfigs.length === 0) {
    return {
      success: false,
      message: "audioConfigs is required and must have at least one entry",
      result: { success: false, error: "Invalid input" },
    };
  }

  const defaultVideoUrl =
    "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

  console.log("🧪 Starting custom audio merge test...");
  console.log(`   Video: ${videoUrl || defaultVideoUrl}`);
  console.log(`   Audio segments: ${audioConfigs.length}`);

  const result = await testAudioMergeCustom(
    videoUrl || defaultVideoUrl,
    audioConfigs
  );

  return {
    success: result.success,
    message: result.success
      ? "Custom audio merge test completed successfully!"
      : `Custom audio merge test failed: ${result.error}`,
    result,
  };
}

/**
 * GET /api/audio/test/files
 * List all test output files
 */
export async function listTestFilesController(): Promise<{
  success: boolean;
  files: string[];
}> {
  const files = await listTestOutputs();
  return {
    success: true,
    files,
  };
}

/**
 * DELETE /api/audio/test/files
 * Clean up all test files
 */
export async function cleanupTestFilesController(): Promise<{
  success: boolean;
  message: string;
  deletedCount: number;
}> {
  const deletedCount = await cleanupTestFiles();
  return {
    success: true,
    message: `Cleaned up ${deletedCount} test files`,
    deletedCount,
  };
}
