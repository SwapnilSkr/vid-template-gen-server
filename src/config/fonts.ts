import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ============================================
// Bundled fonts (server/assets/fonts) used for burned-in captions (ASS, matched
// by `family`) and custom thumbnail text (ffmpeg drawtext, by `file` path).
// Static single-weight display faces only — the heavy/rounded look viral
// captions use, with predictable weights (no variable-font default-weight
// surprises). Add a .ttf here + one entry to expose it in the pickers.
//
// Path is anchored to the server package root (not process.cwd()) so fonts
// resolve correctly when the process is started from a different directory
// (Windows services, PM2, monorepo root, etc.).
// ============================================

/** server/ — parent of src/config/ */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

export interface BundledFont {
  id: string;
  label: string;
  /** Internal family name — used as the ASS `Fontname` for captions. */
  family: string;
  /** Filename under FONTS_DIR — used as the ffmpeg drawtext `fontfile`. */
  file: string;
}

export const FONTS_DIR = join(PACKAGE_ROOT, "assets", "fonts");

/** Prefer this over a frozen constant — fonts may be fetched after boot. */
export function hasFontsDir(): boolean {
  return existsSync(FONTS_DIR);
}

/** True only when at least one registered TTF is on disk (not merely an empty dir). */
export function hasBundledFonts(): boolean {
  return listFonts().length > 0;
}

/** @deprecated Use hasFontsDir() / hasBundledFonts() — import-time snapshot only. */
export const HAS_FONTS_DIR = hasFontsDir();

export const BUNDLED_FONTS: BundledFont[] = [
  { id: "poppins_extrabold", label: "Poppins ExtraBold (bold rounded)", family: "Poppins ExtraBold", file: "Poppins-ExtraBold.ttf" },
  { id: "poppins_black", label: "Poppins Black (heaviest)", family: "Poppins Black", file: "Poppins-Black.ttf" },
  { id: "anton", label: "Anton (tall impact)", family: "Anton", file: "Anton-Regular.ttf" },
  { id: "archivo_black", label: "Archivo Black (grotesque)", family: "Archivo Black", file: "ArchivoBlack-Regular.ttf" },
  { id: "bebas_neue", label: "Bebas Neue (condensed)", family: "Bebas Neue", file: "BebasNeue-Regular.ttf" },
  { id: "bowlby_one", label: "Bowlby One (chunky rounded)", family: "Bowlby One", file: "BowlbyOne-Regular.ttf" },
  { id: "bangers", label: "Bangers (comic)", family: "Bangers", file: "Bangers-Regular.ttf" },
];

/** Default ASS Fontname — always a bundled face so Linux/Windows don't depend on Arial. */
export const DEFAULT_BUNDLED_FONT_FAMILY = "Poppins ExtraBold";

export function listFonts(): BundledFont[] {
  return BUNDLED_FONTS.filter((f) => existsSync(join(FONTS_DIR, f.file)));
}

/** Absolute path to a font file by family name (for ffmpeg drawtext). */
export function fontFilePathByFamily(family?: string): string | undefined {
  const font = BUNDLED_FONTS.find((f) => f.family === family);
  if (!font) return undefined;
  const path = join(FONTS_DIR, font.file);
  return existsSync(path) ? path : undefined;
}
