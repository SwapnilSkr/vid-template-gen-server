// Download the bundled caption/thumbnail fonts into server/assets/fonts.
// Sources: Google Fonts (OFL-licensed static weights only — no variable fonts).
// Registry: server/src/config/fonts.ts (family names must match internal TTF names).
//
// Usage:
//   bun scripts/fetch-fonts.ts
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BUNDLED_FONTS, FONTS_DIR } from "../src/config/fonts";

const GOOGLE_FONTS_RAW =
  "https://github.com/google/fonts/raw/main";

/** Path under google/fonts repo → filename in assets/fonts */
const DOWNLOADS: Record<string, string> = {
  "Poppins-ExtraBold.ttf": `${GOOGLE_FONTS_RAW}/ofl/poppins/Poppins-ExtraBold.ttf`,
  "Poppins-Black.ttf": `${GOOGLE_FONTS_RAW}/ofl/poppins/Poppins-Black.ttf`,
  "Anton-Regular.ttf": `${GOOGLE_FONTS_RAW}/ofl/anton/Anton-Regular.ttf`,
  "ArchivoBlack-Regular.ttf": `${GOOGLE_FONTS_RAW}/ofl/archivoblack/ArchivoBlack-Regular.ttf`,
  "BebasNeue-Regular.ttf": `${GOOGLE_FONTS_RAW}/ofl/bebasneue/BebasNeue-Regular.ttf`,
  "BowlbyOne-Regular.ttf": `${GOOGLE_FONTS_RAW}/ofl/bowlbyone/BowlbyOne-Regular.ttf`,
  "Bangers-Regular.ttf": `${GOOGLE_FONTS_RAW}/ofl/bangers/Bangers-Regular.ttf`,
};

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error(`Suspiciously small file from ${url}`);
  await writeFile(dest, buf);
}

async function main() {
  const dir = resolve(FONTS_DIR);
  await mkdir(dir, { recursive: true });

  let ok = 0;
  for (const font of BUNDLED_FONTS) {
    const url = DOWNLOADS[font.file];
    if (!url) {
      console.warn(`⚠️  No download URL for ${font.file} — add it to DOWNLOADS`);
      continue;
    }
    const dest = join(dir, font.file);
    process.stdout.write(`↓ ${font.file} … `);
    await download(url, dest);
    console.log(`ok (${font.family})`);
    ok++;
  }

  console.log(`\n✅ ${ok}/${BUNDLED_FONTS.length} fonts in ${dir}`);
}

main().catch((err) => {
  console.error("fetch-fonts failed:", err);
  process.exit(1);
});
