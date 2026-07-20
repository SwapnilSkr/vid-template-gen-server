import type { Context } from "elysia";
import {
  cancelFacebookConnect,
  completeFacebookConnect,
  disableFacebookPage,
  facebookCallbackUrl,
  getFacebookDataDeletionRequest,
  handleFacebookDataDeletion,
  handleFacebookUninstall,
  listFacebookPages,
  postFacebookFirstComment,
  startFacebookConnect,
  updateFacebookPage,
} from "../services";
import { Reel } from "../models";
import { enqueuePublish } from "../queue/queues";
import { getErrorMessage } from "../types";
import type {
  TConnectFacebookBody,
  TFacebookCallbackQuery,
  TIdParams,
  TReelChannelParams,
  TUpdateFacebookPageBody,
} from "../types/guards";

export async function listFacebookPagesController() {
  return { success: true, data: await listFacebookPages() };
}
export async function startFacebookConnectController({ body, set }: Context & { body: TConnectFacebookBody }) {
  try { return { success: true, data: await startFacebookConnect(body) }; }
  catch (error) { set.status = 400; return { success: false, error: getErrorMessage(error) }; }
}
export async function completeFacebookConnectController({ query, set }: Context & { query: TFacebookCallbackQuery }) {
  set.headers["content-type"] = "text/html; charset=utf-8";
  if (query.error) { await cancelFacebookConnect(query.state); return callback(false, query.error_description || query.error_reason || query.error); }
  if (!query.code || !query.state) return callback(false, "Missing OAuth code/state.");
  try { const result = await completeFacebookConnect(query.code, query.state); return callback(true, `Connected ${result.connected} Page(s). You can close this tab.`); }
  catch (error) { return callback(false, getErrorMessage(error)); }
}
export async function deleteFacebookPageController({ params }: Context & { params: TIdParams }) {
  await disableFacebookPage(params.id);
  return { success: true, data: { id: params.id } };
}
export async function updateFacebookPageController({ params, body }: Context & { params: TIdParams; body: TUpdateFacebookPageBody }) {
  return { success: true, data: await updateFacebookPage(params.id, body) };
}

/** Meta calls this when the Facebook user removes the app. */
export async function facebookUninstallController({ body, set }: Context & { body: { signed_request: string } }) {
  try {
    await handleFacebookUninstall(body.signed_request);
    return { success: true };
  } catch (error) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

/** Facebook's data-deletion callback requires this exact top-level receipt,
 * not the Studio API success envelope. */
export async function facebookDataDeletionController({ body, set }: Context & { body: { signed_request: string } }) {
  try {
    const result = await handleFacebookDataDeletion(body.signed_request);
    return {
      url: facebookCallbackUrl(`/api/facebook/data-deletion/status/${result.confirmationCode}`),
      confirmation_code: result.confirmationCode,
    };
  } catch (error) {
    set.status = 400;
    return { error: getErrorMessage(error) };
  }
}

/** A short-lived human-readable confirmation URL returned to Meta. */
export async function facebookDataDeletionStatusController({ params, set }: Context & { params: { confirmationCode: string } }) {
  const request = await getFacebookDataDeletionRequest(params.confirmationCode);
  if (!request) {
    set.status = 404;
    return "<!doctype html><title>Deletion request not found</title><p>Deletion request not found or expired.</p>";
  }
  set.headers["content-type"] = "text/html; charset=utf-8";
  return "<!doctype html><title>Data deletion completed</title><body style=\"font-family:system-ui;padding:48px\"><h1>Data deletion completed</h1><p>The local Facebook Page authorization data for this app was deleted.</p></body>";
}

/** Fan a completed reel's shared 9:16 render out to one owned Page. */
export async function publishFacebookController({ params, set }: Context & { params: TReelChannelParams }) {
  try {
    const reel = await Reel.findById(params.reelId);
    if (!reel) { set.status = 404; return { success: false, error: "Reel not found" }; }
    if (reel.status !== "completed") { set.status = 400; return { success: false, error: `Reel not completed. Current status: ${reel.status}` }; }
    if (!reel.outputUrl) { set.status = 409; return { success: false, error: "This reel has no rendered output to cross-post yet" }; }
    const pendingFacebook = [
      ...reel.facebook.filter((p) => p.channelId !== params.channelId),
      { channelId: params.channelId, status: "pending", message: "Queued for Facebook publishing…", updatedAt: new Date() },
    ];
    // Facebook, Threads, and the YouTube/Instagram distribute endpoint can be
    // selected in one Studio submission. Saving this stale document races the
    // other platform controller and trips Mongoose's optimistic concurrency
    // check, causing one otherwise-valid destination to disappear before it
    // reaches BullMQ. Update only Facebook's field atomically instead.
    await Reel.updateOne({ _id: reel._id }, { $set: { facebook: pendingFacebook } });
    await enqueuePublish(params.reelId, "facebook", params.channelId);
    return { success: true, data: { facebook: pendingFacebook }, message: "Facebook publish job queued" };
  } catch (error) { set.status = 400; return { success: false, error: getErrorMessage(error) }; }
}

export async function postFacebookFirstCommentController({ params, set }: Context & { params: TReelChannelParams }) {
  try { return { success: true, data: { commentId: await postFacebookFirstComment(params.reelId, params.channelId) } }; }
  catch (error) { set.status = 400; return { success: false, error: getErrorMessage(error) }; }
}

function callback(success: boolean, message: string) {
  const escaped = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const payload = JSON.stringify({ type: "facebook-page-connected", success, message });
  return `<!doctype html><title>Facebook Page connect</title><body style="font-family:system-ui;background:#111;color:#f5f5f5;padding:48px"><h1>${success ? "Facebook Page connected" : "Facebook connection failed"}</h1><p>${escaped}</p><script>window.opener&&window.opener.postMessage(${payload},"*")</script></body>`;
}
