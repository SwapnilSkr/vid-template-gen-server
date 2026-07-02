// Recurring trend scout — schedule as a daily cron.
//
// Usage:
//   bun scripts/trend-scout-daily.ts          # rolling 7-day window (run daily)
//   bun scripts/trend-scout-daily.ts month     # rolling 30-day window (run weekly)
//
// Quota-driven cadence: a full 30-day scan mostly re-fetches the same top
// videos day over day, so the default (week) window is meant to run daily to
// catch fresh viral hits early, while the month window refreshes the longer
// leaderboard on a slower cadence (e.g. weekly, via a second cron entry).
// After each scan, refreshes the per-genre trend-insight digest so script/
// thumbnail prompts pick up the latest patterns without re-summarizing raw
// references on every reel generation.
//
// Needs YOUTUBE_DATA_API_KEY in env.
import { connectDatabase, disconnectDatabase } from "../src/db/connection";
import { scoutAllGenres } from "../src/services/trend-scout.service";
import { refreshAllTrendInsights } from "../src/services/trend-insight.service";
import { REDDIT_GENRES } from "../src/services/story.service";

const mode = process.argv[2] === "month" ? "month" : "week";
const now = new Date();
const publishedAfter = new Date(now.getTime() - (mode === "month" ? 30 : 7) * 24 * 60 * 60 * 1000);
const scanWindow = mode === "month" ? "monthly_scan" : "weekly_scan";

await connectDatabase();

console.log(`📊 Trend scout (${mode} window)...`);
const results = await scoutAllGenres({ publishedAfter, scanWindow });
for (const r of results) {
  console.log(`  ${r.genre}: found ${r.found}, upserted ${r.upserted}${r.error ? ` (${r.error})` : ""}`);
}

console.log("🧠 Refreshing trend-insight digests...");
const digests = await refreshAllTrendInsights(Object.keys(REDDIT_GENRES));
console.log(`  refreshed ${digests.length} genre digest(s)`);

console.log(`\n✅ Trend scout (${mode}) complete.`);
await disconnectDatabase();
process.exit(0);
