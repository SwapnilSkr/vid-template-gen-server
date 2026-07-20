import { Elysia } from "elysia";
import {
  ListHorrorReferencesQuery,
  ListTrendsQuery,
  TrendSummaryQuery,
  TriggerHorrorReferenceScoutBody,
  TriggerScoutBody,
} from "../types/guards";
import {
  listHorrorReferencesController,
  listTrendsController,
  getTrendSummaryController,
  getTrendInsightController,
  triggerHorrorReferenceScoutController,
  triggerTrendScoutController,
} from "../controllers";

// ============================================
// Trend reference routes — dashboard browsing of the TrendReference
// collection (populated by trend-scout.service) + a manual scout trigger.
// ============================================

export const trendRoutes = new Elysia({ prefix: "/api/trends" })
  .get("/", listTrendsController, { query: ListTrendsQuery })
  .get("/summary", getTrendSummaryController, { query: TrendSummaryQuery })
  .get("/insights/:genre", getTrendInsightController)
  .post("/scout", triggerTrendScoutController, { body: TriggerScoutBody })
  .get("/horror-references", listHorrorReferencesController, {
    query: ListHorrorReferencesQuery,
  })
  .post("/horror-references/scout", triggerHorrorReferenceScoutController, {
    body: TriggerHorrorReferenceScoutBody,
  });
