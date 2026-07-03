import { Elysia } from "elysia";
import { ConnectYouTubeBody, IdParams, YouTubeCallbackQuery } from "../types/guards";
import {
  completeYouTubeConnectController,
  deleteYouTubeChannelController,
  listYouTubePublishChannelsController,
  startYouTubeConnectController,
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
  });
