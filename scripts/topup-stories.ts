// Top up the story bank with fresh, deduped Reddit-style stories.
// This is the "story agent" — schedule it (cron / routine) to keep the farm fed.
//
// Usage:
//   bun scripts/topup-stories.ts [count] [mode]
//     count : how many fresh stories to bank (default 10)
//     mode  : llm | hybrid | verbatim (default llm)
//
// hybrid/verbatim need REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET in env.
import { connectDatabase, disconnectDatabase } from "../src/db/connection";
import { topUpStoryBank, storyBankStats } from "../src/services/story.service";
import type { StorySource } from "../src/models/story.model";

const count = parseInt(process.argv[2] || "10", 10);
const mode = (process.argv[3] || "llm") as StorySource;

await connectDatabase();
const before = await storyBankStats();
console.log(`bank before: ${before.ready} ready / ${before.used} used`);

await topUpStoryBank(count, mode);

const after = await storyBankStats();
console.log(`bank after:  ${after.ready} ready / ${after.used} used`);
await disconnectDatabase();
process.exit(0);
