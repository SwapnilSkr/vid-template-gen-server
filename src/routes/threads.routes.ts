import { Elysia } from "elysia";
import {
  ConnectThreadsBody,
  IdParams,
  ReelChannelParams,
  ThreadsCallbackQuery,
  ThreadsDeletionStatusParams,
  ThreadsSignedRequestBody,
  UpdateThreadsChannelBody,
} from "../types/guards";
import {
  completeThreadsConnectController,
  deleteThreadsChannelController,
  listThreadsChannelsController,
  publishThreadsController,
  startThreadsConnectController,
  threadsDataDeletionController,
  threadsDataDeletionStatusController,
  threadsUninstallController,
  updateThreadsChannelController,
} from "../controllers";

export const threadsRoutes = new Elysia({ prefix: "/api/threads" })
  .get("/channels", listThreadsChannelsController)
  .post("/connect/start", startThreadsConnectController, { body: ConnectThreadsBody })
  .get("/connect/callback", completeThreadsConnectController, { query: ThreadsCallbackQuery })
  // Meta lifecycle callbacks. Keep these outside the Studio API envelope so
  // their signed-request and deletion-response contracts remain exact.
  .post("/uninstall", threadsUninstallController, { body: ThreadsSignedRequestBody })
  .post("/data-deletion", threadsDataDeletionController, { body: ThreadsSignedRequestBody })
  .get("/data-deletion/status/:confirmationCode", threadsDataDeletionStatusController, { params: ThreadsDeletionStatusParams })
  .delete("/channels/:id", deleteThreadsChannelController, { params: IdParams })
  .put("/channels/:id", updateThreadsChannelController, { params: IdParams, body: UpdateThreadsChannelBody })
  .post("/reels/:reelId/channels/:channelId/publish", publishThreadsController, { params: ReelChannelParams });
