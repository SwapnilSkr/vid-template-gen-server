import type { Context } from "elysia";
import {
  cancelYouTubeChannelConnect,
  completeYouTubeChannelConnect,
  disableYouTubeChannel,
  listAllYouTubePublishChannels,
  listYouTubeComments,
  postYouTubeFirstComment,
  replyToYouTubeComment,
  startYouTubeChannelConnect,
  updateYouTubeChannel,
} from "../services";
import { getErrorMessage } from "../types";
import type {
  TConnectYouTubeBody,
  TIdParams,
  TPostFirstCommentBody,
  TReelCommentsQuery,
  TReelIdParams,
  TReplyCommentBody,
  TYouTubeCallbackQuery,
  TUpdateYouTubeChannelBody,
} from "../types/guards";

interface ConnectYouTubeContext extends Context {
  body: TConnectYouTubeBody;
}

interface YouTubeCallbackContext extends Context {
  query: TYouTubeCallbackQuery;
  set: Context["set"];
}

interface DeleteYouTubeChannelContext extends Context {
  params: TIdParams;
}

export async function listYouTubePublishChannelsController() {
  return { success: true, data: await listAllYouTubePublishChannels() };
}

export async function startYouTubeConnectController({ body }: ConnectYouTubeContext) {
  const data = await startYouTubeChannelConnect(body);
  return { success: true, data };
}

export async function completeYouTubeConnectController({
  query,
  set,
}: YouTubeCallbackContext) {
  if (query.error) {
    await cancelYouTubeChannelConnect(query.state);
    set.headers["content-type"] = "text/html; charset=utf-8";
    return renderCallbackHtml(false, getOAuthErrorMessage(query.error, query.error_description));
  }
  if (!query.code || !query.state) {
    set.headers["content-type"] = "text/html; charset=utf-8";
    return renderCallbackHtml(false, "Missing OAuth code/state.");
  }

  try {
    const channel = await completeYouTubeChannelConnect(query.code, query.state);
    set.headers["content-type"] = "text/html; charset=utf-8";
    return renderCallbackHtml(
      true,
      `Connected ${channel.googleChannelTitle || channel.label}. You can close this tab.`
    );
  } catch (error) {
    set.headers["content-type"] = "text/html; charset=utf-8";
    const message = error instanceof Error ? error.message : "YouTube connection failed.";
    return renderCallbackHtml(false, message);
  }
}

export async function deleteYouTubeChannelController({
  params,
}: DeleteYouTubeChannelContext) {
  await disableYouTubeChannel(params.id);
  return { success: true, data: { id: params.id } };
}
export async function updateYouTubeChannelController({ params, body }: Context & { params: TIdParams; body: TUpdateYouTubeChannelBody }) { return { success: true, data: await updateYouTubeChannel(params.id, body) }; }

// ---- Own-post comment layer (own-media only) ----
export async function postYouTubeFirstCommentController({ params, body, set }: Context & { params: TReelIdParams; body: TPostFirstCommentBody }) {
  try { return { success: true, data: { commentId: await postYouTubeFirstComment(params.reelId, body.channelId) } }; }
  catch (error) { set.status = 400; return { success: false, error: getErrorMessage(error) }; }
}
interface ListYouTubeCommentsContext extends Context { params: TReelIdParams; query: TReelCommentsQuery }
export async function listYouTubeCommentsController({ params, query, set }: ListYouTubeCommentsContext) {
  const limit = query.limit ? Number(query.limit) : undefined;
  try { return { success: true, data: await listYouTubeComments(params.reelId, query.channelId, Number.isFinite(limit) ? limit : undefined) }; }
  catch (error) { set.status = 400; return { success: false, error: getErrorMessage(error) }; }
}
export async function replyYouTubeCommentController({ body, set }: Context & { body: TReplyCommentBody }) {
  try { return { success: true, data: { replyId: await replyToYouTubeComment(body.channelId, body.commentId, body.message) } }; }
  catch (error) { set.status = 400; return { success: false, error: getErrorMessage(error) }; }
}

function getOAuthErrorMessage(error: string, description?: string) {
  if (error === "access_denied") {
    return (
      "Google did not grant access. Choose the YouTube account again and approve both YouTube permissions. " +
      "If Google says the app is in testing, use one of the accounts added as a test user."
    );
  }
  return description || `Google OAuth failed: ${error}`;
}

function renderCallbackHtml(success: boolean, message: string) {
  const escaped = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const payload = JSON.stringify({
    type: "youtube-channel-connected",
    success,
    message,
  });
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>YouTube Channel Connect</title>
    <style>
      body { font-family: system-ui, sans-serif; background: #111; color: #f5f5f5; display: grid; min-height: 100vh; place-items: center; margin: 0; }
      main { max-width: 520px; padding: 24px; border: 1px solid #333; border-radius: 10px; background: #181818; }
      h1 { font-size: 20px; margin: 0 0 12px; }
      p { color: #cfcfcf; line-height: 1.5; }
    </style>
  </head>
  <body>
    <main>
      <h1>${success ? "YouTube channel connected" : "YouTube connection failed"}</h1>
      <p>${escaped}</p>
      <script>
        if (window.opener) {
          window.opener.postMessage(${payload}, "*");
        }
      </script>
    </main>
  </body>
</html>`;
}
