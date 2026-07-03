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

export interface OutroBrand {
  channelName: string;
  channelHandle?: string;
  logoUrl?: string;
  kind: "reddit" | "horror";
}

export interface OutroTts {
  model?: string;
  voice?: string;
  format?: "mp3" | "pcm";
}

export async function resolveOutroBrand(reel: IReel): Promise<OutroBrand | undefined> {
  const explicitChannel = reel.outroChannelId
    ? await YouTubeChannel.findOne({
        channelKey: reel.outroChannelId,
        status: "active",
      })
    : undefined;

  if (reel.niche === "reddit") {
    const channel = explicitChannel ?? (await findChannelForNiche(["reddit", "reddit_stories", "aita"]));
    return {
      kind: "reddit",
      channelName: channel?.googleChannelTitle ?? channel?.label ?? "Reddit Stories",
      channelHandle: channel?.googleChannelHandle,
      logoUrl: channel?.logoUrl,
    };
  }

  if (reel.niche.startsWith("horror")) {
    const channel =
      explicitChannel ?? (await findChannelForNiche(["horror", "horror_comic", reel.genre ?? ""]));
    return {
      kind: "horror",
      channelName: channel?.googleChannelTitle ?? channel?.label ?? "Midnight Horror",
      channelHandle: channel?.googleChannelHandle,
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
  onUsage?: MediaUsageCallback,
  options: { backgroundVideo?: string } = {}
): Promise<{ videoPath: string; durationAdded: number } | undefined> {
  const brand = await resolveOutroBrand(reel);
  if (!brand) return undefined;

  const tmp: string[] = [];
  try {
    await ensureDir(config.processingPath);
    const line =
      brand.kind === "reddit"
        ? redditOutroLine(reel, brand.channelName)
        : `Subscribe to ${brand.channelName}. The next story is already waiting.`;
    const { audioPath } = await generateNarration(line, {
      ...tts,
      outputDir: config.processingPath,
      profile: brand.kind === "horror" ? "horror" : undefined,
      onUsage,
    });
    tmp.push(audioPath);

    const cardPath = await renderOutroCard(
      brand,
      Boolean(options.backgroundVideo && brand.kind === "reddit"),
      nextRedditPart(reel)
    );
    tmp.push(cardPath);
    const outroClip = join(config.processingPath, `${reel._id}_outro_clip.mp4`);
    tmp.push(outroClip);
    await renderOutroClip(cardPath, audioPath, outroClip, brand.kind, options.backgroundVideo);

    const output = join(config.processingPath, `${reel._id}_with_outro.mp4`);
    await appendWithoutOverlap(inputVideo, outroClip, output);
    const durationAdded = await videoDuration(outroClip);
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

function redditOutroLine(reel: IReel, channelName: string): string {
  const nextPart = nextRedditPart(reel);
  if (nextPart) {
    return `Follow ${channelName} for part ${nextPart}.`;
  }
  return `Follow ${channelName} for more stories.`;
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
  const title = isHorror
    ? "DON'T WATCH ALONE"
    : nextPart
      ? `FOLLOW FOR PART ${nextPart}`
      : "FOLLOW FOR MORE";
  const subtitle = isHorror
    ? "New nightmares every night"
    : nextPart
      ? `Part ${nextPart} drops next`
      : "More stories after this one";
  const accent = isHorror ? "#b91c1c" : "#ff4500";
  const bgA = isHorror ? "#050505" : "#111827";
  const bgB = isHorror ? "#1f0505" : "#1f2937";
  const logo = await logoDataUri(brand.logoUrl);
  const handle = brand.channelHandle ? brand.channelHandle.replace(/^@?/, "@") : "";
  const background = transparent
    ? ""
    : `<rect width="${W}" height="${H}" fill="url(#bg)"/>`;
  const subscribeY = transparent ? 1325 : 1195;
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
  <rect x="270" y="${subscribeY}" width="540" height="78" rx="39" fill="${accent}"/>
  <text x="540" y="${subscribeY + 52}" text-anchor="middle" font-family="Arial" font-size="34" font-weight="900" fill="#ffffff">SUBSCRIBE</text>
  ${isHorror ? `<text x="540" y="1440" text-anchor="middle" font-family="Arial" font-size="30" fill="#64748b">it already knows you're here</text>` : ""}
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
