import { Elysia } from "elysia";
import {
  IdParams,
  CreateReelBody,
  UpdateReelReviewBody,
  RevoiceReelBody,
  VariantParams,
  ThumbnailFrameBody,
  PublishReelBody,
} from "../types/guards";
import {
  createReelController,
  listReelsController,
  getReelStatusController,
  downloadReelController,
  deleteReelController,
  publishReelController,
  getReelReviewController,
  updateReelReviewController,
  regenerateReelThumbnailController,
  revoiceReelController,
  promoteVoiceVariantController,
  useReelFrameAsThumbnailController,
  listYouTubeChannelsController,
} from "../controllers";

// ============================================
// Reel Routes (scene-graph pipeline: Reddit/AITA, dark history, etc.)
// ============================================

export const reelRoutes = new Elysia({ prefix: "/api/reels" })
  // Create a new reel (one-command generation, async)
  .post("/", createReelController, {
    body: CreateReelBody,
  })

  // List all reels
  .get("/", listReelsController)

  // List configured YouTube publish targets. Refresh tokens are never returned.
  .get("/youtube/channels", listYouTubeChannelsController)

  // Get reel status/progress
  .get("/:id/status", getReelStatusController, {
    params: IdParams,
  })

  // Download completed reel
  .get("/:id/download", downloadReelController, {
    params: IdParams,
  })

  // Review package for title, description, tags, thumbnail, and visibility notes
  .get("/:id/review", getReelReviewController, {
    params: IdParams,
  })

  .put("/:id/review", updateReelReviewController, {
    params: IdParams,
    body: UpdateReelReviewBody,
  })

  .post("/:id/review/thumbnail", regenerateReelThumbnailController, {
    params: IdParams,
    body: UpdateReelReviewBody,
  })

  // Use a specific frame of the rendered video as the thumbnail
  .post("/:id/review/thumbnail/frame", useReelFrameAsThumbnailController, {
    params: IdParams,
    body: ThumbnailFrameBody,
  })

  // Request re-narrated voice variants (different TTS model/voice, same story + gameplay clip)
  .post("/:id/revoice", revoiceReelController, {
    params: IdParams,
    body: RevoiceReelBody,
  })

  // Promote a ready voice variant to be the reel's primary output
  .post("/:id/revoice/:variantId/promote", promoteVoiceVariantController, {
    params: VariantParams,
  })

  // Delete a reel
  .delete("/:id", deleteReelController, {
    params: IdParams,
  })

  // Publish (or retry publishing) a completed reel to YouTube
  .post("/:id/publish", publishReelController, {
    params: IdParams,
    body: PublishReelBody,
  });
