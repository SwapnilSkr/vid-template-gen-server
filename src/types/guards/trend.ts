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
});

export type TTrendSummaryQuery = typeof TrendSummaryQuery.static;

export const TriggerScoutBody = t.Object({
  window: t.Optional(t.Union([t.Literal("week"), t.Literal("month")])),
});

export type TTriggerScoutBody = typeof TriggerScoutBody.static;
