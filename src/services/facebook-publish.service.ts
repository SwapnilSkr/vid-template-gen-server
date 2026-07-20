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
  FacebookDataDeletionRequest,
  FacebookPage,
  OAuthState,
  OwnedMetricSnapshot,
  PerformanceEvidenceCard,
  Reel,
  type IReel,
} from "../models";
import { getErrorMessage } from "../types";
import { recordOperationLog } from "./operation-log.service";
import { buildFirstCommentText } from "./post-comment.service";
import { assertDailyPublishLimit } from "./publish-guard.service";

// ============================================================
// Facebook Reels publishing (Page publishing).
//
// Works under Meta Standard Access for Pages the user administers — NO App
// Review — once the Page/user is added to the Meta app and the app requests:
//   pages_show_list, pages_read_engagement, pages_manage_posts
//   (+ pages_manage_engagement for the own-post first comment).
//
// 3-phase upload on /{page-id}/video_reels:
//   1) upload_phase=start           → { video_id, upload_url }
//   2) upload the media to upload_url (rupload.facebook.com). We use the
//      hosted-URL path (header `file_url`) so Facebook pulls the already-public
//      S3/CDN render instead of us re-uploading bytes.
//   3) upload_phase=finish, video_id, video_state=PUBLISHED (+ description).
//
// Gated behind FACEBOOK_REELS_ENABLED. Structurally parallel to the Instagram
// adapter. Marked pending live verification until a real Page + app exist.
// ============================================================

const graphBase = () => `https://graph.facebook.com/${config.facebookApiVersion}`;
const ruploadBase = () => `https://rupload.facebook.com/video-upload/${config.facebookApiVersion}`;
const scopes = ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "pages_manage_engagement", "read_insights", "business_management"];

interface FacebookSignedRequestPayload {
  algorithm?: string;
  user_id?: string | number;
}

/** Verifies the signed request Meta sends to the Facebook Login for Business
 * deauthorize and data-deletion callbacks. Never accept an unsigned identity
 * because these endpoints authorize removal of encrypted Page tokens. */
function facebookUserIdFromSignedRequest(signedRequest: string): string {
  if (!config.facebookAppSecret) {
    throw new Error("FACEBOOK_APP_SECRET is required to verify Facebook lifecycle callbacks");
  }
  const [encodedSignature, encodedPayload] = signedRequest.split(".");
  if (!encodedSignature || !encodedPayload) throw new Error("Invalid Facebook signed request");

  const suppliedSignature = Buffer.from(encodedSignature, "base64url");
  const expectedSignature = createHmac("sha256", config.facebookAppSecret)
    .update(encodedPayload)
    .digest();
  if (
    suppliedSignature.length !== expectedSignature.length
    || !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    throw new Error("Invalid Facebook callback signature");
  }

  let payload: FacebookSignedRequestPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as FacebookSignedRequestPayload;
  } catch {
    throw new Error("Invalid Facebook callback payload");
  }
  if (payload.algorithm && payload.algorithm.toUpperCase() !== "HMAC-SHA256") {
    throw new Error("Unsupported Facebook callback signature algorithm");
  }
  if (typeof payload.user_id !== "string" && typeof payload.user_id !== "number") {
    throw new Error("Facebook callback did not include a user id");
  }
  return String(payload.user_id);
}

/** Delete the locally-held Page OAuth data tied to a Facebook user. Published
 * Facebook content itself stays on Facebook; only this app's credentials,
 * Page metadata, and local routing records are removed. */
async function deleteLocalFacebookUserData(facebookUserId: string): Promise<number> {
  const pages = await FacebookPage.find({ userId: facebookUserId }).select({ channelKey: 1 }).lean();
  const channelKeys = pages.map((page) => page.channelKey);
  await FacebookPage.deleteMany({ userId: facebookUserId });
  if (channelKeys.length) {
    await Reel.updateMany(
      {
        $or: [
          { "facebook.channelId": { $in: channelKeys } },
          { destinations: { $elemMatch: { platform: "facebook", channelId: { $in: channelKeys } } } },
        ],
      },
      {
        $pull: {
          facebook: { channelId: { $in: channelKeys } },
          destinations: { platform: "facebook", channelId: { $in: channelKeys } },
        },
      },
    );
    await OwnedMetricSnapshot.deleteMany({ platform: "facebook", "account.key": { $in: channelKeys } });
    // Aggregate cards may contain samples from several Pages. Remove the
    // Facebook cache wholesale; the next explicit Performance sync rebuilds
    // it only from the Pages the app still holds authorization for.
    await PerformanceEvidenceCard.deleteMany({ platform: "facebook" });
  }
  return channelKeys.length;
}

/** Meta's Facebook Login deauthorization callback. Safe to retry. */
export async function handleFacebookUninstall(signedRequest: string): Promise<void> {
  const facebookUserId = facebookUserIdFromSignedRequest(signedRequest);
  const deletedPageCount = await deleteLocalFacebookUserData(facebookUserId);
  recordOperationLog({
    scope: "external",
    event: "facebook.app_deauthorized",
    message: "Removed local Facebook Page authorization data after deauthorization",
    metadata: { deletedPageCount },
  });
}

/** Meta's Facebook Login data-deletion callback. It returns a receipt that
 * Meta and the account owner can open after the deletion is complete. */
export async function handleFacebookDataDeletion(signedRequest: string): Promise<{
  confirmationCode: string;
  deletedPageCount: number;
}> {
  const facebookUserId = facebookUserIdFromSignedRequest(signedRequest);
  const deletedPageCount = await deleteLocalFacebookUserData(facebookUserId);
  const confirmationCode = randomBytes(24).toString("hex");
  await FacebookDataDeletionRequest.create({
    confirmationCode,
    facebookUserId,
    deletedPageCount,
    completedAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
  });
  recordOperationLog({
    scope: "external",
    event: "facebook.data_deletion_completed",
    message: "Removed local Facebook data after a signed deletion request",
    metadata: { deletedPageCount },
  });
  return { confirmationCode, deletedPageCount };
}

export async function getFacebookDataDeletionRequest(confirmationCode: string) {
  return FacebookDataDeletionRequest.findOne({ confirmationCode }).lean();
}

/** Lifecycle callback URLs share the configured OAuth callback's origin. */
export function facebookCallbackUrl(path: string): string {
  const redirect = new URL(config.facebookRedirectUri);
  return new URL(path, redirect.origin).toString();
}

function tokenKey(): Buffer {
  const material = config.youtubeTokenEncryptionKey || config.facebookAppSecret;
  if (!material) throw new Error("Set YOUTUBE_TOKEN_ENCRYPTION_KEY (or FACEBOOK_APP_SECRET) before connecting Facebook Pages");
  return createHash("sha256").update(material).digest();
}
function encryptToken(value: string): string {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", tokenKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
}
function decryptToken(value: string): string {
  const [iv, tag, encrypted] = value.split(".");
  if (!iv || !tag || !encrypted) throw new Error("Stored Facebook token is invalid");
  const decipher = createDecipheriv("aes-256-gcm", tokenKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
}
function slug(input: string) { return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || `facebook-${Date.now()}`; }
function requireMetaConfig() {
  if (!config.facebookAppId || !config.facebookAppSecret) throw new Error("Set FACEBOOK_APP_ID and FACEBOOK_APP_SECRET from the parent Meta app that owns your Facebook Login for Business configuration before connecting a Facebook Page");
  if (!config.facebookLoginConfigId) throw new Error("Set FACEBOOK_LOGIN_CONFIG_ID from Facebook Login for Business → Configurations before connecting a Facebook Page");
}
function requireEnabled() {
  if (!config.facebookReelsEnabled) throw new Error("Facebook Reels publishing is disabled. Set FACEBOOK_REELS_ENABLED=true after finishing Meta app setup.");
}

async function graph<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${graphBase()}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  const body = await res.json() as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(body.error?.message || `Facebook API failed (${res.status})`);
  return body;
}

export interface PublicFacebookPage {
  id: string; label: string; pageId: string; name?: string; category?: string;
  pictureUrl?: string; niches: string[]; status: "active" | "needs_reauth" | "disabled";
  lastError?: string; lastConnectedAt?: Date;
}

export interface StartFacebookConnectInput { label: string; channelKey?: string; niches?: string[] }

export async function listFacebookPages(): Promise<PublicFacebookPage[]> {
  const pages = await FacebookPage.find({ status: { $ne: "disabled" } }).sort({ createdAt: 1 }).lean();
  return pages.map((p) => ({ id: p.channelKey, label: p.label, pageId: p.pageId, name: p.name, category: p.category, pictureUrl: p.pictureUrl, niches: p.niches, status: p.status, lastError: p.lastError, lastConnectedAt: p.lastConnectedAt }));
}

export async function startFacebookConnect(input: StartFacebookConnectInput) {
  requireEnabled(); requireMetaConfig();
  if (!input.label.trim()) throw new Error("Account label is required");
  const state = randomBytes(24).toString("base64url");
  await OAuthState.create({ state, provider: "facebook", payload: { label: input.label.trim(), channelKey: input.channelKey?.trim() || slug(input.label), niches: input.niches ?? [], privacyStatus: "public", categoryId: "22" }, expiresAt: new Date(Date.now() + 15 * 60 * 1000) });
  const params = new URLSearchParams({
    client_id: config.facebookAppId,
    redirect_uri: config.facebookRedirectUri,
    response_type: "code",
    // Business Login selects assets/permissions through its saved
    // configuration. Keep the explicit scopes too, so the requested Page
    // permissions remain transparent and work with Meta's code flow.
    scope: scopes.join(","),
    config_id: config.facebookLoginConfigId,
    override_default_response_type: "true",
    state,
  });
  return { authUrl: `https://www.facebook.com/${config.facebookApiVersion}/dialog/oauth?${params}` };
}

/** Exchange the code, upgrade to a long-lived user token, then persist every
 *  Page the user administers (each Page returns its own long-lived token). */
export async function completeFacebookConnect(code: string, state: string): Promise<{ connected: number; primaryLabel: string }> {
  requireMetaConfig();
  const pending = await OAuthState.findOne({ state, provider: "facebook" });
  if (!pending || pending.expiresAt.getTime() < Date.now()) throw new Error("Facebook connect session expired. Start again from the frontend.");
  const shortRes = await fetch(`${graphBase()}/oauth/access_token?${new URLSearchParams({ client_id: config.facebookAppId, client_secret: config.facebookAppSecret, redirect_uri: config.facebookRedirectUri, code })}`);
  const short = await shortRes.json() as { access_token?: string; error?: { message?: string } };
  if (!shortRes.ok || !short.access_token) throw new Error(short.error?.message || "Facebook did not return an access token");
  const longRes = await fetch(`${graphBase()}/oauth/access_token?${new URLSearchParams({ grant_type: "fb_exchange_token", client_id: config.facebookAppId, client_secret: config.facebookAppSecret, fb_exchange_token: short.access_token })}`);
  const long = await longRes.json() as { access_token?: string; expires_in?: number; error?: { message?: string } };
  if (!longRes.ok || !long.access_token) throw new Error(long.error?.message || "Could not exchange Facebook token");
  const me = await graph<{ id: string }>(`/me?fields=id`, long.access_token);
  interface FacebookPageToken {
    id: string;
    name?: string;
    access_token?: string;
    category?: string;
    picture?: { data?: { url?: string } };
  }
  const pagesRes = await graph<{ data?: FacebookPageToken[] }>(`/me/accounts?fields=id,name,access_token,category,picture`, long.access_token);
  let pages = (pagesRes.data ?? []).filter((page) => Boolean(page.access_token));
  // Pages owned through a Meta Business Portfolio can be omitted from
  // /me/accounts even when the user has task access. Business Login with
  // business_management exposes those through this assigned-page edge.
  if (!pages.length) {
    const assigned = await graph<{ data?: FacebookPageToken[] }>(`/me/assigned_pages?fields=id,name,access_token,category,picture`, long.access_token)
      .then((response) => response.data ?? [])
      .catch(() => []);
    pages = assigned.filter((page) => Boolean(page.access_token));
  }
  if (!pages.length) {
    const permissions = await graph<{ data?: { permission?: string; status?: string }[] }>("/me/permissions", long.access_token)
      .then((response) => (response.data ?? [])
        .filter((entry) => entry.status === "granted")
        .map((entry) => entry.permission)
        .filter((permission): permission is string => Boolean(permission)))
      .catch(() => []);
    const granted = permissions.length ? ` Meta granted: ${permissions.join(", ")}.` : "";
    throw new Error(
      "Meta returned no Pages for this Facebook login. In Facebook Login for Business → Configurations, add Facebook Pages plus business_management, pages_show_list, pages_read_engagement, and pages_manage_posts. Then log in with the Facebook profile that has full control of the Page and reconnect."
      + granted,
    );
  }
  const expiresAt = long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : undefined;
  for (const page of pages) {
    if (!page.access_token) continue;
    const channelKey = slug(page.name || `page-${page.id}`);
    await FacebookPage.findOneAndUpdate(
      { pageId: page.id },
      { channelKey, label: page.name || pending.payload.label, pageId: page.id, name: page.name, userId: me.id, category: page.category, pictureUrl: page.picture?.data?.url, encryptedAccessToken: encryptToken(page.access_token), tokenExpiresAt: expiresAt, niches: pending.payload.niches, status: "active", lastError: undefined, lastConnectedAt: new Date() },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
  }
  await pending.deleteOne();
  return { connected: pages.length, primaryLabel: pages[0].name || pending.payload.label };
}

export async function cancelFacebookConnect(state?: string) { if (state) await OAuthState.deleteOne({ state, provider: "facebook" }); }
export async function disableFacebookPage(id: string) { await FacebookPage.updateOne({ channelKey: id }, { $set: { status: "disabled" } }); }
export async function updateFacebookPage(id: string, input: { label?: string; niches?: string[] }) {
  const page = await FacebookPage.findOne({ channelKey: id, status: { $ne: "disabled" } });
  if (!page) throw new Error(`Unknown Facebook Page: ${id}`);
  if (input.label !== undefined) { if (!input.label.trim()) throw new Error("Account label cannot be empty"); page.label = input.label.trim(); }
  if (input.niches !== undefined) page.niches = input.niches;
  await page.save();
  return page;
}

async function resolveFacebookPage(id: string) {
  if (!id) throw new Error("A Facebook Page is required");
  const page = await FacebookPage.findOne({ channelKey: id, status: "active" });
  if (!page) throw new Error(`Unknown or inactive Facebook Page: ${id}`);
  return page;
}

function facebookInsightNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object" && "value" in value) return facebookInsightNumber((value as { value?: unknown }).value);
  return undefined;
}

/**
 * Facebook's Page Reel insight catalogue differs by Page, API version and
 * rollout. Keep this capability-based: a rejected metric does not turn into a
 * fake zero or fail analytics for the rest of the user's destinations.
 */
export async function fetchOwnedFacebookReelMetrics(channelId: string, videoId: string): Promise<{
  accountLabel: string;
  platformAccountId: string;
  metrics: Record<string, number>;
  available: string[];
  limitations: string[];
  provider: Record<string, unknown>;
}> {
  const page = await resolveFacebookPage(channelId);
  const token = decryptToken(page.encryptedAccessToken);
  const requested = (Bun.env.FACEBOOK_REELS_INSIGHT_METRICS ?? "post_video_views,post_video_view_time,post_video_avg_time_watched")
    .split(",").map((value) => value.trim()).filter(Boolean);
  try {
    const response = await graph<{ data?: { name?: string; value?: unknown; values?: { value?: unknown }[] }[] }>(
      `/${videoId}/video_insights?metric=${requested.join(",")}`,
      token,
    );
    const metrics: Record<string, number> = {};
    for (const item of response.data ?? []) {
      const value = facebookInsightNumber(item.value ?? item.values?.[0]?.value);
      if (item.name && value !== undefined) metrics[item.name] = value;
    }
    return {
      accountLabel: page.label,
      platformAccountId: page.pageId,
      metrics,
      available: Object.keys(metrics),
      limitations: requested.filter((name) => metrics[name] === undefined).map((name) => `Facebook did not return ${name} for this Reel.`),
      provider: { returnedMetrics: response.data ?? [], requestedMetrics: requested },
    };
  } catch (error) {
    return {
      accountLabel: page.label,
      platformAccountId: page.pageId,
      metrics: {},
      available: [],
      limitations: [`Facebook insight capability could not be verified: ${getErrorMessage(error)}`],
      provider: { requestedMetrics: requested },
    };
  }
}

/** Prefer a Page-specific branded render when the creator explicitly added
 * one. Otherwise Facebook remains a lightweight cross-post of the primary
 * final, preserving the old no-extra-render default. */
function crosspostVideoUrl(reel: IReel, pageChannelId: string): string {
  const dedicated = reel.destinations?.find(
    (destination) => destination.platform === "facebook" && destination.channelId === pageChannelId,
  );
  if (dedicated && (dedicated.status !== "ready" || !dedicated.outputUrl)) {
    throw new Error(`${dedicated.channelLabel || "This Facebook Page"} has a dedicated branded output that is not ready. Render its outro before publishing.`);
  }
  const url = dedicated?.outputUrl || reel.outputUrl;
  if (!url) throw new Error("This reel has no rendered output to cross-post");
  return url;
}

/** Publish the reel's rendered 9:16 video to a Facebook Page as a Reel.
 *  MARKED PENDING LIVE VERIFICATION: the 3-phase contract is implemented to
 *  Meta's docs but has not been exercised against a real Page/token. */
export async function publishReelToFacebook(reelId: string, channelId: string): Promise<void> {
  requireEnabled();
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  const page = await resolveFacebookPage(channelId);
  await assertDailyPublishLimit("facebook", page.channelKey);
  const videoUrl = crosspostVideoUrl(reel, page.channelKey);
  // Keep Facebook copy independent from the Instagram caption. A creator can
  // override the inherited YouTube-style description in Studio before posting.
  const description = (
    reel.facebookSettings?.description ??
    reel.review?.description ??
    reel.title ??
    reel.hook ??
    reel.topic ??
    ""
  ).trim().slice(0, 2_200);

  const setStatus = async (status: "pending" | "uploading" | "published" | "failed", patch: Record<string, unknown> = {}) => {
    const fields: Record<string, unknown> = { "facebook.$.status": status, "facebook.$.channelLabel": page.label, "facebook.$.updatedAt": new Date(), ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [`facebook.$.${k}`, v])) };
    const result = await Reel.updateOne({ _id: reelId, "facebook.channelId": page.channelKey }, { $set: fields });
    if (!result.matchedCount) await Reel.updateOne({ _id: reelId }, { $push: { facebook: { channelId: page.channelKey, channelLabel: page.label, status, updatedAt: new Date(), ...patch } } });
  };

  await setStatus("uploading", { message: "Starting Facebook Reels upload…", error: undefined });
  const token = decryptToken(page.encryptedAccessToken);
  try {
    // Phase 1: start
    const start = await graph<{ video_id?: string; upload_url?: string }>(`/${page.pageId}/video_reels`, token, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ upload_phase: "start" }),
    });
    if (!start.video_id) throw new Error("Facebook did not return a video_id for the Reel upload");
    const videoId = start.video_id;
    await setStatus("uploading", { videoId, message: "Facebook accepted the upload — transferring media…" });

    // Phase 2: hosted-URL upload (Facebook pulls the public render).
    const uploadRes = await fetch(`${ruploadBase()}/${videoId}`, {
      method: "POST",
      headers: { Authorization: `OAuth ${token}`, file_url: videoUrl },
    });
    if (!uploadRes.ok) {
      const uploadBody = await uploadRes.json().catch(() => ({})) as { error?: { message?: string } };
      throw new Error(uploadBody.error?.message || `Facebook Reels media transfer failed (${uploadRes.status})`);
    }

    // Phase 3: finish + publish
    const finish = await graph<{ success?: boolean; post_id?: string }>(`/${page.pageId}/video_reels`, token, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ upload_phase: "finish", video_id: videoId, video_state: "PUBLISHED", description }),
    });
    void finish;
    const url = `https://www.facebook.com/reel/${videoId}`;
    const publishedAt = new Date();
    await setStatus("published", { videoId, url, error: undefined, message: "Published.", publishedAt });
    await FacebookPage.updateOne({ _id: page._id }, { $set: { lastPublishedAt: new Date(), lastError: undefined } });
    void import("./owned-analytics.service")
      .then(({ registerOwnedPublication }) => registerOwnedPublication(reel, {
        platform: "facebook", accountKey: page.channelKey, accountLabel: page.label,
        mediaId: videoId, url, publishedAt, firstCommentKind: "none",
      }))
      .catch((error) => console.warn(`Could not freeze Facebook publication analytics context: ${getErrorMessage(error)}`));

    if (config.facebookAutoFirstComment) {
      try {
        const comment = buildFirstCommentText(reel, "facebook", 8_000);
        const commentId = await createFacebookComment(videoId, comment.text, token);
        await setStatus("published", { firstCommentStatus: "posted", firstCommentId: commentId, firstCommentError: undefined });
        recordOperationLog({ scope: "external", event: "facebook.first_comment_posted", message: "Posted the own-post first comment on the published Reel", reelId, metadata: { channelId: page.channelKey, videoId, source: comment.source } });
      } catch (commentError) {
        await setStatus("published", { firstCommentStatus: "failed", firstCommentError: getErrorMessage(commentError) });
        recordOperationLog({ scope: "external", level: "warn", event: "facebook.first_comment_failed", message: "Facebook Reel published, but the own-post first comment could not be posted", reelId, metadata: { channelId: page.channelKey, videoId: start.video_id }, error: commentError });
      }
    }
    // A verified Part 1/Part 2 link is useful independently of the optional
    // discussion question. Never make the series-navigation layer disappear
    // merely because a creator turns automatic first comments off.
    void import("./series-navigation-comment.service")
      .then(({ reconcileSeriesNavigationComments }) => reconcileSeriesNavigationComments(reelId, "facebook", page.channelKey))
      .catch((error) => console.warn(`Could not reconcile Facebook series-navigation comments: ${getErrorMessage(error)}`));
  } catch (error) {
    const message = getErrorMessage(error);
    await setStatus("failed", { error: message, message: `Failed: ${message}` });
    await FacebookPage.updateOne({ _id: page._id }, { $set: { lastError: message, status: /token|access|oauth/i.test(message) ? "needs_reauth" : page.status } });
    throw error;
  }
}

async function createFacebookComment(objectId: string, message: string, token: string): Promise<string> {
  const res = await graph<{ id: string }>(`/${objectId}/comments`, token, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ message }),
  });
  return res.id;
}

export async function postFacebookSeriesNavigationComment(channelId: string, videoId: string, text: string): Promise<string> {
  const page = await resolveFacebookPage(channelId);
  return createFacebookComment(videoId, text, decryptToken(page.encryptedAccessToken));
}

/** Manually (re)post the own-post first comment for a published Facebook Reel. */
export async function postFacebookFirstComment(reelId: string, channelId: string): Promise<string> {
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  const publish = reel.facebook.find((p) => p.channelId === channelId && p.status === "published");
  if (!publish?.videoId) throw new Error("This reel has no published Facebook Reel on that Page yet");
  const page = await resolveFacebookPage(channelId);
  const token = decryptToken(page.encryptedAccessToken);
  const comment = buildFirstCommentText(reel, "facebook", 8_000);
  const commentId = await createFacebookComment(publish.videoId, comment.text, token);
  await Reel.updateOne({ _id: reelId, "facebook.channelId": channelId }, { $set: { "facebook.$.firstCommentStatus": "posted", "facebook.$.firstCommentId": commentId, "facebook.$.firstCommentError": undefined } });
  void import("./series-navigation-comment.service")
    .then(({ reconcileSeriesNavigationComments }) => reconcileSeriesNavigationComments(reelId, "facebook", channelId))
    .catch((error) => console.warn(`Could not reconcile Facebook series-navigation comments: ${getErrorMessage(error)}`));
  return commentId;
}
