import { t } from "elysia";

export const ListStoryCandidatesQuery = t.Object({
  genre: t.Optional(t.String()),
  source: t.Optional(t.Union([t.Literal("hybrid"), t.Literal("verbatim")])),
  limit: t.Optional(t.String()),
  /** comma-separated Reddit permalinks to exclude from results */
  excludeUrls: t.Optional(t.String()),
});
export type TListStoryCandidatesQuery = typeof ListStoryCandidatesQuery.static;

export const ListStoryBankQuery = t.Object({
  genre: t.Optional(t.String()),
  source: t.Optional(t.Union([t.Literal("llm"), t.Literal("hybrid"), t.Literal("verbatim")])),
  limit: t.Optional(t.String()),
  offset: t.Optional(t.String()),
  sort: t.Optional(t.Union([t.Literal("newest"), t.Literal("oldest"), t.Literal("fifo")])),
});
export type TListStoryBankQuery = typeof ListStoryBankQuery.static;
