import ffmpeg from "fluent-ffmpeg";
import { readdir, writeFile, unlink, stat } from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import { config } from "../config";
import { ensureDir } from "../utils";
import { generateNarration, getAudioDuration } from "./openrouter-media.service";
import { listKeys, cdnUrlFor } from "./s3.service";
import { renderPartOutroCard, renderRedditCard } from "./reddit-card.service";
import type { RedditStory } from "./reel-script.service";

// ============================================
// GameplayOverlayStrategy (Reddit / AITA).
// Looping gameplay background + single-narrator TTS + bouncing word captions +
// a Reddit-style title card. No AI images — the cheapest, highest-velocity
// format. See docs/architecture/style-system.md.
// ============================================

const W = 1080;
const H = 1920;
const FPS = 30;

export interface GameplayResult {
  videoPath: string;
  assPath: string;
  totalDuration: number;
}

export interface PickedGameplay {
  path: string; // local cached file, ready for ffmpeg
  key: string; // s3 key, e.g. gameplay/parkour_000.mp4 — persisted on the reel
}

/**
 * Pick a gameplay clip. If `preferredKey` is given (explicit choice from the
 * create form, or the key already recorded on a reel for revoice), that exact
 * S3 object is used — downloading + caching it if not already local.
 * Otherwise picks randomly: prefers the local cache; if empty, falls back to
 * the S3 `gameplay/` prefix (served via CloudFront) and caches one locally.
 */
export async function pickGameplay(preferredKey?: string): Promise<PickedGameplay> {
  await ensureDir(config.gameplayDir);

  if (preferredKey) {
    const dest = join(config.gameplayDir, basename(preferredKey));
    const cached = await stat(dest).then(() => true).catch(() => false);
    if (!cached) await downloadToCache(preferredKey, dest);
    return { path: dest, key: preferredKey };
  }

  const local = (await readdir(config.gameplayDir)).filter((f) =>
    /\.(mp4|mov|webm)$/i.test(f)
  );
  if (local.length) {
    const file = local[Math.floor(Math.random() * local.length)];
    return { path: join(config.gameplayDir, file), key: `gameplay/${file}` };
  }

  // fall back to S3/CDN
  const keys = (await listKeys("gameplay/")).filter((k) => /\.(mp4|mov|webm)$/i.test(k));
  if (!keys.length) {
    throw new Error(
      `No gameplay clips found locally (${config.gameplayDir}) or in s3://.../gameplay/. ` +
        `Ingest some first with ingestGameplaySource().`
    );
  }
  const key = keys[Math.floor(Math.random() * keys.length)];
  const dest = join(config.gameplayDir, basename(key));
  await downloadToCache(key, dest);
  return { path: dest, key };
}

/** List available gameplay clips in the S3 pool for the picker UI. */
export async function listGameplayLibrary(): Promise<
  { key: string; url: string; filename: string }[]
> {
  const keys = (await listKeys("gameplay/")).filter((k) => /\.(mp4|mov|webm)$/i.test(k));
  return keys.map((key) => ({ key, url: cdnUrlFor(key), filename: basename(key) }));
}

/** Download an S3 object (via CDN, falling back to direct S3) into the cache. */
async function downloadToCache(key: string, dest: string): Promise<void> {
  const s3Url = `https://${config.s3Bucket}.s3.${config.awsRegion}.amazonaws.com/${key}`;
  for (const url of [cdnUrlFor(key), s3Url]) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
      return;
    } catch {
      /* try next */
    }
  }
  throw new Error(`Could not download gameplay clip: ${key}`);
}

/** Strip markdown/symbols that TTS would read aloud or that clutter captions. */
function clean(text: string): string {
  return text
    .replace(/[*_`#~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split narration body into sentence-sized caption segments. */
function toSentences(text: string): string[] {
  const parts = clean(text).match(/[^.!?]+[.!?]*/g);
  return parts?.map((s) => s.trim()).filter(Boolean) ?? [text];
}

export async function renderGameplayReel(
  reelId: string,
  story: RedditStory,
  gameplayPath: string,
  ttsOpts: { model?: string; voice?: string; format?: "mp3" | "pcm" } = {}
): Promise<GameplayResult> {
  await ensureDir(config.processingPath);
  const tmp: string[] = [];

  try {
    return await renderGameplayReelInner(reelId, story, gameplayPath, ttsOpts, tmp);
  } finally {
    // Cleanup must run even on failure (ffmpeg error, network blip, etc.) —
    // previously this only ran on the success path, so a failed render left
    // every intermediate audio/video file behind in storage/processing/ forever.
    await Promise.all(tmp.map((f) => unlink(f).catch(() => {})));
  }
}

async function renderGameplayReelInner(
  reelId: string,
  story: RedditStory,
  gameplayPath: string,
  ttsOpts: { model?: string; voice?: string; format?: "mp3" | "pcm" },
  tmp: string[]
): Promise<GameplayResult> {
  // 1. Narrate: title first (read over the title card), then each sentence.
  const outroText = getPartOutroText(story);
  const bodySentences = toSentences(story.body);
  const segTexts = [clean(story.title), ...bodySentences, ...(outroText ? [outroText] : [])];
  const audioPaths: string[] = [];
  const speechDurs: number[] = [];
  const tempo = clampTempo(config.redditNarrationTempo);

  for (let i = 0; i < segTexts.length; i++) {
    const { audioPath } = await generateNarration(segTexts[i], {
      ...ttsOpts,
      outputDir: config.processingPath,
    });
    tmp.push(audioPath);

    const pacedPath = join(config.processingPath, `${reelId}_paced_${i}.mp3`);
    await changeAudioTempo(audioPath, pacedPath, tempo);
    tmp.push(pacedPath);
    audioPaths.push(pacedPath);
    speechDurs.push(await getAudioDuration(pacedPath));
  }

  // 2. Concat narration into one track; resolve segment start times. TTS clips
  // are silence-trimmed, so we add deliberate short pauses instead of relying
  // on provider-specific dead air.
  const concatPaths: string[] = [];
  const starts: number[] = [];
  let cursor = 0;
  for (let i = 0; i < audioPaths.length; i++) {
    starts.push(cursor);
    concatPaths.push(audioPaths[i]);
    cursor += speechDurs[i];

    const gap = i === 0 ? config.redditTitleGapSeconds : config.redditSentenceGapSeconds;
    if (gap > 0 && i < audioPaths.length - 1) {
      const gapPath = join(config.processingPath, `${reelId}_gap_${i}.mp3`);
      await generateSilence(gap, gapPath);
      tmp.push(gapPath);
      concatPaths.push(gapPath);
      cursor += gap;
    }
  }

  const listPath = join(config.processingPath, `${reelId}_narr.txt`);
  // absolute paths — ffmpeg concat resolves relative entries against the list dir
  await writeFile(listPath, concatPaths.map((p) => `file '${resolve(p)}'`).join("\n"));
  tmp.push(listPath);
  const narrPath = join(config.processingPath, `${reelId}_narr.mp3`);
  await concatAudio(listPath, narrPath);
  tmp.push(narrPath);

  const total = await getAudioDuration(narrPath);
  const titleDur = speechDurs[0] + Math.max(config.redditTitleGapSeconds, 0);

  // 3. Loop + crop gameplay to the narration length (muted).
  const bgPath = join(config.processingPath, `${reelId}_bg.mp4`);
  await loopBackground(gameplayPath, total, bgPath);
  tmp.push(bgPath);

  // 4. Bouncing word captions for the body (title is shown as a card instead).
  const capSegs = bodySentences.map((t, i) => ({
    text: t,
    startTime: starts[i + 1],
    speech: speechDurs[i + 1],
  }));
  const assPath = join(config.processingPath, `${reelId}.ass`);
  await writeFile(assPath, buildBouncingCaptions(capSegs), "utf-8");

  // 5. Composite bg + captions + Reddit card overlay + narration.
  const card = await renderRedditCard(clean(story.title), redditCardOpts(story));
  tmp.push(card.path);
  const outroCard = outroText ? await renderPartOutroCard((story.partNumber ?? 1) + 1) : undefined;
  if (outroCard) tmp.push(outroCard.path);
  const outroStart = outroText ? starts[segTexts.length - 1] : undefined;
  const finalPath = join(config.processingPath, `${reelId}_final.mp4`);
  await composite(bgPath, narrPath, assPath, card, 250, titleDur, finalPath, {
    card: outroCard,
    start: outroStart,
  });

  return { videoPath: finalPath, assPath, totalDuration: total };
}

// ---- ffmpeg steps ----

function concatAudio(listPath: string, out: string): Promise<string> {
  return new Promise((resolve, reject) => {
    ffmpeg(listPath)
      .inputOptions(["-f", "concat", "-safe", "0"])
      .outputOptions(["-c:a", "libmp3lame", "-q:a", "4"])
      .output(out)
      .on("end", () => resolve(out))
      .on("error", (err) => reject(new Error(`Narration concat failed: ${err.message}`)))
      .run();
  });
}

function clampTempo(tempo: number): number {
  if (!Number.isFinite(tempo) || tempo <= 0) return 1;
  // FFmpeg atempo supports 0.5-100, but short-form narration becomes harsh
  // quickly. Keep env mistakes from producing unusable audio.
  return Math.min(Math.max(tempo, 0.75), 1.5);
}

function getPartOutroText(story: RedditStory): string | undefined {
  const partNumber = story.partNumber ?? 1;
  const partCount = story.partCount ?? 1;
  if (partNumber >= partCount) return undefined;
  return `Stay tuned for part ${partNumber + 1}.`;
}

function changeAudioTempo(input: string, output: string, tempo: number): Promise<string> {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .audioFilters(`atempo=${tempo.toFixed(3)}`)
      .outputOptions(["-ar", "44100", "-ac", "1", "-c:a", "libmp3lame", "-q:a", "4"])
      .output(output)
      .on("end", () => resolve(output))
      .on("error", (err) => reject(new Error(`Narration tempo failed: ${err.message}`)))
      .run();
  });
}

async function generateSilence(duration: number, output: string): Promise<string> {
  const wavPath = `${output}.wav`;
  await writeFile(wavPath, silentWav(duration));
  try {
    return await wavToMp3(wavPath, output);
  } finally {
    await unlink(wavPath).catch(() => {});
  }
}

function silentWav(duration: number): Buffer {
  const sampleRate = 44100;
  const channels = 1;
  const bitsPerSample = 16;
  const samples = Math.max(1, Math.round(Math.max(duration, 0) * sampleRate));
  const dataSize = samples * channels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
}

function wavToMp3(input: string, output: string): Promise<string> {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .outputOptions(["-c:a", "libmp3lame", "-q:a", "4"])
      .output(output)
      .on("end", () => resolve(output))
      .on("error", (err) => reject(new Error(`Narration gap failed: ${err.message}`)))
      .run();
  });
}

function formatCount(n: number | undefined): string | undefined {
  if (!Number.isFinite(n)) return undefined;
  const value = n as number;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.max(0, Math.round(value)));
}

function redditCardOpts(story: RedditStory) {
  const authentic = story.source === "verbatim";
  return {
    subreddit: story.subreddit,
    username: authentic && story.author ? `u/${story.author}` : undefined,
    ageHours: authentic ? story.ageHours : undefined,
    upvotes: authentic ? formatCount(story.upvotes) : undefined,
    comments: authentic ? formatCount(story.comments) : undefined,
  };
}

function loopBackground(gameplay: string, total: number, out: string): Promise<string> {
  return new Promise((resolve, reject) => {
    ffmpeg(gameplay)
      .inputOptions(["-stream_loop", "-1"]) // loop the clip
      .outputOptions([
        "-t", total.toFixed(2),
        "-an", // drop gameplay audio
        "-vf",
        `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS}`,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-pix_fmt", "yuv420p",
      ])
      .output(out)
      .on("end", () => resolve(out))
      .on("error", (err) => reject(new Error(`Gameplay loop failed: ${err.message}`)))
      .run();
  });
}

function composite(
  bg: string,
  narr: string,
  assPath: string,
  card: { path: string; width: number; height: number },
  cardY: number,
  titleDur: number,
  out: string,
  outro?: { card?: { path: string; width: number; height: number }; start?: number }
): Promise<string> {
  const ass = assPath.replace(/'/g, "\\'");
  const en = titleDur.toFixed(2);
  const x = Math.round((W - card.width) / 2);
  const filters = [
    `[0:v]ass='${ass}'[base]`,
    `[base][2:v]overlay=${x}:${cardY}:enable='lt(t,${en})'[vtitle]`,
  ];
  let outputLabel = "vtitle";
  if (outro?.card && outro.start !== undefined) {
    const outroX = Math.round((W - outro.card.width) / 2);
    const outroY = Math.round((H - outro.card.height) / 2);
    filters.push(
      `[vtitle][3:v]overlay=${outroX}:${outroY}:enable='gte(t,${outro.start.toFixed(2)})'[vout]`
    );
    outputLabel = "vout";
  }

  return new Promise((resolve, reject) => {
    const command = ffmpeg()
      .input(bg) // 0: gameplay
      .input(narr) // 1: narration
      .input(card.path); // 2: reddit card png
    if (outro?.card) command.input(outro.card.path); // 3: outro card png
    command
      .complexFilter(filters, [outputLabel])
      .outputOptions([
        "-map", "1:a",
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "21",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        "-movflags", "+faststart",
      ])
      .output(out)
      .on("end", () => resolve(out))
      .on("error", (err) => reject(new Error(`Gameplay composite failed: ${err.message}`)))
      .run();
  });
}

// ============================================
// Bouncing word captions (portrait, centered) — the Reddit signature look.
// Length-weighted timing (same approach as reel-render) so cues track speech;
// the active word pops larger + amber.
// ============================================

function assTime(sec: number): string {
  const s = Math.max(sec, 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = (s % 60).toFixed(2);
  return `${h}:${m.toString().padStart(2, "0")}:${ss.padStart(5, "0")}`;
}

function wordWeight(w: string): number {
  return Math.max(w.replace(/[^A-Za-z0-9]/g, "").length, 1);
}

function buildBouncingCaptions(
  segs: { text: string; startTime: number; speech: number }[]
): string {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Arial,76,&H00FFFFFF,&H0000D7FF,&H00000000,&H90000000,-1,0,0,0,100,100,0,0,1,6,3,5,80,80,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const CHUNK = 3;
  const lines: string[] = [];

  for (const seg of segs) {
    const words = seg.text.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;

    const weights = words.map(wordWeight);
    const totalW = weights.reduce((a, b) => a + b, 0);
    const starts: number[] = [];
    const ends: number[] = [];
    let acc = 0;
    for (let i = 0; i < words.length; i++) {
      starts.push(seg.startTime + (acc / totalW) * seg.speech);
      acc += weights[i];
      ends.push(seg.startTime + (acc / totalW) * seg.speech);
    }

    for (let i = 0; i < words.length; i++) {
      const cs = Math.floor(i / CHUNK) * CHUNK;
      const chunk = words.slice(cs, cs + CHUNK);
      const active = i - cs;
      const text = chunk
        .map((w, k) =>
          k === active
            ? `{\\fscx118\\fscy118\\1c&H0000D7FF&}${w}{\\fscx100\\fscy100\\1c&H00FFFFFF&}`
            : w
        )
        .join(" ");
      lines.push(`Dialogue: 0,${assTime(starts[i])},${assTime(ends[i])},Cap,,0,0,0,,${text}`);
    }
  }

  return header + lines.join("\n") + "\n";
}
