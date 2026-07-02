import { Resvg } from "@resvg/resvg-js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { ensureDir, generateFilename } from "../utils";

// ============================================
// Premium Reddit post card (SVG → PNG). An authentic-looking card — rounded
// corners, drop shadow, avatar, subreddit + username, upvote/comment row — that
// the gameplay renderer overlays during the title narration. Far more premium
// than a flat drawbox, and titles wrap cleanly so they never overflow.
// ============================================

const CARD_W = 1000;
const PAD = 40;

export interface RedditCardOpts {
  subreddit?: string;
  username?: string;
  ageHours?: number;
  upvotes?: string;
  comments?: string;
}

const AVATAR_COLORS = ["#FF4500", "#0079D3", "#7193FF", "#00A368", "#FF585B", "#9B59B6", "#EFB000"];
const NAME_PARTS = [
  "throwaway", "anon", "confused", "quiet", "tired", "petty", "curious", "notthe",
  "just", "reluctant", "former", "the_real", "mildly", "sudden",
];
const SUBREDDITS = ["r/AmItheAsshole", "r/relationships", "r/pettyrevenge", "r/entitledparents", "r/JUSTNOMIL", "r/tifu", "r/confession"];

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function pick<T>(a: T[]): T {
  return a[Math.floor(Math.random() * a.length)];
}

/** Word-wrap by approximate character budget for the card's inner width. */
function wrap(title: string, max = 32): string[] {
  const words = title.trim().split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max && cur) {
      lines.push(cur);
      cur = w;
    } else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Render a Reddit post card PNG. Returns path + dimensions for overlay. */
export async function renderRedditCard(
  title: string,
  opts: RedditCardOpts = {}
): Promise<{ path: string; width: number; height: number }> {
  await ensureDir(config.processingPath);

  const subreddit = opts.subreddit ?? pick(SUBREDDITS);
  const username = opts.username ?? `u/${pick(NAME_PARTS)}_${Math.floor(Math.random() * 9000 + 1000)}`;
  const age = opts.ageHours ?? Math.floor(Math.random() * 11) + 2;
  const upvotes = opts.upvotes ?? `${(Math.random() * 20 + 4).toFixed(1)}k`;
  const comments = opts.comments ?? `${(Math.random() * 3 + 0.4).toFixed(1)}k`;
  const avColor = pick(AVATAR_COLORS);

  const lines = wrap(title);
  const titleTop = 158;
  const lineH = 52;
  const lastBaseline = titleTop + (lines.length - 1) * lineH;
  const footerY = lastBaseline + 66;
  const height = footerY + 46;

  const tspans = lines
    .map((ln, i) => `<tspan x="${PAD}" dy="${i === 0 ? 0 : lineH}">${esc(ln)}</tspan>`)
    .join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${height}" viewBox="0 0 ${CARD_W} ${height}">
  <defs>
    <filter id="sh" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="8" stdDeviation="16" flood-color="#000000" flood-opacity="0.30"/>
    </filter>
  </defs>
  <rect x="14" y="14" width="${CARD_W - 28}" height="${height - 28}" rx="30" fill="#ffffff" filter="url(#sh)"/>
  <!-- header -->
  <circle cx="${PAD + 28}" cy="70" r="28" fill="${avColor}"/>
  <text x="${PAD + 28}" y="80" font-family="Arial" font-size="30" fill="#ffffff" text-anchor="middle" font-weight="bold">${esc(subreddit[2]?.toUpperCase() ?? "R")}</text>
  <text x="${PAD + 74}" y="60" font-family="Arial" font-size="27" fill="#1a1a1b" font-weight="bold">${esc(subreddit)}</text>
  <text x="${PAD + 74}" y="92" font-family="Arial" font-size="23" fill="#787c7e">${esc(username)} · ${age}h</text>
  <!-- title -->
  <text x="${PAD}" y="${titleTop}" font-family="Arial" font-size="43" fill="#1a1a1b" font-weight="bold">${tspans}</text>
  <!-- footer: upvote + comments -->
  <path d="M ${PAD + 16} ${footerY - 16} l 16 -18 l 16 18 l -9 0 l 0 16 l -14 0 l 0 -16 z" fill="#ff4500"/>
  <text x="${PAD + 62}" y="${footerY}" font-family="Arial" font-size="27" fill="#1a1a1b" font-weight="bold">${esc(upvotes)}</text>
  <circle cx="${PAD + 200}" cy="${footerY - 9}" r="4" fill="#878a8c"/>
  <path d="M ${PAD + 236} ${footerY - 24} h 44 a 10 10 0 0 1 10 10 v 16 a 10 10 0 0 1 -10 10 h -30 l -14 12 v -12 a 10 10 0 0 1 0 -20 z" fill="none" stroke="#878a8c" stroke-width="3"/>
  <text x="${PAD + 300}" y="${footerY}" font-family="Arial" font-size="27" fill="#787c7e">${esc(comments)}</text>
</svg>`;

  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: CARD_W },
    font: { loadSystemFonts: true },
  })
    .render()
    .asPng();

  const path = join(config.processingPath, generateFilename("card", "png"));
  await writeFile(path, png);
  return { path, width: CARD_W, height };
}

/** Render a bold end card for multipart Reddit reels. */
export async function renderPartOutroCard(
  nextPart: number
): Promise<{ path: string; width: number; height: number }> {
  await ensureDir(config.processingPath);

  const height = 420;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${height}" viewBox="0 0 ${CARD_W} ${height}">
  <defs>
    <filter id="sh" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="10" stdDeviation="18" flood-color="#000000" flood-opacity="0.34"/>
    </filter>
  </defs>
  <rect x="14" y="14" width="${CARD_W - 28}" height="${height - 28}" rx="30" fill="#ffffff" filter="url(#sh)"/>
  <text x="${CARD_W / 2}" y="122" font-family="Arial" font-size="34" fill="#ff4500" text-anchor="middle" font-weight="bold" letter-spacing="2">STAY TUNED</text>
  <text x="${CARD_W / 2}" y="224" font-family="Arial" font-size="74" fill="#1a1a1b" text-anchor="middle" font-weight="bold">Part ${nextPart} is next</text>
  <text x="${CARD_W / 2}" y="306" font-family="Arial" font-size="34" fill="#787c7e" text-anchor="middle">Follow for the update</text>
  <path d="M 421 346 l 38 0 l 0 -38 l 82 58 l -82 58 l 0 -38 l -38 0 z" fill="#ff4500"/>
</svg>`;

  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: CARD_W },
    font: { loadSystemFonts: true },
  })
    .render()
    .asPng();

  const path = join(config.processingPath, generateFilename("outro-card", "png"));
  await writeFile(path, png);
  return { path, width: CARD_W, height };
}
