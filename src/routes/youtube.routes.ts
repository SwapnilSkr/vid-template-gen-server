import { Elysia } from "elysia";
import {
  ConnectYouTubeBody,
  IdParams,
  PostFirstCommentBody,
  ReelCommentsQuery,
  ReelIdParams,
  ReplyCommentBody,
  UpdateYouTubeChannelBody,
  YouTubeCallbackQuery,
} from "../types/guards";
import {
  completeYouTubeConnectController,
  deleteYouTubeChannelController,
  listYouTubeCommentsController,
  listYouTubePublishChannelsController,
  postYouTubeFirstCommentController,
  replyYouTubeCommentController,
  startYouTubeConnectController,
  updateYouTubeChannelController,
} from "../controllers";

export const youtubeRoutes = new Elysia({ prefix: "/api/youtube" })
  .get("/channels", listYouTubePublishChannelsController)
  .post("/connect/start", startYouTubeConnectController, {
    body: ConnectYouTubeBody,
  })
  .get("/connect/callback", completeYouTubeConnectController, {
    query: YouTubeCallbackQuery,
  })
  .delete("/channels/:id", deleteYouTubeChannelController, {
    params: IdParams,
  })
  .put("/channels/:id", updateYouTubeChannelController, { params: IdParams, body: UpdateYouTubeChannelBody })
  // Own-post comment layer (own-media only)
  .post("/reels/:reelId/first-comment", postYouTubeFirstCommentController, { params: ReelIdParams, body: PostFirstCommentBody })
  .get("/reels/:reelId/comments", listYouTubeCommentsController, { params: ReelIdParams, query: ReelCommentsQuery })
  .post("/comments/reply", replyYouTubeCommentController, { body: ReplyCommentBody });
