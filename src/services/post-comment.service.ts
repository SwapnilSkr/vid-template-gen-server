import type { IReel } from "../models";
import { DEFAULT_OUTRO_COMMENT_PROMPT } from "./reel-outro-comment-prompt.service";

// ============================================================
// Own-post first-comment copy.
//
// Posting a genuine, curiosity-led FIRST comment on your OWN freshly published
// post is a safe, algorithm-friendly action (it seeds the comment thread and,
// on a multi-part story, links the next part). This is NOT cross-account
// engagement automation — every consumer of this module acts only on media the
// account itself just published.
//
// The copy deliberately REUSES the reel's already-generated, story-specific
// outro comment prompt (a provocative question grounded in this exact part —
// see reel-outro-comment-prompt.service.ts) instead of mechanical bait like
// "comment YES", which the 2025–2026 algorithms actively suppress.
// ============================================================

export type CommentPlatform = "youtube" | "instagram" | "facebook" | "threads";

export interface FirstCommentCopy {
  text: string;
  /** Whether the curiosity question came from the reel's story prompt. */
  source: "story_prompt" | "fallback";
  /** Whether a multi-part series link line was appended. */
  hasSeriesLink: boolean;
}

export type SeriesNavigationKind = "next_part" | "series_complete";

/** Instagram comments render bare URLs as plain text, so link copy both looks
 * cluttered and fails its navigation job. Keep the instruction actionable
 * without pretending a URL can be tapped. */
function stripUrls(text: string): string {
  return text
    .replace(/(?:https?:\/\/|www\.)\S+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** This is called only after the target post is verified as published on the
 * same platform/account. The direct URL keeps the navigation claim honest. */
export function buildVerifiedSeriesNavigationText(
  platform: CommentPlatform,
  targetPart: number,
  targetUrl: string | undefined,
  kind: SeriesNavigationKind = "next_part",
): string {
  if (platform === "instagram") {
    return kind === "series_complete"
      ? "The full story is now live — open this profile and start with Part 1."
      : `Part ${targetPart} is live — open this profile to watch it.`;
  }
  if (kind === "series_complete") {
    return targetUrl
      ? `The full story is now live — start with Part 1: ${targetUrl}`
      : "The full story is now live — start with Part 1 on this profile.";
  }
  return targetUrl
    ? `Part ${targetPart} is live: ${targetUrl}`
    : `Part ${targetPart} is live on this profile.`;
}

function curiosityQuestion(reel: IReel): { text: string; source: FirstCommentCopy["source"] } {
  const prompt = reel.outro?.commentPrompt?.trim();
  if (prompt) return { text: prompt, source: "story_prompt" };
  return { text: DEFAULT_OUTRO_COMMENT_PROMPT, source: "fallback" };
}

/**
 * Compose only the discussion comment. Series navigation is intentionally a
 * second comment, posted by the reconciliation service after it verifies the
 * referenced destination is live.
 */
export function buildFirstCommentText(
  reel: IReel,
  platform: CommentPlatform,
  maxLength = 900,
): FirstCommentCopy {
  const question = curiosityQuestion(reel);
  const text = platform === "instagram" ? stripUrls(question.text) : question.text;
  const bounded = text.length <= maxLength
    ? text
    : text.slice(0, maxLength).replace(/\s+\S*$/, "").trim();
  return { text: bounded, source: question.source, hasSeriesLink: false };
}
