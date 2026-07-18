import { Resvg } from "@resvg/resvg-js";
import { createHash } from "node:crypto";
import ffmpeg from "fluent-ffmpeg";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import {
  FacebookPage,
  InstagramChannel,
  ThreadsChannel,
  YouTubeChannel,
  type IReel,
  type IReelDestination,
  type IOutroSettings,
} from "../models";
import { ensureDir, generateFilename } from "../utils";
import { generateNarration, type MediaUsageCallback } from "./openrouter-media.service";
import { recordOperationLog } from "./operation-log.service";

const W = 1080;
const H = 1920;
const FPS = 30;

/** Emergency fallback only. Planning normally persists a story-and-part
 * specific prompt from the cheap editorial model before any outro is rendered. */
export const DEFAULT_OUTRO_COMMENT_PROMPT =
  "What would you have done in this situation?";

export interface OutroBrand {
  channelName: string;
  channelHandle?: string;
  logoUrl?: string;
  kind: "reddit" | "horror";
  platform: "youtube" | "instagram" | "facebook" | "threads";
  commentPrompt: string;
  spokenLine?: string;
  title?: string;
  subtitle?: string;
  cta?: string;
  footer?: string;
}

export interface OutroTts {
  model?: string;
  voice?: string;
  format?: "mp3" | "pcm";
}

/** The channel/copy fields brand resolution reads — a reel or one of its destinations. */
export interface OutroSource {
  outroChannelId?: string;
  outroInstagramChannelId?: string;
  outroFacebookPageId?: string;
  outroThreadsChannelId?: string;
  outro?: IOutroSettings;
}

/** Map a destination onto the OutroSource shape resolveOutroBrand consumes. */
export function destinationOutroSource(dest: IReelDestination): OutroSource {
  return {
    outroChannelId: dest.platform === "youtube" ? dest.channelId : undefined,
    outroInstagramChannelId: dest.platform === "instagram" ? dest.channelId : undefined,
    outroFacebookPageId: dest.platform === "facebook" ? dest.channelId : undefined,
    outroThreadsChannelId: dest.platform === "threads" ? dest.channelId : undefined,
    outro: dest.outro,
  };
}

function platformForOutroSource(source: OutroSource): OutroBrand["platform"] {
  if (source.outroInstagramChannelId) return "instagram";
  if (source.outroFacebookPageId) return "facebook";
  if (source.outroThreadsChannelId) return "threads";
  return "youtube";
}

function defaultCtaForPlatform(platform: OutroBrand["platform"]): "FOLLOW" | "SUBSCRIBE" {
  return platform === "youtube" ? "SUBSCRIBE" : "FOLLOW";
}

/**
 * The implicit PRIMARY destination, synthesized from the reel's legacy `outro*`
 * fields. It always renders to the canonical `${reelId}.mp4` and mirrors
 * `reel.outputUrl` / `reel.outroAudioUrl`, so existing reels keep working with no
 * migration. Its outro is edited the legacy way (updateReelSettings), not via the
 * destination endpoints — those manage the EXTRA channels in `reel.destinations`.
 */
export function primaryDestination(reel: IReel): IReelDestination {
  const platform: "youtube" | "instagram" = reel.outroInstagramChannelId ? "instagram" : "youtube";
  return {
    id: "primary",
    platform,
    channelId: reel.outroInstagramChannelId || reel.outroChannelId || "",
    outro: reel.outro,
    skipBrandedOutro: reel.skipBrandedOutro,
    outroAudioUrl: reel.outroAudioUrl,
    outroAudioSignature: reel.outroAudioSignature,
    outputUrl: reel.outputUrl,
    status: reel.outputUrl ? "ready" : "pending",
    createdAt: reel.createdAt ?? new Date(),
  };
}

/** Every destination to render/publish: the primary plus any extra channels. */
export function resolveReelDestinations(reel: IReel): IReelDestination[] {
  return [primaryDestination(reel), ...(reel.destinations ?? [])];
}

/**
 * Invalidate rendered final videos when their shared body, narration, or
 * destination-specific outro has changed. The values returned are no longer
 * referenced and must be deleted from S3 only after the caller saves `reel`.
 *
 * This deliberately updates the canonical primary output as well as extras:
 * a ready flag must always mean "this exact channel's current final video",
 * never merely "a video used to exist for this channel".
 */
export function invalidateFinalDestinationRenders(
  reel: IReel,
  options: {
    reason: string;
    includePrimary?: boolean;
    includeExtras?: boolean;
    /** Limit extra-destination invalidation to these ids. Primary remains
     * controlled separately, so a primary prompt change does not disturb an
     * extra channel with its own explicit comment prompt. */
    extraDestinationIds?: string[];
    clearOutroAudio?: boolean;
  }
): string[] {
  const includePrimary = options.includePrimary ?? true;
  const includeExtras = options.includeExtras ?? true;
  const requestedExtraIds = options.extraDestinationIds
    ? new Set(options.extraDestinationIds)
    : undefined;
  const stale: string[] = [];
  let affected = 0;

  if (includePrimary && reel.outputUrl) {
    stale.push(reel.outputUrl);
    reel.outputUrl = undefined;
    affected += 1;
  }

  if (includeExtras) {
    for (const destination of reel.destinations ?? []) {
      if (requestedExtraIds && !requestedExtraIds.has(destination.id)) continue;
      if (destination.outputUrl) {
        stale.push(destination.outputUrl);
        affected += 1;
      }
      destination.outputUrl = undefined;
      if (options.clearOutroAudio && destination.outroAudioUrl) {
        stale.push(destination.outroAudioUrl);
        destination.outroAudioUrl = undefined;
      }
      if (options.clearOutroAudio) destination.outroAudioSignature = undefined;
      destination.status = "pending";
      destination.error = undefined;
    }
    if ((reel.destinations ?? []).length) reel.markModified("destinations");
  }

  if (affected || (includeExtras && (reel.destinations ?? []).length)) {
    recordOperationLog({
      scope: "system",
      event: "outro.destination_outputs_invalidated",
      message: "Final destination outputs were invalidated after an upstream reel change",
      reelId: reel._id.toString(),
      metadata: {
        reason: options.reason,
        includePrimary,
        includeExtras,
        extraDestinationIds: options.extraDestinationIds,
        clearOutroAudio: Boolean(options.clearOutroAudio),
        affectedOutputCount: affected,
      },
    });
  }
  return [...new Set(stale)];
}

/**
 * Resolve the exact rendered output that is allowed to be uploaded to one
 * social destination.  Publishing a channel-specific outro through the
 * canonical `reel.outputUrl` would leak the primary channel's branding into a
 * sibling account, so there is deliberately no fallback to another channel's
 * video here.
 */
export function resolveRenderedPublishDestination(
  reel: IReel,
  platform: IReelDestination["platform"],
  channelId?: string
): IReelDestination {
  const primary = primaryDestination(reel);
  const destination = channelId
    ? resolveReelDestinations(reel).find((candidate) => candidate.platform === platform && candidate.channelId === channelId)
    : primary.platform === platform
      ? primary
      : undefined;

  if (!destination) {
    throw new Error(
      `No ${platform} destination is configured for this account. Add it in Channels and render its dedicated outro before publishing.`
    );
  }
  if (destination.status !== "ready" || !destination.outputUrl) {
    throw new Error(
      `${(destination.channelLabel ?? destination.channelId) || platform} does not have a ready destination render. Re-render its outro before publishing.`
    );
  }
  return destination;
}

export async function resolveOutroBrand(
  reel: IReel,
  source?: OutroSource
): Promise<OutroBrand | undefined> {
  // Legacy calls resolve from the reel's own outro* fields; destination-scoped
  // renders pass that destination's channel/copy instead.
  // IReel is structurally the legacy subset of OutroSource. Annotating here
  // lets destination-only Facebook/Threads fields coexist with legacy reels.
  const src: OutroSource = source ?? reel;
  const explicitInstagram = src.outroInstagramChannelId
    ? await InstagramChannel.findOne({ channelKey: src.outroInstagramChannelId, status: "active" })
    : undefined;
  const explicitFacebook = src.outroFacebookPageId
    ? await FacebookPage.findOne({ channelKey: src.outroFacebookPageId, status: "active" })
    : undefined;
  const explicitThreads = src.outroThreadsChannelId
    ? await ThreadsChannel.findOne({ channelKey: src.outroThreadsChannelId, status: "active" })
    : undefined;
  const explicitChannel = src.outroChannelId
    ? await YouTubeChannel.findOne({
        channelKey: src.outroChannelId,
        status: "active",
      })
    : undefined;
  // CTA copy follows the destination platform whenever the creator leaves it
  // blank. A saved value remains an intentional per-reel/channel override.
  const platform = platformForOutroSource(src);
  const defaultCta = defaultCtaForPlatform(platform);
  // Extra destinations without their own prompt deliberately inherit the
  // generated primary prompt. Their other card/call-to-action fields remain
  // per-destination, but this keeps one story-specific question consistent.
  const primaryCommentPrompt = reel.outro?.commentPrompt?.trim();

  if (reel.niche === "reddit") {
    const channel = explicitChannel ?? (await findChannelForNiche(["reddit", "reddit_stories", "aita"]));
    return {
      kind: "reddit",
      channelName: src.outro?.channelName?.trim() || explicitInstagram?.name || explicitInstagram?.username || explicitFacebook?.name || explicitFacebook?.label || explicitThreads?.name || explicitThreads?.username || explicitThreads?.label || channel?.googleChannelTitle || channel?.label || "Reddit Stories",
      channelHandle: src.outro?.channelHandle?.trim() || (explicitInstagram?.username ? `@${explicitInstagram.username}` : undefined) || (explicitThreads?.username ? `@${explicitThreads.username}` : undefined) || channel?.googleChannelHandle,
      logoUrl: explicitInstagram?.profilePictureUrl || explicitFacebook?.pictureUrl || explicitThreads?.profilePictureUrl || channel?.logoUrl,
      platform,
      commentPrompt:
        src.outro?.commentPrompt?.trim() || primaryCommentPrompt || DEFAULT_OUTRO_COMMENT_PROMPT,
      spokenLine: src.outro?.spokenLine?.trim(),
      title: src.outro?.title?.trim(),
      subtitle: src.outro?.subtitle?.trim(),
      cta: src.outro?.cta?.trim() || defaultCta,
      footer: src.outro?.footer?.trim(),
    };
  }

  if (reel.niche.startsWith("horror")) {
    const channel =
      explicitChannel ?? (await findChannelForNiche(["horror", "horror_comic", reel.genre ?? ""]));
    return {
      kind: "horror",
      channelName: src.outro?.channelName?.trim() || explicitInstagram?.name || explicitInstagram?.username || explicitFacebook?.name || explicitFacebook?.label || explicitThreads?.name || explicitThreads?.username || explicitThreads?.label || channel?.googleChannelTitle || channel?.label || "Midnight Horror",
      channelHandle: src.outro?.channelHandle?.trim() || (explicitInstagram?.username ? `@${explicitInstagram.username}` : undefined) || (explicitThreads?.username ? `@${explicitThreads.username}` : undefined) || channel?.googleChannelHandle,
      logoUrl: explicitInstagram?.profilePictureUrl || explicitFacebook?.pictureUrl || explicitThreads?.profilePictureUrl || channel?.logoUrl,
      platform,
      commentPrompt:
        src.outro?.commentPrompt?.trim() || primaryCommentPrompt || DEFAULT_OUTRO_COMMENT_PROMPT,
      spokenLine: src.outro?.spokenLine?.trim(),
      title: src.outro?.title?.trim(),
      subtitle: src.outro?.subtitle?.trim(),
      cta: src.outro?.cta?.trim() || defaultCta,
      footer: src.outro?.footer?.trim(),
    };
  }

  return undefined;
}

async function findChannelForNiche(niches: string[]) {
  const normalized = niches.map((niche) => niche.toLowerCase()).filter(Boolean);
  return YouTubeChannel.findOne({
    status: "active",
    niches: { $in: normalized },
  }).sort({ createdAt: 1 });
}

export async function appendBrandedOutro(
  inputVideo: string,
  reel: IReel,
  tts: OutroTts,
  onUsage?: MediaUsageCallback,
  options: {
    backgroundVideo?: string;
    /** Skip cached outro audio (e.g. after spoken-line change cleared it). */
    forceFreshOutroAudio?: boolean;
    /**
     * Render this destination's outro instead of the reel's legacy outro fields:
     * its channel branding, its cached outro audio, and unique temp filenames so
     * sibling destinations don't collide.
     */
    destination?: IReelDestination;
  } = {}
): Promise<
  | {
      videoPath: string;
      durationAdded: number;
      subtitle?: { text: string; startTime: number; speech: number };
      /** Local outro narration mp3 — upload when outroAudioGenerated. */
      outroAudioPath: string;
      outroAudioGenerated: boolean;
      /** Signature that proves a cached clip matches the resolved narration. */
      outroAudioSignature: string;
    }
  | undefined
> {
  const dest = options.destination;
  if ((dest ? dest.skipBrandedOutro : reel.skipBrandedOutro)) return undefined;

  const brand = await resolveOutroBrand(reel, dest ? destinationOutroSource(dest) : undefined);
  // A configured channel destination must never quietly fall back to the
  // shared bare body: that would create a video whose provenance/branding is
  // ambiguous at publish time. Legacy unsupported niches retain their prior
  // no-outro behavior until they get a branded-card implementation.
  if (!brand) {
    if (dest || reel.niche === "reddit" || reel.niche.startsWith("horror")) {
      throw new Error("Could not resolve a branded outro for this destination");
    }
    return undefined;
  }

  const key = dest ? `${reel._id}_${dest.id}` : `${reel._id}`;
  const cachedOutroAudioUrl = dest ? dest.outroAudioUrl : reel.outroAudioUrl;
  const cachedOutroAudioSignature = dest ? dest.outroAudioSignature : reel.outroAudioSignature;
  const tmp: string[] = [];
  let retainAudioPath: string | undefined;
  try {
    await ensureDir(config.processingPath);
    const line = composeOutroSpokenLine(reel, brand);
    const outroAudioSignature = narrationSignature(line, tts);

    let audioPath: string;
    let outroAudioGenerated = false;
    if (
      !options.forceFreshOutroAudio &&
      cachedOutroAudioUrl &&
      cachedOutroAudioSignature === outroAudioSignature
    ) {
      audioPath = join(config.processingPath, `${key}_outro_reused.mp3`);
      const res = await fetch(cachedOutroAudioUrl);
      if (!res.ok) {
        throw new Error(`Could not reuse outro audio (${res.status})`);
      }
      await writeFile(audioPath, Buffer.from(await res.arrayBuffer()));
      // Reused file can be deleted after the clip is rendered (not returned for upload).
      tmp.push(audioPath);
    } else {
      const generated = await generateNarration(line, {
        ...tts,
        outputDir: config.processingPath,
        profile: brand.kind === "horror" ? "horror" : "reddit",
        onUsage,
      });
      audioPath = generated.audioPath;
      outroAudioGenerated = true;
      // Keep for caller upload — not added to tmp.
      retainAudioPath = audioPath;
    }

    const cardPath = await renderOutroCard(
      brand,
      Boolean(options.backgroundVideo && brand.kind === "reddit"),
      nextRedditPart(reel)
    );
    tmp.push(cardPath);
    const outroClip = join(config.processingPath, `${key}_outro_clip.mp4`);
    tmp.push(outroClip);
    await renderOutroClip(cardPath, audioPath, outroClip, brand.kind, options.backgroundVideo);

    const output = join(config.processingPath, `${key}_with_outro.mp4`);
    const mainDuration = await videoDuration(inputVideo);
    await appendWithoutOverlap(inputVideo, outroClip, output);
    const durationAdded = await videoDuration(outroClip);
    return {
      videoPath: output,
      durationAdded,
      outroAudioPath: audioPath,
      outroAudioGenerated,
      outroAudioSignature,
      subtitle: {
        text: line,
        startTime: mainDuration,
        speech: durationAdded,
      },
    };
  } catch (error) {
    if (retainAudioPath) await unlink(retainAudioPath).catch(() => {});
    console.warn(
      `Skipping branded outro for reel ${reel._id}: ${error instanceof Error ? error.message : String(error)}`
    );
    recordOperationLog({
      scope: "external",
      level: "error",
      event: "outro.render_failed",
      message: "A branded outro could not be rendered; the destination will not receive a fallback body-only video",
      reelId: reel._id.toString(),
      metadata: dest ? { destinationId: dest.id, platform: dest.platform, channelId: dest.channelId } : { primary: true },
      error,
    });
    throw error;
  } finally {
    await Promise.all(tmp.map((file) => unlink(file).catch(() => {})));
  }
}

function narrationSignature(line: string, tts: OutroTts): string {
  return createHash("sha256")
    .update(JSON.stringify({ line, model: tts.model ?? "", voice: tts.voice ?? "", format: tts.format ?? "" }))
    .digest("hex");
}

/** Build the complete branded-outro narration. The comments question is always
 * first, then the channel action. This makes comment prompting consistent for
 * a primary output and every per-channel destination. */
export function composeOutroSpokenLine(reel: IReel, brand: OutroBrand): string {
  const actionLine = brand.spokenLine || defaultChannelOutroLine(reel, brand);
  return [brand.commentPrompt, actionLine].filter(Boolean).join(" ");
}

function defaultChannelOutroLine(reel: IReel, brand: OutroBrand): string {
  const channelAction =
    brand.platform === "youtube"
      ? `Subscribe to ${brand.channelName}`
      : `Follow ${brand.channelName}`;
  if (brand.kind !== "reddit") {
    return brand.platform === "youtube"
      ? `${channelAction}. The next story is already waiting.`
      : `${channelAction} for more stories.`;
  }
  const nextPart = nextRedditPart(reel);
  if (nextPart) {
    return `${channelAction} for part ${nextPart}.`;
  }
  return `${channelAction} for more stories.`;
}

function nextRedditPart(reel: IReel): number | undefined {
  const partNumber = reel.partNumber ?? reel.redditStory?.partNumber ?? 1;
  const partCount = reel.partCount ?? reel.redditStory?.partCount ?? 1;
  return partNumber < partCount ? partNumber + 1 : undefined;
}

async function renderOutroCard(
  brand: OutroBrand,
  transparent = false,
  nextPart?: number
): Promise<string> {
  const isHorror = brand.kind === "horror";
  const initials = brand.channelName
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const cta = brand.cta || defaultCtaForPlatform(brand.platform);
  const title = isHorror
    ? brand.title || "DON'T WATCH ALONE"
    : nextPart
      ? brand.title || `${cta} FOR PART ${nextPart}`
      : brand.title || `${cta} FOR MORE`;
  const subtitle = isHorror
    ? brand.subtitle || "New nightmares every night"
    : nextPart
      ? brand.subtitle || `Part ${nextPart} drops next`
      : brand.subtitle || "More stories after this one";
  const accent = isHorror ? "#b91c1c" : "#ff4500";
  const bgA = isHorror ? "#050505" : "#111827";
  const bgB = isHorror ? "#1f0505" : "#1f2937";
  const logo = await logoDataUri(brand.logoUrl);
  const handle = brand.channelHandle ? brand.channelHandle.replace(/^@?/, "@") : "";
  const background = transparent
    ? ""
    : `<rect width="${W}" height="${H}" fill="url(#bg)"/>`;
  const commentLines = wrapOutroText(brand.commentPrompt, 48);
  const commentY = transparent ? 1220 : 1145;
  const commentLineHeight = 31;
  const subscribeY = Math.max(
    transparent ? 1325 : 1195,
    commentY + (Math.max(commentLines.length, 1) - 1) * commentLineHeight + 46,
  );
  const footerY = subscribeY + 140;
  const commentText = commentLines
    .map(
      (line, index) =>
        `<text x="540" y="${commentY + index * commentLineHeight}" text-anchor="middle" font-family="Arial" font-size="28" font-weight="800" fill="#f8fafc">${esc(line)}</text>`
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${bgA}"/>
      <stop offset="1" stop-color="${bgB}"/>
    </linearGradient>
    <filter id="glow" x="-80%" y="-80%" width="260%" height="260%">
      <feGaussianBlur stdDeviation="18" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="panelShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="24" flood-color="#000000" flood-opacity="0.48"/>
    </filter>
    <clipPath id="logoClip"><circle cx="540" cy="${transparent ? 700 : 640}" r="100"/></clipPath>
  </defs>
  ${background}
  ${transparent ? `<rect x="118" y="430" width="844" height="1040" rx="34" fill="#050505" opacity="0.68" filter="url(#panelShadow)"/>` : ""}
  <circle cx="540" cy="${transparent ? 700 : 640}" r="156" fill="${accent}" opacity="0.18" filter="url(#glow)"/>
  <circle cx="540" cy="${transparent ? 700 : 640}" r="118" fill="${accent}"/>
  <circle cx="540" cy="${transparent ? 700 : 640}" r="100" fill="${isHorror ? "#130606" : "#ffffff"}"/>
  ${
    logo
      ? `<image href="${logo}" x="440" y="${transparent ? 600 : 540}" width="200" height="200" preserveAspectRatio="xMidYMid slice" clip-path="url(#logoClip)"/>`
      : `<text x="540" y="${transparent ? 742 : 682}" text-anchor="middle" font-family="Arial" font-size="78" font-weight="900" fill="${isHorror ? "#f8fafc" : accent}">${esc(initials)}</text>`
  }
  <text x="540" y="${transparent ? 950 : 890}" text-anchor="middle" font-family="Arial" font-size="46" font-weight="900" fill="${accent}" letter-spacing="3">${esc(title)}</text>
  <text x="540" y="${transparent ? 1050 : 990}" text-anchor="middle" font-family="Arial" font-size="68" font-weight="900" fill="#f8fafc">${esc(brand.channelName)}</text>
  ${handle ? `<text x="540" y="${transparent ? 1110 : 1042}" text-anchor="middle" font-family="Arial" font-size="34" font-weight="800" fill="#cbd5e1">${esc(handle)}</text>` : ""}
  <text x="540" y="${transparent ? 1190 : 1100}" text-anchor="middle" font-family="Arial" font-size="34" font-weight="700" fill="#cbd5e1">${esc(subtitle)}</text>
  ${commentText}
  <rect x="270" y="${subscribeY}" width="540" height="78" rx="39" fill="${accent}"/>
  <text x="540" y="${subscribeY + 52}" text-anchor="middle" font-family="Arial" font-size="34" font-weight="900" fill="#ffffff">${esc(cta)}</text>
  ${isHorror ? `<text x="540" y="${footerY}" text-anchor="middle" font-family="Arial" font-size="30" fill="#64748b">${esc(brand.footer || "it already knows you're here")}</text>` : brand.footer ? `<text x="540" y="${footerY}" text-anchor="middle" font-family="Arial" font-size="30" fill="#cbd5e1">${esc(brand.footer)}</text>` : ""}
</svg>`;

  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: W },
    font: { loadSystemFonts: true },
  }).render().asPng();
  const output = join(config.processingPath, generateFilename("branded-outro", "png"));
  await writeFile(output, png);
  return output;
}

/** Keep a user-authored discussion prompt readable on the rendered card.
 * Validation caps it at 160 characters; this uses as many lines as needed,
 * while preserving exactly the same words that TTS reads. */
function wrapOutroText(value: string, maxLineLength: number): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (current && next.length > maxLineLength) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function logoDataUri(url?: string): Promise<string | undefined> {
  if (!url) return undefined;
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    const contentType = res.headers.get("content-type") || "image/png";
    const data = Buffer.from(await res.arrayBuffer()).toString("base64");
    return `data:${contentType};base64,${data}`;
  } catch {
    return undefined;
  }
}

async function renderOutroClip(
  cardPath: string,
  audioPath: string,
  output: string,
  kind: OutroBrand["kind"],
  backgroundVideo?: string
) {
  const audioDur = await videoDuration(audioPath);
  const duration = Math.max(audioDur + 0.65, 3.2);
  const fadeOut = Math.max(duration - (kind === "horror" ? 0.45 : 0.35), 0).toFixed(2);
  const audioFilter = `apad,atrim=0:${duration.toFixed(2)},afade=t=out:st=${Math.max(duration - 0.4, 0).toFixed(2)}:d=0.4`;
  const filters = backgroundVideo
    ? [
        `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},trim=0:${duration.toFixed(2)},setpts=PTS-STARTPTS,fade=t=in:st=0:d=0.18,fade=t=out:st=${fadeOut}:d=0.35[bg]`,
        `[1:v]scale=${W}:${H},format=rgba,fade=t=in:st=0:d=0.22:alpha=1,fade=t=out:st=${fadeOut}:d=0.35:alpha=1[ov]`,
        `[bg][ov]overlay=0:0:format=auto[v]`,
        `[2:a]${audioFilter}[a]`,
      ]
    : [
        kind === "horror"
          ? `[0:v]scale=${W}:${H},noise=alls=7:allf=t,vignette=PI/3.1,fade=t=in:st=0:d=0.25,fade=t=out:st=${fadeOut}:d=0.45[v]`
          : `[0:v]scale=${W}:${H},fade=t=in:st=0:d=0.25,fade=t=out:st=${fadeOut}:d=0.35[v]`,
        `[1:a]${audioFilter}[a]`,
      ];

  return new Promise<string>((resolvePromise, reject) => {
    let commandLine = "";
    const stderr: string[] = [];
    const command = ffmpeg();
    if (backgroundVideo) {
      command.input(backgroundVideo).inputOptions(["-stream_loop", "-1"]);
    }
    command.input(cardPath).inputOptions(["-loop", "1", "-framerate", String(FPS)]);
    command
      .input(audioPath)
      .complexFilter(filters, ["v", "a"])
      .outputOptions([
        "-t",
        duration.toFixed(2),
        "-r",
        String(FPS),
        "-c:v",
        "libx264",
        "-preset",
        config.ffmpegPreset,
        "-crf",
        kind === "horror" ? "22" : "21",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
      ])
      .output(output)
      .on("end", () => resolvePromise(output))
      .on("start", (cmd) => {
        commandLine = cmd;
      })
      .on("stderr", (line) => {
        stderr.push(line);
        if (stderr.length > 50) stderr.shift();
      })
      .on("error", (err) => {
        const detail = stderr.length ? `\n${stderr.join("\n")}` : "";
        const commandDetail = commandLine ? `\nCommand: ${commandLine}` : "";
        reject(new Error(`Outro clip render failed: ${err.message}${commandDetail}${detail}`));
      })
      .run();
  });
}

async function appendWithoutOverlap(input: string, outro: string, output: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    ffmpeg()
      .input(input)
      .input(outro)
      .complexFilter(
        [
          `[0:v]setsar=1,fps=${FPS},format=yuv420p[v0]`,
          `[1:v]setsar=1,fps=${FPS},format=yuv420p[v1]`,
          `[0:a]aformat=sample_rates=44100:channel_layouts=stereo[a0]`,
          `[1:a]aformat=sample_rates=44100:channel_layouts=stereo[a1]`,
          `[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]`,
        ],
        ["v", "a"]
      )
      .outputOptions([
        "-c:v",
        "libx264",
        "-preset",
        config.ffmpegPreset,
        "-crf",
        "21",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
      ])
      .output(output)
      .on("end", () => resolvePromise(output))
      .on("error", (err) => reject(new Error(`Outro append failed: ${err.message}`)))
      .run();
  });
}

function videoDuration(path: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    ffmpeg.ffprobe(path, (error, metadata) => {
      if (error) {
        reject(new Error(`Duration probe failed: ${error.message}`));
        return;
      }
      resolvePromise(metadata.format.duration ?? 0);
    });
  });
}
