// Download the bundled caption/thumbnail fonts into server/assets/fonts.
// Sources: Google Fonts (OFL-licensed static weights only — no variable fonts).
// Registry: server/src/config/fonts.ts (family names must match internal TTF names).
//
// Usage:
//   bun scripts/fetch-fonts.ts
import { mkdir, writeFile, access } from "node:fs/promises";
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function download(url: string, dest: string, attempts = 4): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status >= 500) {
        const wait = 800 * (i + 1);
        console.warn(`HTTP ${res.status}, retry in ${wait}ms…`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024) throw new Error(`Suspiciously small file from ${url}`);
      await writeFile(dest, buf);
      return;
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 800 * (i + 1)));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function main() {
  const dir = resolve(FONTS_DIR);
  await mkdir(dir, { recursive: true });

  let ok = 0;
  let skipped = 0;
  let failed = 0;
  for (const font of BUNDLED_FONTS) {
    const url = DOWNLOADS[font.file];
    if (!url) {
      console.warn(`⚠️  No download URL for ${font.file} — add it to DOWNLOADS`);
      failed++;
      continue;
    }
    const dest = join(dir, font.file);
    if (await exists(dest)) {
      console.log(`✓ ${font.file} (already present)`);
      ok++;
      skipped++;
      continue;
    }
    process.stdout.write(`↓ ${font.file} … `);
    try {
      await download(url, dest);
      console.log(`ok (${font.family})`);
      ok++;
    } catch (error) {
      failed++;
      console.log(`FAILED (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  console.log(
    `\n${failed ? "⚠️" : "✅"} ${ok}/${BUNDLED_FONTS.length} fonts in ${dir}` +
      (skipped ? ` (${skipped} skipped)` : "") +
      (failed ? ` — ${failed} missing` : "")
  );
  // Docker builds set FETCH_FONTS_STRICT=1 so a partial download fails the image
  // build instead of shipping without caption fonts.
  const strict = process.env.FETCH_FONTS_STRICT === "1" || process.env.FETCH_FONTS_STRICT === "true";
  if (failed && (strict || ok === 0)) process.exit(1);
}

main().catch((err) => {
  console.error("fetch-fonts failed:", err);
  process.exit(1);
});
