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

/** Where the audience finds the next part, phrased per platform. */
function seriesLinkLine(reel: IReel, platform: CommentPlatform): string | undefined {
  const part = reel.partNumber;
  const count = reel.partCount;
  if (!part || !count || count <= 1) return undefined;

  // A non-final part points forward to the next one; the final part invites a
  // catch-up from the start. Both use a genuine follow/subscribe reason, not
  // an engagement demand.
  const isFinal = part >= count;
  switch (platform) {
    case "youtube":
      return isFinal
        ? `That was the finale — the earlier parts are on the channel. Subscribe if you want the next story like this.`
        : `Part ${part + 1} is up next on the channel 👉 subscribe so it finds you.`;
    case "instagram":
      return isFinal
        ? `Start from Part 1 on my profile 👆 follow so the next series doesn't pass you by.`
        : `Part ${part + 1} is on my profile 👆 follow so you don't lose it.`;
    case "facebook":
      return isFinal
        ? `The earlier parts are on the Page — follow for the next story.`
        : `Part ${part + 1} is on the Page 👆 follow so you catch it.`;
    case "threads":
      return isFinal
        ? `Part 1 is on my profile if you want the whole thread — follow for the next one.`
        : `Part ${part + 1} is on my profile 👆 follow so you don't miss it.`;
    default:
      return undefined;
  }
}

function curiosityQuestion(reel: IReel): { text: string; source: FirstCommentCopy["source"] } {
  const prompt = reel.outro?.commentPrompt?.trim();
  if (prompt) return { text: prompt, source: "story_prompt" };
  return { text: DEFAULT_OUTRO_COMMENT_PROMPT, source: "fallback" };
}

/**
 * Compose the first-comment text for an own post: the story-specific curiosity
 * question, then (for multi-part stories) a platform-native series link.
 *
 * `maxLength` guards against a platform comment cap (YouTube/IG/FB ~ generous;
 * Threads replies are short). The question is always preserved; the series
 * line is dropped first if the whole thing would overflow.
 */
export function buildFirstCommentText(
  reel: IReel,
  platform: CommentPlatform,
  maxLength = 900,
): FirstCommentCopy {
  const question = curiosityQuestion(reel);
  const link = seriesLinkLine(reel, platform);

  const withLink = [question.text, link].filter(Boolean).join("\n\n");
  if (link && withLink.length <= maxLength) {
    return { text: withLink, source: question.source, hasSeriesLink: true };
  }
  const bounded = question.text.length <= maxLength
    ? question.text
    : question.text.slice(0, maxLength).replace(/\s+\S*$/, "").trim();
  return { text: bounded, source: question.source, hasSeriesLink: false };
}
