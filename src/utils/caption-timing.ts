// ============================================
// Shared caption word-timing math.
//
// Both caption paths (Reddit bouncing-word captions in reel-gameplay.service
// and the AI-image karaoke ASS in subtitle.service) distribute per-word cue
// times INSIDE a segment whose real audio start + duration are already known
// (measured with ffprobe). Historically each path rolled its own char-length
// weighting, which drifts on long sentences: a run of short words races ahead
// of the voice, a run of long words lags behind.
//
// This module centralises the rules so the amber highlight tracks the spoken
// word and — critically — can never accumulate drift across the video:
//
//   1. The FIRST word of a segment always starts at the segment's real start.
//   2. The LAST word of a segment always ends at the segment's real end.
//      (periodic hard resync — bounded error per segment, zero global drift)
//   3. Between those anchors, word times are weighted by a syllable/length
//      estimate of spoken length (far closer to speech than character count),
//      OR by real word timestamps when a forced aligner / TTS timestamp API
//      supplied them.
//   4. Output is always monotonic non-decreasing and stays within the segment.
// ============================================

export interface WordTiming {
  word: string;
  /** seconds, absolute on the final mixed timeline */
  start: number;
  /** seconds, absolute on the final mixed timeline */
  end: number;
}

/** A real (measured/aligned) per-word window, absolute seconds. */
export interface RealWordTiming {
  start: number;
  end: number;
}

/**
 * Rough syllable count — a cheap proxy for how long a word takes to speak.
 * Vowel groups ≈ syllables; drop a trailing silent "e"; floor at 1. This is a
 * heuristic, not linguistics: it only needs to rank words by relative spoken
 * length well enough that the highlight stops visibly drifting.
 */
export function estimateSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 1;
  const groups = w.match(/[aeiouy]+/g);
  let n = groups ? groups.length : 1;
  if (n > 1 && /e$/.test(w) && !/le$/.test(w)) n -= 1; // silent trailing e
  return Math.max(1, n);
}

/**
 * Relative spoken-duration weight for one caption word. Syllables dominate; a
 * small per-word base covers the consonant onset / word boundary so a line of
 * one-syllable words ("I had to go now") still spreads sensibly.
 */
export function wordSpeechWeight(word: string): number {
  return estimateSyllables(word) + 0.35;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Distribute per-word cue windows across a segment.
 *
 * @param words        caption tokens (already cased as they will render)
 * @param segStart     real segment start on the final timeline (seconds)
 * @param segDuration  real segment audio duration (seconds)
 * @param realTimings  optional real per-word windows (forced alignment / TTS
 *                     timestamps). Used only when it lines up 1:1 with `words`;
 *                     it is still clamped + resynced so a bad aligner can never
 *                     push a cue outside the segment.
 */
export function distributeWordTimings(
  words: string[],
  segStart: number,
  segDuration: number,
  realTimings?: RealWordTiming[]
): WordTiming[] {
  const n = words.length;
  if (n === 0) return [];
  const dur = Math.max(segDuration, 0);
  const segEnd = segStart + dur;

  if (n === 1) {
    return [{ word: words[0], start: segStart, end: segEnd }];
  }

  const starts = new Array<number>(n);
  const ends = new Array<number>(n);

  const usableReal =
    dur > 0 &&
    !!realTimings &&
    realTimings.length === n &&
    realTimings.every((t) => Number.isFinite(t.start) && Number.isFinite(t.end));

  if (usableReal && realTimings) {
    // Anchor the aligned windows to the known segment. Real timestamps come in
    // their own frame (per-segment audio starting at 0, or a slightly longer/
    // shorter recognised span); map linearly onto [segStart, segEnd] so the
    // endpoints hard-resync no matter what the aligner reported.
    const first = realTimings[0].start;
    const last = realTimings[n - 1].end;
    const span = last - first;
    const scale = span > 0 ? dur / span : 0;
    const project = (t: number): number =>
      span > 0 ? segStart + (t - first) * scale : segStart;
    for (let i = 0; i < n; i++) {
      starts[i] = project(realTimings[i].start);
      ends[i] = project(realTimings[i].end);
    }
  } else {
    // Heuristic: syllable/length weighting across the spoken window.
    const weights = words.map(wordSpeechWeight);
    const total = weights.reduce((a, b) => a + b, 0) || n;
    let acc = 0;
    for (let i = 0; i < n; i++) {
      starts[i] = segStart + (acc / total) * dur;
      acc += weights[i];
      ends[i] = segStart + (acc / total) * dur;
    }
  }

  // Hard resync endpoints + enforce monotonic, in-segment cues. This is what
  // guarantees drift can never accumulate: every segment re-pins to real audio.
  starts[0] = segStart;
  ends[n - 1] = segEnd;
  let prev = segStart;
  for (let i = 0; i < n; i++) {
    starts[i] = clamp(Math.max(starts[i], prev), segStart, segEnd);
    ends[i] = clamp(Math.max(ends[i], starts[i]), segStart, segEnd);
    prev = ends[i];
  }
  ends[n - 1] = segEnd;
  if (starts[n - 1] > segEnd) starts[n - 1] = segEnd;

  return words.map((word, i) => ({ word, start: starts[i], end: ends[i] }));
}
