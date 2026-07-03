import type { Context } from "elysia";
import {
  completeYouTubeChannelConnect,
  disableYouTubeChannel,
  listAllYouTubePublishChannels,
  startYouTubeChannelConnect,
} from "../services";
import type {
  TConnectYouTubeBody,
  TIdParams,
  TYouTubeCallbackQuery,
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
    set.headers["content-type"] = "text/html; charset=utf-8";
    return renderCallbackHtml(false, query.error);
  }
  if (!query.code || !query.state) {
    set.headers["content-type"] = "text/html; charset=utf-8";
    return renderCallbackHtml(false, "Missing OAuth code/state.");
  }

  try {
    const channel = await completeYouTubeChannelConnect(query.code, query.state);
    set.headers["content-type"] = "text/html; charset=utf-8";
    return renderCallbackHtml(true, `Connected ${channel.label}. You can close this tab.`);
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

function renderCallbackHtml(success: boolean, message: string) {
  const escaped = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
          window.opener.postMessage({ type: "youtube-channel-connected", success: ${success} }, "*");
        }
      </script>
    </main>
  </body>
</html>`;
}
