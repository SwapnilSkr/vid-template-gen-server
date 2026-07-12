import { Elysia } from "elysia";
import { ConnectInstagramBody, IdParams, InstagramCallbackQuery, UpdateInstagramChannelBody } from "../types/guards";
import { completeInstagramConnectController, deleteInstagramChannelController, listInstagramChannelsController, startInstagramConnectController, updateInstagramChannelController } from "../controllers";

export const instagramRoutes = new Elysia({ prefix: "/api/instagram" })
  .get("/channels", listInstagramChannelsController)
  .post("/connect/start", startInstagramConnectController, { body: ConnectInstagramBody })
  .get("/connect/callback", completeInstagramConnectController, { query: InstagramCallbackQuery })
  .delete("/channels/:id", deleteInstagramChannelController, { params: IdParams })
  .put("/channels/:id", updateInstagramChannelController, { params: IdParams, body: UpdateInstagramChannelBody });
