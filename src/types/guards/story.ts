import { t } from "elysia";

export const ListStoryCandidatesQuery = t.Object({
  genre: t.Optional(t.String()),
  source: t.Optional(t.Union([t.Literal("hybrid"), t.Literal("verbatim")])),
  limit: t.Optional(t.String()),
  /** JSON array or comma-separated Reddit permalinks to exclude from results */
  excludeUrls: t.Optional(t.String()),
  /** reel parts setting — used to estimate series part count on cards */
  parts: t.Optional(t.String()),
  tier: t.Optional(t.Union([t.Literal("cheap"), t.Literal("value"), t.Literal("premium")])),
});
export type TListStoryCandidatesQuery = typeof ListStoryCandidatesQuery.static;

export const ListStoryBankQuery = t.Object({
  genre: t.Optional(t.String()),
  source: t.Optional(t.Union([t.Literal("llm"), t.Literal("hybrid"), t.Literal("verbatim")])),
  limit: t.Optional(t.String()),
  offset: t.Optional(t.String()),
  sort: t.Optional(t.Union([t.Literal("newest"), t.Literal("oldest"), t.Literal("fifo")])),
  /** reel parts setting — used to estimate series part count on cards */
  parts: t.Optional(t.String()),
  tier: t.Optional(t.Union([t.Literal("cheap"), t.Literal("value"), t.Literal("premium")])),
});
export type TListStoryBankQuery = typeof ListStoryBankQuery.static;

/** Resolve a pasted Reddit permalink / share link into a source-post preview. */
export const ResolveStoryBody = t.Object({
  url: t.String(),
  /** also return a preview of discovered followups/updates */
  fetchUpdates: t.Optional(t.Boolean()),
});
export type TResolveStoryBody = typeof ResolveStoryBody.static;
