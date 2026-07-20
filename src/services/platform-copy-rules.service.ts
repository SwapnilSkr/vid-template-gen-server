/**
 * Conservative, versioned copy defaults used when the research corpus has too
 * little comparable evidence.  These are editorial guardrails, not claims
 * about a secret ranking formula.  A future owned-performance layer can add a
 * higher-confidence genre/platform recommendation on top of these rules.
 */
export const PLATFORM_COPY_RULES_VERSION = "2026-07-19";

const COMMON = `
COMMON NON-NEGOTIABLES:
- Tell the truth about the story part. Never invent an update, verdict, twist, or a live next part.
- Retell and compress source material with an original editorial voice; do not produce a near-verbatim Reddit reading.
- Make the title/copy/opening promise agree with the actual video. No keyword stuffing, generic bait, or copied boilerplate.
- A series is optional. Split only where this story has a real unresolved turn; never make a continuation conditional on engagement.`;

const RULES: Record<"youtube" | "instagram" | "facebook" | "threads", string> = {
  youtube: `${COMMON}
YOUTUBE SHORTS DEFAULTS:
- Title: one specific truthful conflict or consequence in natural language; prefer 45–65 characters; no hashtags, emojis, quotation marks, ALL CAPS, or “you won't believe”.
- Description: one or two searchable sentences that add context rather than repeat the title. Use ordinary topic language, not a keyword block.
- Hashtags: zero to three accurate tags at the end only. Never use unrelated/trending tags.
- Video: open immediately on the unusual conflict and stakes; deliver a coherent escalation and either a resolution or an honestly unresolved state.
- Comment: one precise, good-faith question about this part. Add series navigation only after the target part is confirmed published; never use comment/like bait.`,
  instagram: `${COMMON}
INSTAGRAM REELS DEFAULTS:
- Caption first line: name the real topic/conflict in human language, then create curiosity. Keep the caption mobile-readable and specific to the story.
- Include one natural primary topic phrase in the opening caption prose. Add three to five accurate, lower-case niche tags only when useful; never use #fyp, #viral, #reels, #explorepage, #instagram, or #shorts.
- The opening on-screen/spoken line must clarify the same conflict as the caption; do not hide key context in hashtags or comments.
- End caption prose with at most one genuine, part-specific question or light follow reason. No generic “wait for it” or engagement bait.
- Comment: use one story-specific discussion question. A separate series note may be posted only when the referenced part is live.`,
  facebook: `${COMMON}
FACEBOOK REELS DEFAULTS:
- Description: concise, readable context that accurately describes the story and its central dilemma; use natural topic words and only relevant hashtags.
- Never use a long caption unrelated to the video, generic hashtag walls, or superficial repost-style wording.
- Lead the video with the conflict and make the adaptation visibly/orally original rather than interchangeable narration over generic footage.
- Comment: one genuine discussion prompt; any navigation note must be truthful and only mention live parts.`,
  threads: `${COMMON}
THREADS DEFAULTS:
- Main text must stand alone: lead with an original take or the central dilemma, give enough context to respond, then ask one specific question.
- Pair every video with compact text. Prefer one accurate topic/community tag where supported; never turn the post into a hashtag dump.
- A self-reply is optional and has exactly one job: compact context, clarification, or truthful series navigation. It cannot be required to understand the main post.
- Do not use “reply for part two”, vote bait, or copied Instagram-caption formatting.`,
};

export function platformCopyRules(platform: keyof typeof RULES): string {
  return `DEFAULT PLATFORM COPY RULES (version ${PLATFORM_COPY_RULES_VERSION}):\n${RULES[platform]}`;
}

/** The common defaults used while writing the story/video hook itself. */
export function redditStoryHookRules(): string {
  return `${COMMON}
REDDIT-STORY HOOK DEFAULTS:
- In the first sentence, state the unusual conflict and its stakes; no logo, greeting, “Part 1”, or generic setup.
- Make the narrator's original angle clear through framing, judgment, or a concrete takeaway—not a flat reading.
- Use only the facts needed for the moral dilemma. End a standalone with payoff; end a non-final part only on a genuine unresolved turn.`;
}
