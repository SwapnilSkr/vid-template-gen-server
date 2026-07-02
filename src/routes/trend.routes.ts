import { Elysia } from "elysia";
import { ListTrendsQuery, TrendSummaryQuery, TriggerScoutBody } from "../types/guards";
import {
  listTrendsController,
  getTrendSummaryController,
  triggerTrendScoutController,
} from "../controllers";

// ============================================
// Trend reference routes — dashboard browsing of the TrendReference
// collection (populated by trend-scout.service) + a manual scout trigger.
// ============================================

export const trendRoutes = new Elysia({ prefix: "/api/trends" })
  .get("/", listTrendsController, { query: ListTrendsQuery })
  .get("/summary", getTrendSummaryController, { query: TrendSummaryQuery })
  .post("/scout", triggerTrendScoutController, { body: TriggerScoutBody });
