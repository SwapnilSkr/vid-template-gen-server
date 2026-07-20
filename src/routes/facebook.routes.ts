import { Elysia } from "elysia";
import {
  ConnectFacebookBody,
  FacebookCallbackQuery,
  FacebookDeletionStatusParams,
  FacebookSignedRequestBody,
  IdParams,
  ReelChannelParams,
  UpdateFacebookPageBody,
} from "../types/guards";
import {
  completeFacebookConnectController,
  deleteFacebookPageController,
  facebookDataDeletionController,
  facebookDataDeletionStatusController,
  facebookUninstallController,
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
  // Facebook Login for Business lifecycle endpoints. Keep the signed request
  // and deletion receipt protocol separate from the normal Studio envelope.
  .post("/uninstall", facebookUninstallController, { body: FacebookSignedRequestBody })
  .post("/data-deletion", facebookDataDeletionController, { body: FacebookSignedRequestBody })
  .get("/data-deletion/status/:confirmationCode", facebookDataDeletionStatusController, { params: FacebookDeletionStatusParams })
  .delete("/channels/:id", deleteFacebookPageController, { params: IdParams })
  .put("/channels/:id", updateFacebookPageController, { params: IdParams, body: UpdateFacebookPageBody })
  .post("/reels/:reelId/channels/:channelId/publish", publishFacebookController, { params: ReelChannelParams })
  .post("/reels/:reelId/channels/:channelId/first-comment", postFacebookFirstCommentController, { params: ReelChannelParams });
