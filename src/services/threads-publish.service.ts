import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { config } from "../config";
import {
  OAuthState,
  Reel,
  ThreadsChannel,
  ThreadsDataDeletionRequest,
  type IReel,
} from "../models";
import { getErrorMessage } from "../types";
import { recordOperationLog } from "./operation-log.service";
import { buildFirstCommentText } from "./post-comment.service";
import { assertDailyPublishLimit } from "./publish-guard.service";

// ============================================================
// Threads publishing (owned profiles).
//
// SEPARATE Meta app ("Threads" use case) with its own OAuth and its own Graph
// host (graph.threads.net). Scopes: threads_basic, threads_content_publish,
// threads_manage_replies, threads_read_replies. Works for owned accounts under
// Standard Access — no App Review.
//
// 2-step publish (mirrors Instagram):
//   POST /{threads-user}/threads (media_type=VIDEO, video_url=public, text)
//     → creation_id; wait/poll ~status until FINISHED
//   POST /{threads-user}/threads_publish (creation_id) → media id
//
// Treated as a low-effort cross-post: the same 9:16 render + a strong text hook,
// then an optional threaded reply as "Part N". Gated behind THREADS_ENABLED.
// MARKED PENDING LIVE VERIFICATION until a real Threads app/token exists.
// ============================================================

const OAUTH_HOST = "https://graph.threads.net";
const graphBase = () => `https://graph.threads.net/${config.threadsApiVersion}`;
const scopes = ["threads_basic", "threads_content_publish", "threads_manage_replies", "threads_read_replies"];
const THREADS_TEXT_MAX = 500;

interface ThreadsSignedRequestPayload {
  algorithm?: string;
  user_id?: string | number;
}

/** Verify the signed request Meta sends for deauthorization and data deletion.
 * Never accept an unsigned user id: these callbacks authorize destruction of
 * stored OAuth credentials and publish history. */
function threadsUserIdFromSignedRequest(signedRequest: string): string {
  if (!config.threadsAppSecret) {
    throw new Error("THREADS_APP_SECRET is required to verify Threads callbacks");
  }
  const [encodedSignature, encodedPayload] = signedRequest.split(".");
  if (!encodedSignature || !encodedPayload) throw new Error("Invalid Threads signed request");

  const suppliedSignature = Buffer.from(encodedSignature, "base64url");
  const expectedSignature = createHmac("sha256", config.threadsAppSecret)
    .update(encodedPayload)
    .digest();
  if (
    suppliedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    throw new Error("Invalid Threads callback signature");
  }

  let payload: ThreadsSignedRequestPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as ThreadsSignedRequestPayload;
  } catch {
    throw new Error("Invalid Threads callback payload");
  }
  if (payload.algorithm && payload.algorithm.toUpperCase() !== "HMAC-SHA256") {
    throw new Error("Unsupported Threads callback signature algorithm");
  }
  const userId = payload.user_id;
  if (typeof userId !== "string" && typeof userId !== "number") {
    throw new Error("Threads callback did not include a user id");
  }
  return String(userId);
}

/** Remove every piece of locally stored data tied to the deauthorized Threads
 * identity. We deliberately do not delete public Threads posts themselves;
 * this only clears our encrypted OAuth token, profile metadata and local
 * cross-post records. */
async function deleteLocalThreadsUserData(threadsUserId: string): Promise<number> {
  const channels = await ThreadsChannel.find({ threadsUserId }).select({ channelKey: 1 }).lean();
  const channelKeys = channels.map((channel) => channel.channelKey);
  await ThreadsChannel.deleteMany({ threadsUserId });
  if (channelKeys.length) {
    await Reel.updateMany(
      { "threads.channelId": { $in: channelKeys } },
      { $pull: { threads: { channelId: { $in: channelKeys } } } },
    );
  }
  return channelKeys.length;
}

/** Handle Meta's deauthorization callback. Idempotent by design: a retry after
 * successful cleanup still returns success. */
export async function handleThreadsUninstall(signedRequest: string): Promise<void> {
  const threadsUserId = threadsUserIdFromSignedRequest(signedRequest);
  const deletedChannelCount = await deleteLocalThreadsUserData(threadsUserId);
  recordOperationLog({
    scope: "external",
    event: "threads.app_deauthorized",
    message: "Removed local Threads authorization data after deauthorization",
    metadata: { deletedChannelCount },
  });
}

export async function handleThreadsDataDeletion(signedRequest: string): Promise<{
  confirmationCode: string;
  deletedChannelCount: number;
}> {
  const threadsUserId = threadsUserIdFromSignedRequest(signedRequest);
  const deletedChannelCount = await deleteLocalThreadsUserData(threadsUserId);
  const confirmationCode = randomBytes(24).toString("hex");
  await ThreadsDataDeletionRequest.create({
    confirmationCode,
    threadsUserId,
    deletedChannelCount,
    completedAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
  });
  recordOperationLog({
    scope: "external",
    event: "threads.data_deletion_completed",
    message: "Removed local Threads data after a signed deletion request",
    metadata: { deletedChannelCount },
  });
  return { confirmationCode, deletedChannelCount };
}

export async function getThreadsDataDeletionRequest(confirmationCode: string) {
  return ThreadsDataDeletionRequest.findOne({ confirmationCode }).lean();
}

/** The callback host must match the redirect host that Meta is allowed to call.
 * This keeps local ngrok and deployed environments in one configuration value. */
export function threadsCallbackUrl(path: string): string {
  const redirect = new URL(config.threadsRedirectUri);
  return new URL(path, redirect.origin).toString();
}

function tokenKey(): Buffer {
  const material = config.youtubeTokenEncryptionKey || config.threadsAppSecret;
  if (!material) throw new Error("Set YOUTUBE_TOKEN_ENCRYPTION_KEY (or THREADS_APP_SECRET) before connecting Threads profiles");
  return createHash("sha256").update(material).digest();
}
function encryptToken(value: string): string {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", tokenKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
}
function decryptToken(value: string): string {
  const [iv, tag, encrypted] = value.split(".");
  if (!iv || !tag || !encrypted) throw new Error("Stored Threads token is invalid");
  const decipher = createDecipheriv("aes-256-gcm", tokenKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
}
function slug(input: string) { return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || `threads-${Date.now()}`; }
function requireMetaConfig() {
  if (!config.threadsAppId || !config.threadsAppSecret) throw new Error("Set THREADS_APP_ID and THREADS_APP_SECRET before connecting a Threads profile");
}
function requireEnabled() {
  if (!config.threadsEnabled) throw new Error("Threads publishing is disabled. Set THREADS_ENABLED=true after finishing the Threads app setup.");
}

async function graph<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${graphBase()}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  const body = await res.json() as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(body.error?.message || `Threads API failed (${res.status})`);
  return body;
}

export interface PublicThreadsChannel {
  id: string; label: string; threadsUserId: string; username?: string; name?: string;
  profilePictureUrl?: string; niches: string[]; status: "active" | "needs_reauth" | "disabled";
  lastError?: string; lastConnectedAt?: Date;
}

export interface StartThreadsConnectInput { label: string; channelKey?: string; niches?: string[] }

export async function listThreadsChannels(): Promise<PublicThreadsChannel[]> {
  const channels = await ThreadsChannel.find({ status: { $ne: "disabled" } }).sort({ createdAt: 1 }).lean();
  return channels.map((c) => ({ id: c.channelKey, label: c.label, threadsUserId: c.threadsUserId, username: c.username, name: c.name, profilePictureUrl: c.profilePictureUrl, niches: c.niches, status: c.status, lastError: c.lastError, lastConnectedAt: c.lastConnectedAt }));
}

export async function startThreadsConnect(input: StartThreadsConnectInput) {
  requireEnabled(); requireMetaConfig();
  if (!input.label.trim()) throw new Error("Account label is required");
  const state = randomBytes(24).toString("base64url");
  await OAuthState.create({ state, provider: "threads", payload: { label: input.label.trim(), channelKey: input.channelKey?.trim() || slug(input.label), niches: input.niches ?? [], privacyStatus: "public", categoryId: "22" }, expiresAt: new Date(Date.now() + 15 * 60 * 1000) });
  const params = new URLSearchParams({ client_id: config.threadsAppId, redirect_uri: config.threadsRedirectUri, response_type: "code", scope: scopes.join(","), state });
  return { authUrl: `https://threads.net/oauth/authorize?${params}` };
}

export async function completeThreadsConnect(code: string, state: string) {
  requireMetaConfig();
  const pending = await OAuthState.findOne({ state, provider: "threads" });
  if (!pending || pending.expiresAt.getTime() < Date.now()) throw new Error("Threads connect session expired. Start again from the frontend.");
  const exchange = await fetch(`${OAUTH_HOST}/oauth/access_token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: config.threadsAppId, client_secret: config.threadsAppSecret, grant_type: "authorization_code", redirect_uri: config.threadsRedirectUri, code }) });
  const short = await exchange.json() as { access_token?: string; user_id?: string; error_message?: string };
  if (!exchange.ok || !short.access_token) throw new Error(short.error_message || "Threads did not return an access token");
  const longRes = await fetch(`${OAUTH_HOST}/access_token?${new URLSearchParams({ grant_type: "th_exchange_token", client_secret: config.threadsAppSecret, access_token: short.access_token })}`);
  const long = await longRes.json() as { access_token?: string; expires_in?: number; error?: { message?: string } };
  if (!longRes.ok || !long.access_token) throw new Error(long.error?.message || "Could not exchange Threads token");
  const profile = await graph<{ id: string; username?: string; name?: string; threads_profile_picture_url?: string }>(`/me?fields=id,username,name,threads_profile_picture_url`, long.access_token);
  const channelKey = pending.payload.channelKey || slug(pending.payload.label);
  const channel = await ThreadsChannel.findOneAndUpdate(
    { channelKey },
    { channelKey, label: pending.payload.label, threadsUserId: profile.id, username: profile.username, name: profile.name, profilePictureUrl: profile.threads_profile_picture_url, encryptedAccessToken: encryptToken(long.access_token), tokenExpiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : undefined, niches: pending.payload.niches, status: "active", lastError: undefined, lastConnectedAt: new Date() },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
  await pending.deleteOne();
  return channel;
}

export async function cancelThreadsConnect(state?: string) { if (state) await OAuthState.deleteOne({ state, provider: "threads" }); }
export async function disableThreadsChannel(id: string) { await ThreadsChannel.updateOne({ channelKey: id }, { $set: { status: "disabled" } }); }
export async function updateThreadsChannel(id: string, input: { label?: string; niches?: string[] }) {
  const channel = await ThreadsChannel.findOne({ channelKey: id, status: { $ne: "disabled" } });
  if (!channel) throw new Error(`Unknown Threads profile: ${id}`);
  if (input.label !== undefined) { if (!input.label.trim()) throw new Error("Account label cannot be empty"); channel.label = input.label.trim(); }
  if (input.niches !== undefined) channel.niches = input.niches;
  await channel.save();
  return channel;
}

async function resolveThreadsChannel(id: string) {
  if (!id) throw new Error("A Threads profile is required");
  const channel = await ThreadsChannel.findOne({ channelKey: id, status: "active" });
  if (!channel) throw new Error(`Unknown or inactive Threads profile: ${id}`);
  return channel;
}

async function accessTokenFor(channel: InstanceType<typeof ThreadsChannel>): Promise<string> {
  let token = decryptToken(channel.encryptedAccessToken);
  // Long-lived Threads tokens expire (~60 days). Refresh early so scheduled
  // cross-posting does not stop unexpectedly at the boundary.
  if (!channel.tokenExpiresAt || channel.tokenExpiresAt.getTime() - Date.now() < 7 * 24 * 60 * 60 * 1000) {
    const res = await fetch(`${OAUTH_HOST}/refresh_access_token?${new URLSearchParams({ grant_type: "th_refresh_token", access_token: token })}`);
    const refreshed = await res.json() as { access_token?: string; expires_in?: number; error?: { message?: string } };
    if (res.ok && refreshed.access_token) {
      token = refreshed.access_token;
      channel.encryptedAccessToken = encryptToken(token);
      channel.tokenExpiresAt = refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000) : channel.tokenExpiresAt;
      await channel.save();
    }
  }
  return token;
}

/** Prefer a profile-specific branded render when configured; otherwise retain
 * the cheap primary-render cross-post behavior. */
function crosspostVideoUrl(reel: IReel, threadsChannelId: string): string {
  const dedicated = reel.destinations?.find(
    (destination) => destination.platform === "threads" && destination.channelId === threadsChannelId,
  );
  if (dedicated && (dedicated.status !== "ready" || !dedicated.outputUrl)) {
    throw new Error(`${dedicated.channelLabel || "This Threads profile"} has a dedicated branded output that is not ready. Render its outro before publishing.`);
  }
  const url = dedicated?.outputUrl || reel.outputUrl;
  if (!url) throw new Error("This reel has no rendered output to cross-post");
  return url;
}

/** A strong, short text hook for the Threads post body (not the IG caption). */
function threadsText(reel: IReel): string {
  const base = (
    reel.threadsSettings?.text ??
    reel.thumbnailHook ??
    reel.hook ??
    reel.title ??
    reel.topic ??
    ""
  ).trim();
  return base.slice(0, THREADS_TEXT_MAX);
}

async function createThreadsContainer(userId: string, params: Record<string, string>, token: string): Promise<string> {
  const res = await graph<{ id: string }>(`/${userId}/threads`, token, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params),
  });
  return res.id;
}
async function publishThreadsContainer(userId: string, creationId: string, token: string): Promise<string> {
  const res = await graph<{ id: string }>(`/${userId}/threads_publish`, token, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ creation_id: creationId }),
  });
  return res.id;
}
async function waitForThreadsContainer(containerId: string, token: string): Promise<void> {
  const deadline = Date.now() + config.threadsProcessingTimeoutMs;
  // Threads recommends waiting ~30s before publishing a video container.
  await new Promise((r) => setTimeout(r, Math.min(30_000, config.threadsProcessingTimeoutMs)));
  while (Date.now() < deadline) {
    const status = await graph<{ status?: string }>(`/${containerId}?fields=status`, token);
    if (status.status === "FINISHED") return;
    if (status.status === "ERROR" || status.status === "EXPIRED") throw new Error(`Threads media container ${status.status.toLowerCase()}`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
  throw new Error("Threads media processing timed out");
}

/** Publish the reel's rendered 9:16 video to Threads, then optionally add a
 *  threaded "Part N" reply. MARKED PENDING LIVE VERIFICATION. */
export async function publishReelToThreads(reelId: string, channelId: string): Promise<void> {
  requireEnabled();
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  const channel = await resolveThreadsChannel(channelId);
  await assertDailyPublishLimit("threads", channel.channelKey);
  const videoUrl = crosspostVideoUrl(reel, channel.channelKey);
  const text = threadsText(reel);

  const setStatus = async (status: "pending" | "uploading" | "published" | "failed", patch: Record<string, unknown> = {}) => {
    const fields: Record<string, unknown> = { "threads.$.status": status, "threads.$.channelLabel": channel.label, "threads.$.updatedAt": new Date(), ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [`threads.$.${k}`, v])) };
    const result = await Reel.updateOne({ _id: reelId, "threads.channelId": channel.channelKey }, { $set: fields });
    if (!result.matchedCount) await Reel.updateOne({ _id: reelId }, { $push: { threads: { channelId: channel.channelKey, channelLabel: channel.label, status, updatedAt: new Date(), ...patch } } });
  };

  await setStatus("uploading", { message: "Sending video to Threads…", error: undefined });
  try {
    const token = await accessTokenFor(channel);
    const containerId = await createThreadsContainer(channel.threadsUserId, { media_type: "VIDEO", video_url: videoUrl, text }, token);
    await setStatus("uploading", { containerId, message: "Threads is processing the video…" });
    await waitForThreadsContainer(containerId, token);
    const mediaId = await publishThreadsContainer(channel.threadsUserId, containerId, token);
    let permalink: string | undefined;
    try { permalink = (await graph<{ permalink?: string }>(`/${mediaId}?fields=permalink`, token)).permalink; } catch { /* permalink may lag */ }
    await setStatus("published", { containerId, mediaId, url: permalink, error: undefined, message: "Published.", publishedAt: new Date() });
    await ThreadsChannel.updateOne({ _id: channel._id }, { $set: { lastPublishedAt: new Date(), lastError: undefined } });

    // Threaded "Part N" reply (own-media). Replies don't count toward the daily
    // publish cap. Best-effort.
    if (config.threadsAutoFirstReply) {
      try {
        const reply = buildFirstCommentText(reel, "threads", THREADS_TEXT_MAX);
        const replyContainer = await createThreadsContainer(channel.threadsUserId, { media_type: "TEXT", text: reply.text, reply_to_id: mediaId }, token);
        const replyId = await publishThreadsContainer(channel.threadsUserId, replyContainer, token);
        await setStatus("published", { firstCommentStatus: "posted", firstCommentId: replyId, firstCommentError: undefined });
        recordOperationLog({ scope: "external", event: "threads.first_reply_posted", message: "Posted the own-post first reply on the published Thread", reelId, metadata: { channelId: channel.channelKey, mediaId, source: reply.source } });
      } catch (replyError) {
        await setStatus("published", { firstCommentStatus: "failed", firstCommentError: getErrorMessage(replyError) });
        recordOperationLog({ scope: "external", level: "warn", event: "threads.first_reply_failed", message: "Thread published, but the own-post first reply could not be posted", reelId, metadata: { channelId: channel.channelKey, mediaId }, error: replyError });
      }
    }
  } catch (error) {
    const message = getErrorMessage(error);
    await setStatus("failed", { error: message, message: `Failed: ${message}` });
    await ThreadsChannel.updateOne({ _id: channel._id }, { $set: { lastError: message, status: /token|access|oauth/i.test(message) ? "needs_reauth" : channel.status } });
    throw error;
  }
}
