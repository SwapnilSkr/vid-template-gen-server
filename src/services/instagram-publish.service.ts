import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "../config";
import { InstagramChannel, OAuthState, Reel } from "../models";
import { getErrorMessage } from "../types";
import { recordOperationLog } from "./operation-log.service";
import { resolveRenderedPublishDestination } from "./reel-outro.service";

const graphBase = () => `https://graph.instagram.com/${config.instagramApiVersion}`;
const scopes = ["instagram_business_basic", "instagram_business_content_publish"];

export interface StartInstagramConnectInput { label: string; channelKey?: string; niches?: string[] }

export interface PublicInstagramChannel {
  id: string; label: string; instagramUserId: string; username?: string; name?: string;
  profilePictureUrl?: string; niches: string[]; status: "active" | "needs_reauth" | "disabled";
  lastError?: string; lastConnectedAt?: Date;
}

function tokenKey(): Buffer {
  const material = config.youtubeTokenEncryptionKey || config.instagramAppSecret;
  if (!material) throw new Error("Set YOUTUBE_TOKEN_ENCRYPTION_KEY (or INSTAGRAM_APP_SECRET) before connecting Instagram accounts");
  return createHash("sha256").update(material).digest();
}
function encryptToken(value: string): string {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", tokenKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
}
function decryptToken(value: string): string {
  const [iv, tag, encrypted] = value.split(".");
  if (!iv || !tag || !encrypted) throw new Error("Stored Instagram token is invalid");
  const decipher = createDecipheriv("aes-256-gcm", tokenKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
}
function slug(input: string) { return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || `instagram-${Date.now()}`; }
function requireMetaConfig() {
  if (!config.instagramAppId || !config.instagramAppSecret) throw new Error("Set INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET before connecting an Instagram account");
}
async function graph<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${graphBase()}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  const body = await res.json() as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(body.error?.message || `Instagram API failed (${res.status})`);
  return body;
}

export async function listInstagramChannels(): Promise<PublicInstagramChannel[]> {
  const channels = await InstagramChannel.find({ status: { $ne: "disabled" } }).sort({ createdAt: 1 }).lean();
  return channels.map((c) => ({ id: c.channelKey, label: c.label, instagramUserId: c.instagramUserId, username: c.username, name: c.name, profilePictureUrl: c.profilePictureUrl, niches: c.niches, status: c.status, lastError: c.lastError, lastConnectedAt: c.lastConnectedAt }));
}
export async function startInstagramChannelConnect(input: StartInstagramConnectInput) {
  requireMetaConfig(); if (!input.label.trim()) throw new Error("Account label is required");
  const state = randomBytes(24).toString("base64url");
  await OAuthState.create({ state, provider: "instagram", payload: { label: input.label.trim(), channelKey: input.channelKey?.trim() || slug(input.label), niches: input.niches ?? [], privacyStatus: "public", categoryId: "22" }, expiresAt: new Date(Date.now() + 15 * 60 * 1000) });
  const params = new URLSearchParams({ client_id: config.instagramAppId, redirect_uri: config.instagramRedirectUri, response_type: "code", scope: scopes.join(","), state });
  return { authUrl: `https://www.instagram.com/oauth/authorize?${params}` };
}
export async function completeInstagramChannelConnect(code: string, state: string) {
  requireMetaConfig(); const pending = await OAuthState.findOne({ state, provider: "instagram" });
  if (!pending || pending.expiresAt.getTime() < Date.now()) throw new Error("Instagram connect session expired. Start again from the frontend.");
  const exchange = await fetch("https://api.instagram.com/oauth/access_token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: config.instagramAppId, client_secret: config.instagramAppSecret, grant_type: "authorization_code", redirect_uri: config.instagramRedirectUri, code }) });
  const short = await exchange.json() as { access_token?: string; user_id?: string; error_message?: string };
  if (!exchange.ok || !short.access_token) throw new Error(short.error_message || "Instagram did not return an access token");
  const longRes = await fetch(`https://graph.instagram.com/access_token?${new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: config.instagramAppSecret, access_token: short.access_token })}`);
  const long = await longRes.json() as { access_token?: string; expires_in?: number; error?: { message?: string } };
  if (!longRes.ok || !long.access_token) throw new Error(long.error?.message || "Could not exchange Instagram token");
  const profile = await graph<{ id: string; username?: string; name?: string; profile_picture_url?: string }>(`/me?fields=id,username,name,profile_picture_url`, long.access_token);
  const channelKey = pending.payload.channelKey || slug(pending.payload.label);
  const channel = await InstagramChannel.findOneAndUpdate({ channelKey }, { channelKey, label: pending.payload.label, instagramUserId: profile.id, username: profile.username, name: profile.name, profilePictureUrl: profile.profile_picture_url, encryptedAccessToken: encryptToken(long.access_token), tokenExpiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : undefined, niches: pending.payload.niches, status: "active", lastError: undefined, lastConnectedAt: new Date() }, { new: true, upsert: true, setDefaultsOnInsert: true });
  await pending.deleteOne(); return channel;
}
export async function cancelInstagramChannelConnect(state?: string) { if (state) await OAuthState.deleteOne({ state, provider: "instagram" }); }
export async function disableInstagramChannel(id: string) { await InstagramChannel.updateOne({ channelKey: id }, { $set: { status: "disabled" } }); }
export async function updateInstagramChannel(id: string, input: { label?: string; niches?: string[] }) {
  const channel = await InstagramChannel.findOne({ channelKey: id, status: { $ne: "disabled" } });
  if (!channel) throw new Error(`Unknown Instagram channel: ${id}`);
  if (input.label !== undefined) { if (!input.label.trim()) throw new Error("Account label cannot be empty"); channel.label = input.label.trim(); }
  if (input.niches !== undefined) channel.niches = input.niches;
  await channel.save();
  return channel;
}
async function resolveInstagramChannel(id?: string) { if (!id) throw new Error("An Instagram channel is required"); const channel = await InstagramChannel.findOne({ channelKey: id, status: "active" }); if (!channel) throw new Error(`Unknown or inactive Instagram channel: ${id}`); return channel; }
async function accessTokenFor(channel: InstanceType<typeof InstagramChannel>): Promise<string> {
  let token = decryptToken(channel.encryptedAccessToken);
  // Long-lived Instagram tokens expire. Refresh early so scheduled publishing
  // does not unexpectedly stop at the 60-day boundary.
  if (!channel.tokenExpiresAt || channel.tokenExpiresAt.getTime() - Date.now() < 7 * 24 * 60 * 60 * 1000) {
    const res = await fetch(`https://graph.instagram.com/refresh_access_token?${new URLSearchParams({ grant_type: "ig_refresh_token", access_token: token })}`);
    const refreshed = await res.json() as { access_token?: string; expires_in?: number; error?: { message?: string } };
    if (!res.ok || !refreshed.access_token) throw new Error(refreshed.error?.message || "Instagram token refresh failed; reconnect this account");
    token = refreshed.access_token;
    channel.encryptedAccessToken = encryptToken(token);
    channel.tokenExpiresAt = refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000) : channel.tokenExpiresAt;
    await channel.save();
  }
  return token;
}
export async function publishReelToInstagram(reelId: string, channelId?: string): Promise<void> {
  const reel = await Reel.findById(reelId); if (!reel) throw new Error("Reel not found");
  const destination = resolveRenderedPublishDestination(reel, "instagram", channelId);
  const channel = await resolveInstagramChannel(channelId ?? destination.channelId);
  recordOperationLog({
    scope: "system",
    event: "publish.destination_output_selected",
    message: "Selected the destination-specific rendered output for Instagram publishing",
    reelId,
    metadata: { platform: "instagram", channelId: channel.channelKey, destinationId: destination.id },
  });
  const priorPublish = reel.instagram.find((publish) => publish.channelId === channel.channelKey);
  // Atomic positional updates are essential here: review metadata and multiple
  // destination workers can update the same reel concurrently. Saving the
  // original document after Meta's processing wait caused VersionError races.
  const setStatus = async (status: "pending" | "uploading" | "published" | "failed", patch: Record<string, unknown> = {}) => {
    const fields: Record<string, unknown> = {
      "instagram.$.status": status,
      "instagram.$.channelLabel": channel.label,
      "instagram.$.updatedAt": new Date(),
      ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [`instagram.$.${key}`, value])),
    };
    const result = await Reel.updateOne({ _id: reelId, "instagram.channelId": channel.channelKey }, { $set: fields });
    if (!result.matchedCount) {
      await Reel.updateOne({ _id: reelId }, { $push: { instagram: { channelId: channel.channelKey, channelLabel: channel.label, status, updatedAt: new Date(), ...patch } } });
    }
  };
  await setStatus("uploading", { message: "Preparing Reel for Instagram…", error: undefined });
  try {
    // Instagram copy is deliberately independent from the YouTube review
    // package. An absent Instagram caption means an intentionally blank
    // Instagram caption; it must never inherit a YouTube description/title.
    const caption = (reel.instagramSettings?.caption ?? "").slice(0, 2200);
    recordOperationLog({
      scope: "system",
      event: "publish.instagram_caption_selected",
      message: "Selected the saved platform-specific Instagram caption",
      reelId,
      metadata: { channelId: channel.channelKey, source: "instagramSettings", length: caption.length },
    });
    const token = await accessTokenFor(channel);
    let containerId = priorPublish?.containerId;
    if (containerId) {
      await setStatus("uploading", { message: "Resuming Instagram media processing…", containerId });
    } else {
      await setStatus("uploading", { message: "Sending Reel to Instagram…" });
      // The current Vertical Cover is an overlay asset, not guaranteed to be a
      // flattened 9:16 image. Sending it as Meta's native cover can produce a
      // text-only cover, so let Instagram choose from the final MP4 for now.
      const create = await graph<{ id: string }>(`/${channel.instagramUserId}/media`, token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ media_type: "REELS", video_url: destination.outputUrl, caption, share_to_feed: reel.instagramSettings?.shareToFeed ?? true }) });
      containerId = create.id;
      // Persist this before polling. A worker restart or timeout can now
      // continue the accepted container without creating a duplicate post.
      await setStatus("uploading", { message: "Instagram accepted the Reel — processing…", containerId });
    }
    let ready = false;
    // Poll steadily for up to ten minutes by default. The worker lock is one
    // hour, so slower Meta transcoding is safe without making the queue stall.
    const deadline = Date.now() + config.instagramProcessingTimeoutMs;
    let checks = 0;
    while (Date.now() < deadline) {
      const waitMs = Math.min(checks === 0 ? 5_000 : 30_000, Math.max(0, deadline - Date.now()));
      if (waitMs <= 0) break;
      checks += 1;
      const remainingMinutes = Math.max(0, Math.ceil((deadline - Date.now()) / 60_000));
      await setStatus("uploading", { message: `Instagram is processing the video… (check ${checks}; up to ${remainingMinutes} min remaining)`, containerId });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      const status = await graph<{ status_code?: string }>(`/${containerId}?fields=status_code`, token);
      if (status.status_code === "FINISHED") { ready = true; break; }
      if (status.status_code === "ERROR" || status.status_code === "EXPIRED") throw new Error(`Instagram media container ${status.status_code.toLowerCase()}`);
    }
    if (!ready) throw new Error("Instagram media processing timed out");
    await setStatus("uploading", { message: "Instagram finished processing — publishing Reel…" });
    const published = await graph<{ id: string }>(`/${channel.instagramUserId}/media_publish`, token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ creation_id: containerId }) });
    // Publishing has succeeded even if Meta needs another moment to expose its
    // permalink. Do not incorrectly report a duplicate-risking failure here.
    let permalink: string | undefined;
    try {
      permalink = (await graph<{ permalink?: string }>(`/${published.id}?fields=permalink`, token)).permalink;
    } catch (error) {
      console.warn(`Instagram Reel ${published.id} published before permalink was available: ${getErrorMessage(error)}`);
      recordOperationLog({
        scope: "external",
        level: "warn",
        event: "instagram.permalink_pending",
        message: "Instagram publish succeeded before its permalink was available",
        reelId,
        metadata: { mediaId: published.id },
        error,
      });
    }
    await setStatus("published", { containerId, mediaId: published.id, url: permalink, error: undefined, message: permalink ? "Published." : "Published — Instagram permalink is still becoming available.", publishedAt: new Date() }); await InstagramChannel.updateOne({ _id: channel._id }, { $set: { lastPublishedAt: new Date(), lastError: undefined } });
  } catch (error) { const message = getErrorMessage(error); await setStatus("failed", { error: message, message: `Failed: ${message}` }); await InstagramChannel.updateOne({ _id: channel._id }, { $set: { lastError: message, status: /token|access/i.test(message) ? "needs_reauth" : channel.status } }); throw error; }
}
