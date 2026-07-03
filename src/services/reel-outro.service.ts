import { Resvg } from "@resvg/resvg-js";
import ffmpeg from "fluent-ffmpeg";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { YouTubeChannel, type IReel } from "../models";
import { ensureDir, generateFilename } from "../utils";
import { generateNarration, type MediaUsageCallback } from "./openrouter-media.service";

const W = 1080;
const H = 1920;
const FPS = 30;
const XFADE = 0.45;

export interface OutroBrand {
  channelName: string;
  logoUrl?: string;
  kind: "reddit" | "horror";
}

export interface OutroTts {
  model?: string;
  voice?: string;
  format?: "mp3" | "pcm";
}

export async function resolveOutroBrand(reel: IReel): Promise<OutroBrand | undefined> {
  if (reel.niche === "reddit") {
    const channel = await findChannelForNiche(["reddit", "reddit_stories", "aita"]);
    return {
      kind: "reddit",
      channelName: channel?.label ?? channel?.googleChannelTitle ?? "Reddit Stories",
      logoUrl: channel?.logoUrl,
    };
  }

  if (reel.niche.startsWith("horror")) {
    const channel = await findChannelForNiche(["horror", "horror_comic", reel.genre ?? ""]);
    return {
      kind: "horror",
      channelName: channel?.label ?? channel?.googleChannelTitle ?? "Midnight Horror",
      logoUrl: channel?.logoUrl,
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
  onUsage?: MediaUsageCallback
): Promise<{ videoPath: string; durationAdded: number } | undefined> {
  const brand = await resolveOutroBrand(reel);
  if (!brand) return undefined;

  const tmp: string[] = [];
  try {
    await ensureDir(config.processingPath);
    const line =
      brand.kind === "reddit"
        ? `Follow ${brand.channelName} for the update.`
        : `Subscribe to ${brand.channelName}. The next story is already waiting.`;
    const { audioPath } = await generateNarration(line, {
      ...tts,
      outputDir: config.processingPath,
      profile: brand.kind === "horror" ? "horror" : undefined,
      onUsage,
    });
    tmp.push(audioPath);

    const cardPath = await renderOutroCard(brand);
    tmp.push(cardPath);
    const outroClip = join(config.processingPath, `${reel._id}_outro_clip.mp4`);
    tmp.push(outroClip);
    await renderOutroClip(cardPath, audioPath, outroClip, brand.kind);

    const output = join(config.processingPath, `${reel._id}_with_outro.mp4`);
    await appendWithCrossfade(inputVideo, outroClip, output);
    const durationAdded = Math.max(await videoDuration(outroClip) - XFADE, 0);
    return { videoPath: output, durationAdded };
  } catch (error) {
    console.warn(
      `Skipping branded outro for reel ${reel._id}: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  } finally {
    await Promise.all(tmp.map((file) => unlink(file).catch(() => {})));
  }
}

async function renderOutroCard(brand: OutroBrand): Promise<string> {
  const isHorror = brand.kind === "horror";
  const initials = brand.channelName
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const title = isHorror ? "DON'T WATCH ALONE" : "FOLLOW FOR THE UPDATE";
  const subtitle = isHorror
    ? "New nightmares every night"
    : "More stories after this one";
  const accent = isHorror ? "#b91c1c" : "#ff4500";
  const bgA = isHorror ? "#050505" : "#111827";
  const bgB = isHorror ? "#1f0505" : "#1f2937";
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
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <circle cx="540" cy="640" r="156" fill="${accent}" opacity="0.18" filter="url(#glow)"/>
  <circle cx="540" cy="640" r="118" fill="${accent}"/>
  <circle cx="540" cy="640" r="100" fill="${isHorror ? "#130606" : "#ffffff"}"/>
  <text x="540" y="682" text-anchor="middle" font-family="Arial" font-size="78" font-weight="900" fill="${isHorror ? "#f8fafc" : accent}">${esc(initials)}</text>
  <text x="540" y="890" text-anchor="middle" font-family="Arial" font-size="46" font-weight="900" fill="${accent}" letter-spacing="3">${esc(title)}</text>
  <text x="540" y="990" text-anchor="middle" font-family="Arial" font-size="74" font-weight="900" fill="#f8fafc">${esc(brand.channelName)}</text>
  <text x="540" y="1080" text-anchor="middle" font-family="Arial" font-size="36" font-weight="700" fill="#cbd5e1">${esc(subtitle)}</text>
  <rect x="270" y="1195" width="540" height="78" rx="39" fill="${accent}"/>
  <text x="540" y="1247" text-anchor="middle" font-family="Arial" font-size="34" font-weight="900" fill="#ffffff">SUBSCRIBE</text>
  ${isHorror ? `<text x="540" y="1440" text-anchor="middle" font-family="Arial" font-size="30" fill="#64748b">it already knows you're here</text>` : `<text x="540" y="1440" text-anchor="middle" font-family="Arial" font-size="30" fill="#94a3b8">new stories daily</text>`}
</svg>`;

  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: W },
    font: { loadSystemFonts: true },
  }).render().asPng();
  const output = join(config.processingPath, generateFilename("branded-outro", "png"));
  await writeFile(output, png);
  return output;
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function renderOutroClip(cardPath: string, audioPath: string, output: string, kind: OutroBrand["kind"]) {
  const audioDur = await videoDuration(audioPath);
  const duration = Math.max(audioDur + 0.65, 3.2);
  const fadeOut = Math.max(duration - (kind === "horror" ? 0.45 : 0.35), 0).toFixed(2);
  const visual =
    kind === "horror"
      ? `scale=1080:1920,noise=alls=7:allf=t,vignette=PI/3.1,fade=t=in:st=0:d=0.25,fade=t=out:st=${fadeOut}:d=0.45`
      : `scale=1080:1920,fade=t=in:st=0:d=0.25,fade=t=out:st=${fadeOut}:d=0.35`;

  return new Promise<string>((resolvePromise, reject) => {
    ffmpeg()
      .input(cardPath)
      .inputOptions(["-loop", "1", "-framerate", String(FPS)])
      .input(audioPath)
      .outputOptions([
        "-t",
        duration.toFixed(2),
        "-vf",
        visual,
        "-af",
        `apad,atrim=0:${duration.toFixed(2)},afade=t=out:st=${Math.max(duration - 0.4, 0).toFixed(2)}:d=0.4`,
        "-r",
        String(FPS),
        "-c:v",
        "libx264",
        "-preset",
        "medium",
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
      .on("error", (err) => reject(new Error(`Outro clip render failed: ${err.message}`)))
      .run();
  });
}

async function appendWithCrossfade(input: string, outro: string, output: string): Promise<string> {
  const mainDur = await videoDuration(input);
  const offset = Math.max(mainDur - XFADE, 0);
  return new Promise((resolvePromise, reject) => {
    ffmpeg()
      .input(input)
      .input(outro)
      .complexFilter(
        [
          `[0:v][1:v]xfade=transition=fadeblack:duration=${XFADE}:offset=${offset.toFixed(3)}[v]`,
          `[0:a][1:a]acrossfade=d=${XFADE}:c1=tri:c2=tri[a]`,
        ],
        ["v", "a"]
      )
      .outputOptions([
        "-c:v",
        "libx264",
        "-preset",
        "medium",
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
