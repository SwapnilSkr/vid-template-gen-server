import { Elysia } from "elysia";
import {
  getOwnedAnalyticsOverviewController,
  syncOwnedAnalyticsController,
} from "../controllers";

export const ownedAnalyticsRoutes = new Elysia({ prefix: "/api/analytics" })
  .get("/overview", getOwnedAnalyticsOverviewController)
  .post("/sync", syncOwnedAnalyticsController);
