import { join } from "node:path";
import { existsSync } from "node:fs";

// ============================================
// Bundled fonts (server/assets/fonts) used for burned-in captions (ASS, matched
// by `family`) and custom thumbnail text (ffmpeg drawtext, by `file` path).
// Static single-weight display faces only — the heavy/rounded look viral
// captions use, with predictable weights (no variable-font default-weight
// surprises). Add a .ttf here + one entry to expose it in the pickers.
// ============================================

export interface BundledFont {
  id: string;
  label: string;
  /** Internal family name — used as the ASS `Fontname` for captions. */
  family: string;
  /** Filename under FONTS_DIR — used as the ffmpeg drawtext `fontfile`. */
  file: string;
}

export const FONTS_DIR = join(process.cwd(), "assets", "fonts");
export const HAS_FONTS_DIR = existsSync(FONTS_DIR);

export const BUNDLED_FONTS: BundledFont[] = [
  { id: "poppins_extrabold", label: "Poppins ExtraBold (bold rounded)", family: "Poppins ExtraBold", file: "Poppins-ExtraBold.ttf" },
  { id: "poppins_black", label: "Poppins Black (heaviest)", family: "Poppins Black", file: "Poppins-Black.ttf" },
  { id: "anton", label: "Anton (tall impact)", family: "Anton", file: "Anton-Regular.ttf" },
  { id: "archivo_black", label: "Archivo Black (grotesque)", family: "Archivo Black", file: "ArchivoBlack-Regular.ttf" },
  { id: "bebas_neue", label: "Bebas Neue (condensed)", family: "Bebas Neue", file: "BebasNeue-Regular.ttf" },
  { id: "bowlby_one", label: "Bowlby One (chunky rounded)", family: "Bowlby One", file: "BowlbyOne-Regular.ttf" },
  { id: "bangers", label: "Bangers (comic)", family: "Bangers", file: "Bangers-Regular.ttf" },
];

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
