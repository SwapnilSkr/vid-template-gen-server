// ============================================
// Reference-art style registry — the "Art Themes" the horror niches can be
// generated in (the FacelessReels "pick an art style" feature).
//
// An ArtStyle = a named look defined by (a) a prompt suffix that pushes the
// image model toward the aesthetic AND (b) 1-N reference images stored in S3
// (`art-styles/<id>/ref-*.png`) that are fed to the image model as
// `input_references` so generated stills actually FOLLOW a concrete artwork,
// not just a text description. Reference images are seeded by
// `scripts/ingest-art-styles.ts` and listed at runtime via
// `art-style.service.ts` (registry ∪ S3 manifest).
//
// Add a trending look = add an entry here + drop reference art in S3. No
// pipeline code changes. Rotation across a niche's styles dodges YouTube's
// "templated slop" demonetization while each single reel stays consistent.
// ============================================

import { cdnUrlFor } from "../services/s3.service";

export interface ArtStyle {
  id: string;
  displayName: string;
  /** niches this style is offered for (e.g. "horror", "horror_comic") */
  niches: string[];
  /** appended to each scene's visualPrompt at image-gen time */
  promptSuffix: string;
  /** S3 keys of the reference artwork(s) for this style, under art-styles/<id>/ */
  referenceKeys: string[];
  /** short human blurb for the picker UI */
  description: string;
  /** preferred motion feel — advisory only, the reel's motionMode still wins */
  motionHint?: "parallax" | "ai_motion";
}

// Reference keys follow `art-styles/<id>/ref-N.<ext>`; the ingest script writes
// the exact list into art-styles/manifest.json, which the service prefers over
// these defaults. Two refs per style is the sweet spot (style anchor + variety)
// and stays under every provider's input_references cap.
export const ART_STYLES: Record<string, ArtStyle> = {
  ink_horror_comic: {
    id: "ink_horror_comic",
    displayName: "Ink Horror Comic",
    niches: ["horror", "horror_comic"],
    promptSuffix:
      "2D horror motion-comic panel, black ink line art, heavy crosshatching, halftone dots, harsh noir shadows, off-white paper texture, limited palette of black white dirty red and sickly green, unsettling graphic-novel composition, vertical 9:16",
    referenceKeys: ["art-styles/ink_horror_comic/ref-1.png", "art-styles/ink_horror_comic/ref-2.png"],
    description: "High-contrast inked graphic-novel panels — crosshatching, halftones, dirty red accents.",
    motionHint: "parallax",
  },
  junji_ito_manga: {
    id: "junji_ito_manga",
    displayName: "Junji-Ito Manga",
    niches: ["horror", "horror_comic"],
    promptSuffix:
      "black-and-white horror manga illustration, obsessive fine-line ink detail, dense hatching, spiral motifs, warped anatomy, deep flat blacks, unsettling stillness, vertical 9:16",
    referenceKeys: ["art-styles/junji_ito_manga/ref-1.png", "art-styles/junji_ito_manga/ref-2.png"],
    description: "Obsessive fine-line horror manga — dense hatching, warped detail, dread in stillness.",
    motionHint: "parallax",
  },
  analog_liminal_photo: {
    id: "analog_liminal_photo",
    displayName: "Analog Liminal",
    niches: ["horror"],
    promptSuffix:
      "liminal space, empty fluorescent-lit interior, early-2000s camcorder footage, low resolution, VHS analog noise, chromatic aberration, uncanny emptiness, unsettling, vertical 9:16",
    // Photographic look — driven by the prompt suffix, not a reference artwork.
    referenceKeys: [],
    description: "Backrooms/Kane-Pixels aesthetic — low-res VHS, empty fluorescent spaces, uncanny.",
    motionHint: "ai_motion",
  },
  charcoal_dread: {
    id: "charcoal_dread",
    displayName: "Charcoal Dread",
    niches: ["horror"],
    promptSuffix:
      "smudged charcoal and graphite drawing, rough newsprint paper grain, heavy black shadows, scratchy expressive strokes, monochrome with faint sepia, fine-art horror sketch, vertical 9:16",
    referenceKeys: ["art-styles/charcoal_dread/ref-1.png", "art-styles/charcoal_dread/ref-2.png"],
    description: "Smudged charcoal sketch on newsprint — scratchy strokes, heavy shadow, fine-art dread.",
    motionHint: "parallax",
  },
  gothic_storybook: {
    id: "gothic_storybook",
    displayName: "Gothic Storybook",
    niches: ["horror"],
    promptSuffix:
      "dark gothic storybook illustration, muted painterly watercolor, ink outlines, candlelit palette of deep teal and rust, Victorian dread, textured paper, vertical 9:16",
    referenceKeys: ["art-styles/gothic_storybook/ref-1.png", "art-styles/gothic_storybook/ref-2.png"],
    description: "Painterly gothic fairy-tale — muted watercolor, ink outlines, candlelit Victorian dread.",
    motionHint: "parallax",
  },
  cinematic_dark: {
    id: "cinematic_dark",
    displayName: "Cinematic Dark",
    niches: ["horror"],
    promptSuffix:
      "hyperrealistic dark cinematic still, film-stock reference, desaturated, deep shadows, volumetric fog, shallow depth of field, film grain, dread, vertical 9:16",
    // Photoreal look — reference paintings would push it painterly, so prompt-only.
    referenceKeys: [],
    description: "Photoreal cinematic horror — desaturated, foggy, shallow DOF, film grain.",
    motionHint: "ai_motion",
  },

  // ---- Genuine animation styles (references GENERATED via OpenRouter, one-time,
  //      then uploaded to S3 by `scripts/ingest-art-styles.ts --generate`). ----
  cartoon_3d_story: {
    id: "cartoon_3d_story",
    displayName: "3D Cartoon Story",
    niches: ["horror", "horror_comic"],
    promptSuffix:
      "semi-realistic 3D cartoon illustration, expressive exaggerated wide eyes, soft subsurface skin shading, cinematic dramatic lighting, detailed fabric and hair texture, muted filmic color grade, short-form storytime animation still, vertical 9:16",
    referenceKeys: ["art-styles/cartoon_3d_story/ref-1.png"],
    description: "The viral 'storytime' look — semi-realistic 3D cartoon, big expressive eyes, cinematic lighting.",
    motionHint: "ai_motion",
  },
  pixar_3d: {
    id: "pixar_3d",
    displayName: "Pixar 3D",
    niches: ["horror", "horror_comic"],
    promptSuffix:
      "Pixar-style 3D animated render, expressive character faces, soft global illumination, subsurface scattering, warm rim light, polished cinematic depth, vertical 9:16",
    referenceKeys: ["art-styles/pixar_3d/ref-1.png"],
    description: "Polished Pixar-style 3D — soft global illumination, expressive characters.",
    motionHint: "ai_motion",
  },
  dark_anime: {
    id: "dark_anime",
    displayName: "Dark Anime",
    niches: ["horror", "horror_comic"],
    promptSuffix:
      "dark cel-shaded anime illustration, dramatic rim lighting, bold clean linework, moody desaturated palette, detailed backgrounds, seinen horror manga-anime style, vertical 9:16",
    referenceKeys: ["art-styles/dark_anime/ref-1.png"],
    description: "Moody cel-shaded anime — dramatic light, seinen-horror tone.",
    motionHint: "ai_motion",
  },
  comic_book_color: {
    id: "comic_book_color",
    displayName: "Comic Book",
    niches: ["horror", "horror_comic"],
    promptSuffix:
      "western comic book illustration, bold black ink outlines, flat cel shading, Ben-Day halftone dots, dramatic saturated colors, graphic-novel panel composition, vertical 9:16",
    referenceKeys: ["art-styles/comic_book_color/ref-1.png"],
    description: "Colored western comic — bold ink, halftones, graphic-novel drama.",
    motionHint: "parallax",
  },
  claymation: {
    id: "claymation",
    displayName: "Claymation",
    niches: ["horror", "horror_comic"],
    promptSuffix:
      "stop-motion clay animation, visible fingerprint texture, polymer clay characters, soft studio lighting, Aardman style, slightly uncanny, vertical 9:16",
    referenceKeys: ["art-styles/claymation/ref-1.png"],
    description: "Stop-motion clay — thumbprint texture, Aardman-style, subtly uncanny.",
    motionHint: "ai_motion",
  },
};

export function getArtStyle(id?: string): ArtStyle | undefined {
  if (!id) return undefined;
  return ART_STYLES[id];
}

/** Every style offered for a niche (for the picker). */
export function artStylesForNiche(niche: string): ArtStyle[] {
  return Object.values(ART_STYLES).filter((style) => style.niches.includes(niche));
}

/** Pick one style from a niche's set (rotation → anti-slop across videos). */
export function pickArtStyle(niche: string, seed = Math.random()): ArtStyle | undefined {
  const pool = artStylesForNiche(niche);
  if (!pool.length) return undefined;
  const idx = Math.floor(seed * pool.length) % pool.length;
  return pool[idx];
}

/** Resolve a style's reference S3 keys to public CDN URLs for `input_references`. */
export function artStyleRefUrls(style: ArtStyle, keysOverride?: string[]): string[] {
  return (keysOverride ?? style.referenceKeys).map((key) => cdnUrlFor(key));
}
