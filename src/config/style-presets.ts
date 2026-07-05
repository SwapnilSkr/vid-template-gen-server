import type { ICaptionStyle, IAudioPost, ReelMotionMode } from "../models";

// ============================================
// Style presets — a named bundle of every creative default for a reel:
// art style + narration voice + caption look + motion + voice post-processing.
// Applied at creation/plan time to seed the reel; every field stays editable in
// the Studio afterward (this is the STARTING point, not a lock).
//
// The seed preset `classic_horror_comic` codifies the reverse-engineered study
// of the "the-lurker-story" reference reel (server/storage/yt-imports/…):
//   - full-color painterly horror motion-comic art (classic_horror_comic)
//   - deep dramatic male narrator (Grok "Rex", the horror default voice)
//   - one-word ALL-CAPS white captions, no karaoke highlight, sitting low-middle
//   - slow Ken Burns push-in on a few illustrations
// ============================================

export interface StylePresetVoice {
  model: string;
  voice: string;
  format: "mp3" | "pcm";
}

export interface StylePreset {
  id: string;
  displayName: string;
  description: string;
  /** niches this preset is offered for (matches config/niche-styles ids) */
  niches: string[];
  artStyleId: string;
  motionMode: ReelMotionMode;
  voice: StylePresetVoice;
  audioPost?: IAudioPost;
  captionStyle: ICaptionStyle;
  /** rough scene count the planner should aim for */
  sceneCountHint?: number;
}

/** The renderer's built-in caption look (mirror of the hardcoded ASS style in
 *  reel-render.buildPortraitKaraoke). Unset captionStyle fields fall back here,
 *  so an untouched reel renders exactly as before. */
export const DEFAULT_CAPTION_STYLE: Required<
  Omit<ICaptionStyle, "animation">
> & { animation: NonNullable<ICaptionStyle["animation"]> } = {
  fontName: "Arial",
  fontSize: 64,
  primaryColor: "#FFFFFF",
  activeColor: "#FFD700", // amber highlight (ASS &H0000D7FF)
  outlineColor: "#000000",
  outlineWidth: 4,
  shadow: 2,
  alignment: 2, // bottom-center
  marginV: 320,
  marginL: 90,
  marginR: 90,
  chunkSize: 4,
  bold: true,
  uppercase: false,
  animation: "none",
};

export const STYLE_PRESETS: Record<string, StylePreset> = {
  classic_horror_comic: {
    id: "classic_horror_comic",
    displayName: "Classic Horror Comic (The Lurker)",
    description:
      "Inked graphic-novel horror panels, deep dramatic male narrator, one-word ALL-CAPS captions, slow Ken Burns push-in. Reverse-engineered from the reference reel.",
    niches: ["horror", "horror_comic"],
    artStyleId: "classic_horror_comic",
    motionMode: "ken_burns",
    voice: { model: "x-ai/grok-voice-tts-1.0", voice: "Rex", format: "mp3" },
    audioPost: { voiceProfile: "horror" },
    sceneCountHint: 9,
    captionStyle: {
      // Heavy rounded sans matching the reference — bundled in server/assets/fonts
      // (config/fonts.ts), resolved by libass via fontsdir at render.
      fontName: "Poppins ExtraBold",
      fontSize: 72,
      primaryColor: "#FFFFFF",
      activeColor: "#FFFFFF", // == primary → NO karaoke highlight (plain white word)
      outlineColor: "#000000",
      outlineWidth: 5,
      shadow: 1,
      alignment: 2, // bottom-center …
      marginV: 480, // …pushed up to the lower-middle (~72–75% down on 1080×1920)
      marginL: 90,
      marginR: 90,
      chunkSize: 1, // one word at a time
      bold: true,
      uppercase: true, // ALL CAPS
      animation: "none",
    },
  },
};

export function getStylePreset(id?: string): StylePreset | undefined {
  return id ? STYLE_PRESETS[id] : undefined;
}

export function listStylePresets(niche?: string): StylePreset[] {
  const all = Object.values(STYLE_PRESETS);
  if (!niche) return all;
  return all.filter((preset) => preset.niches.includes(niche));
}

/** The default preset a niche starts from (horror → the Lurker look). */
export function defaultPresetFor(niche: string): StylePreset | undefined {
  if (niche.startsWith("horror")) return STYLE_PRESETS.classic_horror_comic;
  return undefined;
}
