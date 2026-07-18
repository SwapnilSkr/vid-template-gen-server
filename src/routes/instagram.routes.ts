import { Elysia } from "elysia";
import {
  ConnectInstagramBody,
  IdParams,
  InstagramCallbackQuery,
  ReelChannelParams,
  ReelCommentsQuery,
  ReelIdParams,
  ReplyCommentBody,
  UpdateInstagramChannelBody,
} from "../types/guards";
import {
  completeInstagramConnectController,
  deleteInstagramChannelController,
  listInstagramChannelsController,
  listInstagramCommentsController,
  postInstagramFirstCommentController,
  replyInstagramCommentController,
  startInstagramConnectController,
  updateInstagramChannelController,
} from "../controllers";

export const instagramRoutes = new Elysia({ prefix: "/api/instagram" })
  .get("/channels", listInstagramChannelsController)
  .post("/connect/start", startInstagramConnectController, { body: ConnectInstagramBody })
  .get("/connect/callback", completeInstagramConnectController, { query: InstagramCallbackQuery })
  .delete("/channels/:id", deleteInstagramChannelController, { params: IdParams })
  .put("/channels/:id", updateInstagramChannelController, { params: IdParams, body: UpdateInstagramChannelBody })
  // Own-post comment layer (own-media only)
  .post("/reels/:reelId/channels/:channelId/first-comment", postInstagramFirstCommentController, { params: ReelChannelParams })
  .get("/reels/:reelId/comments", listInstagramCommentsController, { params: ReelIdParams, query: ReelCommentsQuery })
  .post("/comments/reply", replyInstagramCommentController, { body: ReplyCommentBody });
