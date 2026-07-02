// Refresh the per-genre trend-insight digest from whatever TrendReference
// data already exists, without re-scanning YouTube (no API quota spent).
// Useful right after a backfill, or to force a re-summarize after manually
// approving/rejecting references.
//
// Usage:
//   bun scripts/refresh-trend-insights.ts
import { connectDatabase, disconnectDatabase } from "../src/db/connection";
import { refreshAllTrendInsights } from "../src/services/trend-insight.service";
import { getScoutTargets } from "../src/services/trend-scout.service";

await connectDatabase();

const digests = await refreshAllTrendInsights(getScoutTargets());
console.log(`🧠 Refreshed ${digests.length} niche/genre digest(s):`);
for (const d of digests) {
  console.log(`\n— ${d.niche}/${d.genre} (${d.sampleSize} samples) —\n${d.digest}`);
}

await disconnectDatabase();
process.exit(0);
