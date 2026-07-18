import { Elysia } from "elysia";
import {
  ConnectFacebookBody,
  FacebookCallbackQuery,
  IdParams,
  ReelChannelParams,
  UpdateFacebookPageBody,
} from "../types/guards";
import {
  completeFacebookConnectController,
  deleteFacebookPageController,
  listFacebookPagesController,
  postFacebookFirstCommentController,
  publishFacebookController,
  startFacebookConnectController,
  updateFacebookPageController,
} from "../controllers";

export const facebookRoutes = new Elysia({ prefix: "/api/facebook" })
  .get("/channels", listFacebookPagesController)
  .post("/connect/start", startFacebookConnectController, { body: ConnectFacebookBody })
  .get("/connect/callback", completeFacebookConnectController, { query: FacebookCallbackQuery })
  .delete("/channels/:id", deleteFacebookPageController, { params: IdParams })
  .put("/channels/:id", updateFacebookPageController, { params: IdParams, body: UpdateFacebookPageBody })
  .post("/reels/:reelId/channels/:channelId/publish", publishFacebookController, { params: ReelChannelParams })
  .post("/reels/:reelId/channels/:channelId/first-comment", postFacebookFirstCommentController, { params: ReelChannelParams });
