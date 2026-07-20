// ============================================
// Motivation / podcast-clipper genre — SHARED CONTRACTS.
//
// This file is the single source of truth that every motivation-genre service
// is built against. It is written BEFORE the services so that independently
// built pieces (music analysis, moment mining, reframing, timeline render, UI)
// compose without renegotiation.
//
// RULE: services import these types. They do not redefine them locally, and
// they do not widen them. If a field is genuinely missing, change it HERE and
// let the change propagate — do not shadow it.
//
// Pipeline shape (extractive, unlike the generative reel pipeline):
//
//   PodcastImport ──┐
//                   ├─> MomentCandidate[] ──> MotivationTimeline ──> mp4
//   MusicTrack ─────┘         (mining)            (arrange+render)
//                   │
//   ReframeTrack ───┘
// ============================================

// ---------------------------------------------------------------------------
// 1. MUSIC ANALYSIS  (music-analysis.service.ts)
// ---------------------------------------------------------------------------

/** A structural region of a track. `drop` is the emotional peak we align to. */
export type MusicSectionKind = "intro" | "build" | "drop" | "breakdown" | "outro";

export interface MusicSection {
  /** Section start, seconds from track start. */
  start: number;
  /** Section end, seconds from track start. */
  end: number;
  kind: MusicSectionKind;
  /** Mean normalized energy 0-1 across the section. Drives b-roll energy match. */
  energy: number;
}

/**
 * Everything we know about a track's rhythm and shape. Computed ONCE per track
 * and cached on the YtImport document — never recomputed at render time.
 *
 * Derived with zero new native binaries: FFmpeg `ebur128` gives a momentary
 * loudness envelope; BPM comes from autocorrelating the envelope's positive
 * difference; the beat grid is that BPM phase-locked to the strongest onsets.
 */
export interface MusicMap {
  /** Schema version — bump when the analysis algorithm changes so caches invalidate. */
  version: number;
  /** Track duration in seconds. */
  duration: number;
  /** Detected tempo. Null when the track has no stable pulse (ambient/rubato). */
  bpm: number | null;
  /** Confidence in `bpm` and `beats`, 0-1. Below 0.5, treat the grid as advisory. */
  bpmConfidence: number;
  /** Beat onsets in seconds. Empty when bpm is null. */
  beats: number[];
  /** Every 4th beat (bar starts) — b-roll cuts should prefer these over plain beats. */
  downbeats: number[];
  /** Structural segmentation, gap-free and ordered, covering [0, duration]. */
  sections: MusicSection[];
  /**
   * THE landmark. Seconds from track start to the moment the track "opens up".
   * The payoff line of the clip is aligned to this. Null only if undetectable,
   * in which case arrangement falls back to `sections`.
   */
  dropAt: number | null;
  /** Normalized loudness envelope, 0-1, sampled every `energyBinMs`. */
  energyCurve: number[];
  /** Bin width of `energyCurve` in milliseconds. */
  energyBinMs: number;
}

export const MUSIC_MAP_VERSION = 1;

/**
 * Whether a track may be burned into a rendered video.
 *  - licensed / cc  : safe to burn in and publish.
 *  - reference_only : analysis + preview ONLY. The publish guard must block any
 *                     reel whose music track is reference_only. Used to derive
 *                     the structural template from a commercial track before
 *                     substituting a cleared one.
 */
export type MusicLicenseStatus = "licensed" | "cc" | "reference_only";

export interface MusicTrackRef {
  /** YtImport _id of the audio-only import. */
  importId: string;
  title: string;
  artist?: string;
  licenseStatus: MusicLicenseStatus;
}

// ---------------------------------------------------------------------------
// 2. MOMENT MINING  (moment-mining.service.ts)
// ---------------------------------------------------------------------------

/** Per-axis scoring of a candidate clip. Each 0-10. */
export interface MomentScores {
  /** Does the first ~3s stop a scroll? */
  hook: number;
  /** Does the payoff line actually land? */
  payoff: number;
  /** Comprehensible with zero surrounding context? Penalize dangling pronouns. */
  standalone: number;
  /** Would someone screenshot or repeat this line? */
  quotability: number;
}

/**
 * One mined clip candidate. Timestamps are seconds into the SOURCE podcast.
 * `payoffSec` is the contract's most important field — it is what the music
 * drop gets aligned to.
 */
export interface MomentCandidate {
  id: string;
  /** Clip start in source podcast, seconds. */
  startSec: number;
  /** Clip end in source podcast, seconds. */
  endSec: number;
  /** Verbatim transcript across [startSec, endSec]. */
  transcript: string;
  /**
   * The single sentence that is the emotional payoff — the line that becomes
   * the on-screen caption and lands on the drop. Must appear in `transcript`.
   */
  payoffLine: string;
  /** Absolute time in the source podcast where `payoffLine` begins speaking. */
  payoffSec: number;
  scores: MomentScores;
  /** Weighted total of `scores`, 0-10. Ranking key — highest first. */
  totalScore: number;
  /** One-line justification from the miner, shown in the review UI. */
  rationale: string;
  /** Suggested b-roll themes for this clip, from BROLL_THEMES. */
  suggestedThemes: BrollTheme[];
}

// ---------------------------------------------------------------------------
// 3. REFRAMING  (reframe.service.ts)
// ---------------------------------------------------------------------------

/** How a given span of source video becomes 1080x1920. */
export type ReframeMode =
  /** Crop to a tracked subject — the normal case. */
  | "crop"
  /** Fit whole frame with blurred pillarbox — used when 2+ people are active. */
  | "resize"
  /** Fixed center crop — fallback when tracking fails. */
  | "static";

/** One crop keyframe. Coordinates are the CENTER of the crop window, in source pixels. */
export interface CropKeyframe {
  /** Time in seconds, relative to the start of the reframed span. */
  t: number;
  cx: number;
  cy: number;
  /** Crop window width in source pixels. Height is derived at 9:16. */
  width: number;
}

/**
 * The output of reframing one clip. Consumed by the timeline renderer, which
 * turns keyframes into segmented FFmpeg crops.
 */
export interface ReframeTrack {
  mode: ReframeMode;
  /** Ordered by `t`, always non-empty, always starts at t=0. */
  keyframes: CropKeyframe[];
  /** Source video dimensions the keyframes are expressed in. */
  sourceWidth: number;
  sourceHeight: number;
  /** 0-1. Below 0.4 the UI should surface a "check framing" warning. */
  confidence: number;
}

/**
 * Pluggable so a GPU-backed active-speaker model (LR-ASD on Modal) can replace
 * the CPU implementation later without touching the renderer.
 */
export interface ReframeProvider {
  id: string;
  analyze(input: {
    videoPath: string;
    startSec: number;
    endSec: number;
  }): Promise<ReframeTrack>;
}

// ---------------------------------------------------------------------------
// 4. TIMELINE  (motivation-timeline.service.ts + render strategy)
// ---------------------------------------------------------------------------

export const BROLL_THEMES = [
  "gym",
  "running",
  "boxing",
  "ocean",
  "city_night",
  "sunrise",
  "nature",
  "work_desk",
] as const;
export type BrollTheme = (typeof BROLL_THEMES)[number];

export type BrollEnergy = "low" | "mid" | "high";

/** A clip in the b-roll library (S3-backed, mirrors gameplay-library). */
export interface BrollClip {
  key: string;
  url: string;
  theme: BrollTheme;
  energy: BrollEnergy;
  durationSec: number;
}

/** A span on a visual track. All times are on the OUTPUT timeline, seconds. */
export interface TimelineSegment {
  start: number;
  end: number;
  /** Where in the source media this span begins, seconds. */
  sourceStart: number;
  /** Playback rate. 1 = native. <1 = slow-mo (used for the payoff ramp). */
  speed: number;
}

export interface PrimarySegment extends TimelineSegment {
  kind: "primary";
  /** Reframing for this span. */
  reframe: ReframeTrack;
}

export interface BrollSegment extends TimelineSegment {
  kind: "broll";
  clipKey: string;
  /** Cinematic bars — applied to cutaways only, per the style rules. */
  letterbox: boolean;
}

/** Gain automation point for the music bed. */
export interface GainPoint {
  t: number;
  /** Linear gain 0-1. */
  gain: number;
}

export interface TimelineCaption {
  start: number;
  end: number;
  text: string;
  /** The payoff caption renders in the emphasis style (larger, accent colour). */
  emphasis: boolean;
}

export type OverlayKind = "grain" | "vignette" | "flash" | "letterbox" | "hook_card";

export interface TimelineOverlay {
  kind: OverlayKind;
  start: number;
  end: number;
  /** 0-1 strength. */
  intensity: number;
  /** Only for hook_card. */
  text?: string;
}

/**
 * The complete, render-ready edit. Produced by arrangement, editable in the
 * studio UI, consumed by the render strategy. Everything needed to render is
 * here — the renderer performs no creative decisions of its own.
 */
export interface MotivationTimeline {
  version: number;
  /** Total output duration, seconds. */
  duration: number;

  music: {
    importId: string;
    /**
     * Seconds into the TRACK where output t=0 begins. Computed as
     * `payoffAbsoluteTimeOnOutput - musicMap.dropAt`, so the drop lands on the
     * payoff. May be negative-clamped to 0 with the payoff nudged instead.
     */
    startOffset: number;
    gainCurve: GainPoint[];
    /** Copied from the source MusicMap so the renderer needn't re-read it. */
    beats: number[];
    downbeats: number[];
    /** Output-timeline time where the drop lands. */
    dropAtOutput: number | null;
  };

  /** The podcast clip, reframed. Ordered, non-overlapping. */
  primary: PrimarySegment[];
  /** Cutaways. Overlay ON TOP of primary — starts/ends should sit on downbeats. */
  broll: BrollSegment[];
  captions: TimelineCaption[];
  overlays: TimelineOverlay[];

  /** Colour grade applied across BOTH primary and b-roll so footage matches. */
  grade: "teal_orange" | "bleach_bypass" | "warm_film" | "none";

  /** Provenance for the review UI + regeneration. */
  source: {
    podcastImportId: string;
    momentId: string;
    payoffLine: string;
  };
}

export const MOTIVATION_TIMELINE_VERSION = 1;

// ---------------------------------------------------------------------------
// 5. RENDER CONSTANTS (shared so lab + service agree exactly)
// ---------------------------------------------------------------------------

/** Output loudness target. IG/YT normalize to roughly -14 LUFS. */
export const TARGET_LUFS = -14;
/** Voice sits this many dB above the ducked music bed. */
export const VO_OVER_BED_DB = 6;
/** Music dips this long before the drop so the drop hits harder, seconds. */
export const PRE_DROP_DUCK_SEC = 1.5;
/** Cuts snap to a beat when within this tolerance, seconds. */
export const BEAT_SNAP_TOLERANCE_SEC = 0.12;
/** Payoff line must land within this of the drop, seconds. */
export const DROP_ALIGN_TOLERANCE_SEC = 0.2;
