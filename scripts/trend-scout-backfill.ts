// One-off historical trend backfill: pulls top-viewed Reddit-story YouTube
// Shorts per genre for the last 30 days AND the last 48 hours, seeding
// TrendReference before the daily/weekly cron has had time to accumulate data.
//
// Usage:
//   bun scripts/trend-scout-backfill.ts
//
// Needs YOUTUBE_DATA_API_KEY in env (Google Cloud Console API key, read-only
// YouTube Data API v3 — separate from the OAuth publish credentials).
import { connectDatabase, disconnectDatabase } from "../src/db/connection";
import { scoutAllGenres } from "../src/services/trend-scout.service";

const now = new Date();
const days = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

await connectDatabase();

console.log("📊 Backfilling last 30 days...");
const monthResults = await scoutAllGenres({ publishedAfter: days(30), scanWindow: "last_30d" });
for (const r of monthResults) {
  console.log(`  ${r.genre}: found ${r.found}, upserted ${r.upserted}${r.error ? ` (${r.error})` : ""}`);
}

console.log("📊 Backfilling last 48 hours...");
const recentResults = await scoutAllGenres({ publishedAfter: days(2), scanWindow: "last_48h" });
for (const r of recentResults) {
  console.log(`  ${r.genre}: found ${r.found}, upserted ${r.upserted}${r.error ? ` (${r.error})` : ""}`);
}

const totalUpserted = [...monthResults, ...recentResults].reduce((sum, r) => sum + r.upserted, 0);
console.log(`\n✅ Backfill complete: ${totalUpserted} references upserted.`);

await disconnectDatabase();
process.exit(0);
