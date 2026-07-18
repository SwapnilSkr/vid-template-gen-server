import type { Context } from "elysia";
import { cancelInstagramChannelConnect, completeInstagramChannelConnect, disableInstagramChannel, listInstagramChannels, listInstagramComments, postInstagramFirstComment, replyToInstagramComment, startInstagramChannelConnect, updateInstagramChannel } from "../services";
import { getErrorMessage } from "../types";
import type { TConnectInstagramBody, TIdParams, TInstagramCallbackQuery, TReelChannelParams, TReelCommentsQuery, TReelIdParams, TReplyCommentBody, TUpdateInstagramChannelBody } from "../types/guards";

export async function listInstagramChannelsController() { return { success: true, data: await listInstagramChannels() }; }
export async function startInstagramConnectController({ body }: Context & { body: TConnectInstagramBody }) { return { success: true, data: await startInstagramChannelConnect(body) }; }
export async function completeInstagramConnectController({ query, set }: Context & { query: TInstagramCallbackQuery }) {
  set.headers["content-type"] = "text/html; charset=utf-8";
  if (query.error) { await cancelInstagramChannelConnect(query.state); return callback(false, query.error_description || query.error_reason || query.error); }
  if (!query.code || !query.state) return callback(false, "Missing OAuth code/state.");
  try { const channel = await completeInstagramChannelConnect(query.code, query.state); return callback(true, `Connected ${channel.label}. You can close this tab.`); }
  catch (error) { return callback(false, error instanceof Error ? error.message : "Instagram connection failed."); }
}
export async function deleteInstagramChannelController({ params }: Context & { params: TIdParams }) { await disableInstagramChannel(params.id); return { success: true, data: { id: params.id } }; }
export async function updateInstagramChannelController({ params, body }: Context & { params: TIdParams; body: TUpdateInstagramChannelBody }) { return { success: true, data: await updateInstagramChannel(params.id, body) }; }
function callback(success: boolean, message: string) { const escaped = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); const payload = JSON.stringify({ type: "instagram-channel-connected", success, message }); return `<!doctype html><title>Instagram account connect</title><body style="font-family:system-ui;background:#111;color:#f5f5f5;padding:48px"><h1>${success ? "Instagram account connected" : "Instagram connection failed"}</h1><p>${escaped}</p><script>window.opener&&window.opener.postMessage(${payload},"*")</script></body>`; }

// ---- Own-post comment layer (own-media only) ----
export async function postInstagramFirstCommentController({ params, body, set }: Context & { params: TReelChannelParams; body: unknown }) {
  void body;
  try { return { success: true, data: { commentId: await postInstagramFirstComment(params.reelId, params.channelId) } }; }
  catch (error) { set.status = 400; return { success: false, error: getErrorMessage(error) }; }
}
interface ListInstagramCommentsContext extends Context { params: TReelIdParams; query: TReelCommentsQuery }
export async function listInstagramCommentsController({ params, query, set }: ListInstagramCommentsContext) {
  const limit = query.limit ? Number(query.limit) : undefined;
  try { return { success: true, data: await listInstagramComments(params.reelId, query.channelId, Number.isFinite(limit) ? limit : undefined) }; }
  catch (error) { set.status = 400; return { success: false, error: getErrorMessage(error) }; }
}
export async function replyInstagramCommentController({ body, set }: Context & { body: TReplyCommentBody }) {
  try { return { success: true, data: { replyId: await replyToInstagramComment(body.channelId, body.commentId, body.message) } }; }
  catch (error) { set.status = 400; return { success: false, error: getErrorMessage(error) }; }
}
