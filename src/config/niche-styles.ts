// ============================================
// Per-niche style system — the FormatRecipe registry.
//
// Each niche declares a POOL of visual styles (rotated per-video to dodge
// YouTube's "templated slop" demonetization, while each single video stays
// visually consistent), plus the render strategy, image tier, motion, caption
// skin, music mood, hero policy, and the script guidance for the LLM planner.
//
// A "style" = an image-prompt suffix (produces the look) that the render
// strategy reinforces with motion/mood. Add a trending style = add an entry to
// a pool; no pipeline code changes. See docs/architecture/style-system.md.
// ============================================

import type { Tier } from "./models";
import type { ReelStrategy } from "../models/reel.model";

export interface VisualStyle {
  id: string;
  /** appended to each scene's visualPrompt at image-gen time */
  promptSuffix: string;
}

export type CaptionSkin =
  | "karaoke_word" // implemented: word-by-word amber highlight
  | "serif_lowerthird" // history / true crime / stoicism
  | "word_pop" // facts
  | "bold_center" // motivation
  | "kinetic_highlight" // finance
  | "lowerthird" // news
  | "epic_titlecard" // mythology
  | "minimal" // movie recap
  | "bouncing_word" // reddit/gameplay
  | "none"; // lo-fi

export interface NicheRecipe {
  niche: string;
  displayName: string;
  strategy: ReelStrategy;
  styles: VisualStyle[]; // rotation pool
  imageTier: Tier; // which image model quality to use
  sceneCount: number;
  motion: "ken_burns" | "loop_ambient" | "mograph" | "gameplay";
  captionSkin: CaptionSkin;
  musicMood: string;
  heroPolicy: "never" | "one_climax" | "trend_gated";
  /** optional narration voice character override (else tier default) */
  voice?: { model?: string; voice?: string; format?: "mp3" | "pcm" };
  /** LLM planner guidance (tone, structure, hook rules) */
  scriptGuide: string;
}

// ---- reusable style fragments ----
const S = {
  vintage_sepia: {
    id: "vintage_sepia",
    promptSuffix:
      "aged sepia archival photograph, heavy film grain, desaturated, low contrast, cinematic documentary still, vertical 9:16 composition",
  },
  noir_reconstruction: {
    id: "noir_reconstruction",
    promptSuffix:
      "moody noir crime-scene reconstruction, harsh low-key lighting, deep shadows, muted cold palette, film grain, vertical 9:16",
  },
  photoreal_cinematic: {
    id: "photoreal_cinematic",
    promptSuffix:
      "photorealistic cinematic still, film-stock reference, shallow depth of field, dramatic natural lighting, vertical 9:16",
  },
  photoreal_dark: {
    id: "photoreal_dark",
    promptSuffix:
      "hyperrealistic dark cinematic still, desaturated, deep shadows, fog, film grain, dread, vertical 9:16",
  },
  analog_liminal: {
    id: "analog_liminal",
    promptSuffix:
      "liminal space, empty fluorescent-lit interior, early-2000s camcorder footage, low resolution, VHS analog noise, uncanny emptiness, unsettling, vertical 9:16",
  },
  clean_editorial: {
    id: "clean_editorial",
    promptSuffix:
      "clean vivid editorial photograph, bright, high detail, shallow depth of field, vertical 9:16",
  },
  pixar_3d: {
    id: "pixar_3d",
    promptSuffix:
      "Pixar-style 3D render, expressive characters, soft subsurface scattering, warm rim lighting, polished, vertical 9:16",
  },
  claymation: {
    id: "claymation",
    promptSuffix:
      "stop-motion clay animation, visible fingerprint texture, polymer clay, soft studio lighting, Aardman style, slight imperfections, vertical 9:16",
  },
  anime_cel: {
    id: "anime_cel",
    promptSuffix:
      "cel-shaded anime illustration, dynamic lighting, bold linework, motion blur, vibrant, vertical 9:16",
  },
  painterly_epic: {
    id: "painterly_epic",
    promptSuffix:
      "epic painterly concept art, dramatic god-rays, rich color, cinematic scale, fantasy illustration, vertical 9:16",
  },
  marble_classical: {
    id: "marble_classical",
    promptSuffix:
      "classical marble statue and ancient ruins, soft museum lighting, muted stone tones, timeless, film grain, vertical 9:16",
  },
  hyperreal_cosmic: {
    id: "hyperreal_cosmic",
    promptSuffix:
      "hyperreal cosmic space photography, nebulae, stars, planetary detail, NASA-grade, awe-inspiring, vertical 9:16",
  },
  flat_mograph: {
    id: "flat_mograph",
    promptSuffix:
      "clean flat 2D motion-graphics illustration, bold minimal shapes, limited palette, infographic style, crisp icons, vertical 9:16",
  },
  ghibli_cozy: {
    id: "ghibli_cozy",
    promptSuffix:
      "Studio Ghibli 2D animation, hand-painted backgrounds, watercolor textures, soft pastel palette, cozy, vertical 9:16",
  },
  surreal_whatif: {
    id: "surreal_whatif",
    promptSuffix:
      "photorealistic surreal counterfactual scene treated as documentary-normal, cinematic, specific, vertical 9:16",
  },
} satisfies Record<string, VisualStyle>;

// ============================================
// Niche recipes
// ============================================
export const NICHE_RECIPES: Record<string, NicheRecipe> = {
  dark_history: {
    niche: "dark_history",
    displayName: "Dark History",
    strategy: "image_kenburns",
    styles: [S.vintage_sepia],
    imageTier: "cheap",
    sceneCount: 5,
    motion: "ken_burns",
    captionSkin: "serif_lowerthird",
    musicMood: "somber_strings",
    heroPolicy: "never",
    scriptGuide:
      "Eerie factual dark-history micro-documentary. Cold-open with a gripping hook, build tension, end on an unsettling or unresolved note. Authoritative, measured narrator.",
  },

  true_crime: {
    niche: "true_crime",
    displayName: "True Crime",
    strategy: "image_kenburns",
    styles: [S.noir_reconstruction, S.vintage_sepia],
    imageTier: "cheap",
    sceneCount: 6,
    motion: "ken_burns",
    captionSkin: "serif_lowerthird",
    musicMood: "tense_ambient",
    heroPolicy: "trend_gated",
    scriptGuide:
      "Suspenseful true-crime case file. Open on the most gripping detail, build the mystery beat by beat, withhold the twist until the end. Measured, ominous narrator.",
  },

  facts: {
    niche: "facts",
    displayName: "Did You Know / Facts",
    strategy: "image_kenburns",
    styles: [S.clean_editorial, S.pixar_3d],
    imageTier: "cheap",
    sceneCount: 5,
    motion: "ken_burns",
    captionSkin: "word_pop",
    musicMood: "upbeat_minimal",
    heroPolicy: "never",
    scriptGuide:
      "Punchy 'did you know' facts reel. Surprising hook, 3-4 escalating fascinating facts, end on the most mind-blowing one. Energetic narrator.",
  },

  fun_facts: {
    niche: "fun_facts",
    displayName: "Fun Facts (Claymation/Pixar)",
    strategy: "image_kenburns",
    styles: [S.claymation, S.pixar_3d],
    imageTier: "value",
    sceneCount: 5,
    motion: "ken_burns",
    captionSkin: "word_pop",
    musicMood: "playful",
    heroPolicy: "never",
    scriptGuide:
      "Light, playful fun-facts reel with charm. Friendly hook, quirky escalating facts, satisfying button at the end. Warm, fun narrator.",
  },

  motivation: {
    niche: "motivation",
    displayName: "Motivation / Mindset",
    strategy: "image_kenburns",
    styles: [S.photoreal_cinematic],
    imageTier: "cheap",
    sceneCount: 5,
    motion: "ken_burns",
    captionSkin: "bold_center",
    musicMood: "epic_build",
    heroPolicy: "never",
    scriptGuide:
      "Powerful motivational monologue. Confrontational hook, escalating conviction, memorable closing line. Intense, inspiring narrator.",
  },

  stoicism: {
    niche: "stoicism",
    displayName: "Stoicism / Philosophy",
    strategy: "image_kenburns",
    styles: [S.marble_classical],
    imageTier: "cheap",
    sceneCount: 5,
    motion: "ken_burns",
    captionSkin: "serif_lowerthird",
    musicMood: "soft_piano",
    heroPolicy: "never",
    scriptGuide:
      "Calm stoic-philosophy reflection. Timeless hook, one core lesson unpacked slowly with a classical reference, quiet resonant close. Slow, wise narrator.",
  },

  finance: {
    niche: "finance",
    displayName: "Personal Finance",
    // motion_graphics not built yet → image_kenburns w/ flat mograph stills
    strategy: "image_kenburns",
    styles: [S.flat_mograph, S.clean_editorial],
    imageTier: "cheap",
    sceneCount: 5,
    motion: "ken_burns",
    captionSkin: "kinetic_highlight",
    musicMood: "upbeat_minimal",
    heroPolicy: "never",
    scriptGuide:
      "Sharp personal-finance tip reel. Money-hook with a concrete number, deliver 3-4 clear actionable points, end with the key takeaway. Confident, crisp narrator. Spell numbers for TTS.",
  },

  science_space: {
    niche: "science_space",
    displayName: "Science & Space",
    strategy: "image_kenburns",
    styles: [S.hyperreal_cosmic],
    imageTier: "value",
    sceneCount: 5,
    motion: "ken_burns",
    captionSkin: "word_pop",
    musicMood: "ambient_swell",
    heroPolicy: "trend_gated",
    scriptGuide:
      "Awe-driven science/space reel. Mind-expanding hook, escalating scale of wonder, end on a cosmic-perspective gut-punch. Warm, awe-toned narrator.",
  },

  horror: {
    niche: "horror",
    displayName: "AI Horror",
    strategy: "hybrid_scene",
    styles: [S.analog_liminal, S.photoreal_dark],
    imageTier: "value",
    sceneCount: 5,
    motion: "ken_burns",
    captionSkin: "karaoke_word",
    musicMood: "ambient_drone",
    heroPolicy: "one_climax",
    voice: { voice: "am_onyx" }, // deeper delivery (Kokoro) until TTS upgrade
    scriptGuide:
      "Creepy short horror narration (urban legend / unexplained). Whispered ominous tone, hook in the first line, escalate dread, end on a chilling twist.",
  },

  mythology: {
    niche: "mythology",
    displayName: "Mythology / Dark Fantasy",
    strategy: "hybrid_scene",
    styles: [S.painterly_epic, S.anime_cel],
    imageTier: "value",
    sceneCount: 6,
    motion: "ken_burns",
    captionSkin: "epic_titlecard",
    musicMood: "orchestral_choir",
    heroPolicy: "one_climax",
    scriptGuide:
      "Epic mythology/dark-fantasy lore. Grand hook, dramatic retelling of a god/monster/legend, awe-and-dread close. Deep, dramatic narrator.",
  },

  movie_recap: {
    niche: "movie_recap",
    displayName: "Movie Recap / What-If",
    strategy: "hybrid_scene",
    styles: [S.photoreal_cinematic, S.surreal_whatif],
    imageTier: "value",
    sceneCount: 6,
    motion: "ken_burns",
    captionSkin: "minimal",
    musicMood: "tension_score",
    heroPolicy: "one_climax",
    scriptGuide:
      "Brisk cinematic recap or 'what if' counterfactual. Intriguing hook, fast-moving beats, satisfying or twist ending. Engaging, cinematic narrator.",
  },

  lofi: {
    niche: "lofi",
    displayName: "Lo-Fi Cozy Loop",
    strategy: "image_kenburns",
    styles: [S.ghibli_cozy],
    imageTier: "cheap",
    sceneCount: 2,
    motion: "loop_ambient",
    captionSkin: "none",
    musicMood: "lofi_beats",
    heroPolicy: "never",
    scriptGuide:
      "No narration — cozy loopable ambient scene concept only. Provide 1-2 gentle scene descriptions; the music is the product.",
  },
};

/** Reddit-style gameplay format (no AI images — separate strategy). */
export const GAMEPLAY_RECIPE: NicheRecipe = {
  niche: "reddit",
  displayName: "Reddit / AITA Story",
  strategy: "gameplay_overlay",
  styles: [],
  imageTier: "cheap",
  sceneCount: 1,
  motion: "gameplay",
  captionSkin: "bouncing_word",
  musicMood: "subtle_bed",
  heroPolicy: "never",
  scriptGuide:
    "Read a gripping Reddit-style story (AITA / confession / revenge). The title is the curiosity-gap hook. Conversational first-person, escalating tension, satisfying payoff.",
};

export function getRecipe(niche: string): NicheRecipe {
  if (niche === "reddit" || niche === "aita") return GAMEPLAY_RECIPE;
  return NICHE_RECIPES[niche] ?? NICHE_RECIPES.dark_history;
}

/** Pick one style from the niche's pool (rotation → anti-slop across videos). */
export function pickStyle(recipe: NicheRecipe, seed = Math.random()): VisualStyle {
  if (!recipe.styles.length) {
    return { id: "none", promptSuffix: "vertical 9:16 composition" };
  }
  const idx = Math.floor(seed * recipe.styles.length) % recipe.styles.length;
  return recipe.styles[idx];
}
