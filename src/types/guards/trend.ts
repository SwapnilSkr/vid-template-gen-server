import { t } from "elysia";

export const ListTrendsQuery = t.Object({
  niche: t.Optional(t.String()),
  genre: t.Optional(t.String()),
  platform: t.Optional(t.String()),
  status: t.Optional(t.String()),
  limit: t.Optional(t.String()),
});

export type TListTrendsQuery = typeof ListTrendsQuery.static;

export const TrendSummaryQuery = t.Object({
  period: t.Optional(t.Union([t.Literal("week"), t.Literal("month")])),
  niche: t.Optional(t.String()),
});

export type TTrendSummaryQuery = typeof TrendSummaryQuery.static;

export const TriggerScoutBody = t.Object({
  window: t.Optional(t.Union([t.Literal("week"), t.Literal("month")])),
  niche: t.Optional(t.String()),
});

export type TTriggerScoutBody = typeof TriggerScoutBody.static;

export const ListHorrorReferencesQuery = t.Object({
  status: t.Optional(t.String()),
  genre: t.Optional(t.String()),
  limit: t.Optional(t.String()),
});

export type TListHorrorReferencesQuery = typeof ListHorrorReferencesQuery.static;

export const TriggerHorrorReferenceScoutBody = t.Object({
  limit: t.Optional(t.Number()),
  refreshExisting: t.Optional(t.Boolean()),
  includeUsed: t.Optional(t.Boolean()),
});

export type TTriggerHorrorReferenceScoutBody =
  typeof TriggerHorrorReferenceScoutBody.static;
