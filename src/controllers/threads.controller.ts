import type { Context } from "elysia";
import {
  cancelThreadsConnect,
  completeThreadsConnect,
  disableThreadsChannel,
  getThreadsDataDeletionRequest,
  handleThreadsDataDeletion,
  handleThreadsUninstall,
  listThreadsChannels,
  postThreadsFirstReply,
  threadsCallbackUrl,
  startThreadsConnect,
  updateThreadsChannel,
} from "../services";
import { Reel } from "../models";
import { enqueuePublish } from "../queue/queues";
import { getErrorMessage } from "../types";
import type {
  TConnectThreadsBody,
  TIdParams,
  TReelChannelParams,
  TThreadsCallbackQuery,
  TUpdateThreadsChannelBody,
} from "../types/guards";

export async function listThreadsChannelsController() {
  return { success: true, data: await listThreadsChannels() };
}
export async function startThreadsConnectController({ body, set }: Context & { body: TConnectThreadsBody }) {
  try { return { success: true, data: await startThreadsConnect(body) }; }
  catch (error) { set.status = 400; return { success: false, error: getErrorMessage(error) }; }
}
export async function completeThreadsConnectController({ query, set }: Context & { query: TThreadsCallbackQuery }) {
  set.headers["content-type"] = "text/html; charset=utf-8";
  if (query.error) { await cancelThreadsConnect(query.state); return callback(false, query.error_description || query.error_reason || query.error); }
  if (!query.code || !query.state) return callback(false, "Missing OAuth code/state.");
  try { const channel = await completeThreadsConnect(query.code, query.state); return callback(true, `Connected ${channel.label}. You can close this tab.`); }
  catch (error) { return callback(false, getErrorMessage(error)); }
}
export async function deleteThreadsChannelController({ params }: Context & { params: TIdParams }) {
  await disableThreadsChannel(params.id);
  return { success: true, data: { id: params.id } };
}
export async function updateThreadsChannelController({ params, body }: Context & { params: TIdParams; body: TUpdateThreadsChannelBody }) {
  return { success: true, data: await updateThreadsChannel(params.id, body) };
}

export async function postThreadsFirstReplyController({ params, set }: Context & { params: TReelChannelParams }) {
  try { return { success: true, data: { replyId: await postThreadsFirstReply(params.reelId, params.channelId) } }; }
  catch (error) { set.status = 400; return { success: false, error: getErrorMessage(error) }; }
}

/** Meta calls this when an account deauthorizes the Threads app. */
export async function threadsUninstallController({ body, set }: Context & { body: { signed_request: string } }) {
  try {
    await handleThreadsUninstall(body.signed_request);
    return { success: true };
  } catch (error) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

/** Meta's data-deletion contract requires a top-level confirmation URL/code,
 * rather than the normal API { success, data } envelope. */
export async function threadsDataDeletionController({ body, set }: Context & { body: { signed_request: string } }) {
  try {
    const result = await handleThreadsDataDeletion(body.signed_request);
    return {
      url: threadsCallbackUrl(`/api/threads/data-deletion/status/${result.confirmationCode}`),
      confirmation_code: result.confirmationCode,
    };
  } catch (error) {
    set.status = 400;
    return { error: getErrorMessage(error) };
  }
}

/** Human-readable receipt linked from Meta's data-deletion response. */
export async function threadsDataDeletionStatusController({ params, set }: Context & { params: { confirmationCode: string } }) {
  const request = await getThreadsDataDeletionRequest(params.confirmationCode);
  if (!request) {
    set.status = 404;
    return "<!doctype html><title>Deletion request not found</title><p>Deletion request not found or expired.</p>";
  }
  set.headers["content-type"] = "text/html; charset=utf-8";
  return "<!doctype html><title>Data deletion completed</title><body style=\"font-family:system-ui;padding:48px\"><h1>Data deletion completed</h1><p>The local Threads authorization data for this app was deleted.</p></body>";
}

/** Cross-post a completed reel's shared 9:16 render to one owned Threads profile. */
export async function publishThreadsController({ params, set }: Context & { params: TReelChannelParams }) {
  try {
    const reel = await Reel.findById(params.reelId);
    if (!reel) { set.status = 404; return { success: false, error: "Reel not found" }; }
    if (reel.status !== "completed") { set.status = 400; return { success: false, error: `Reel not completed. Current status: ${reel.status}` }; }
    if (!reel.outputUrl) { set.status = 409; return { success: false, error: "This reel has no rendered output to cross-post yet" }; }
    const pendingThreads = [
      ...reel.threads.filter((p) => p.channelId !== params.channelId),
      { channelId: params.channelId, status: "pending", message: "Queued for Threads publishing…", updatedAt: new Date() },
    ];
    // Keep this update isolated from Facebook's concurrent queue request.
    // A four-platform Studio submission must not lose a destination because
    // two controllers happened to save the same Reel document at once.
    await Reel.updateOne({ _id: reel._id }, { $set: { threads: pendingThreads } });
    await enqueuePublish(params.reelId, "threads", params.channelId);
    return { success: true, data: { threads: pendingThreads }, message: "Threads publish job queued" };
  } catch (error) { set.status = 400; return { success: false, error: getErrorMessage(error) }; }
}

function callback(success: boolean, message: string) {
  const escaped = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const payload = JSON.stringify({ type: "threads-channel-connected", success, message });
  return `<!doctype html><title>Threads profile connect</title><body style="font-family:system-ui;background:#111;color:#f5f5f5;padding:48px"><h1>${success ? "Threads profile connected" : "Threads connection failed"}</h1><p>${escaped}</p><script>window.opener&&window.opener.postMessage(${payload},"*")</script></body>`;
}
