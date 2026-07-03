// Recurring public-domain horror reference scout — schedule as a daily cron.
// Populates HorrorReference rows from Project Gutenberg/Gutendex. The horror
// planner consumes these as inspiration only, never verbatim narration.

import { config } from "../src/config";
import { connectDatabase, disconnectDatabase } from "../src/db";
import { scoutHorrorReferences } from "../src/services/horror-reference.service";

await connectDatabase();

const limit = parseInt(process.env.HORROR_REFERENCE_SCOUT_LIMIT || "30");
console.log(`📚 Horror reference scout starting (limit=${limit})`);

const result = await scoutHorrorReferences(limit);
console.log(
  `✅ Horror reference scout complete: ${result.upserted} saved, ${result.skipped} skipped, ${result.errors.length} errors`
);
if (result.errors.length) {
  console.warn(result.errors.slice(0, 5));
}

await disconnectDatabase();
console.log(`MongoDB: ${config.mongodbUri ? "disconnected" : "not configured"}`);
