import { config } from "../config";
import { storyBankStats, topUpStoryBank } from "./story.service";
import { getErrorMessage } from "../types";
import type { StorySource } from "../models";

// ============================================
// In-process scheduler that keeps the Reddit story bank topped up so
// `takeNextStory` (auto reels) never blocks on a live LLM/Reddit call.
// Runs a periodic check rather than a fixed cron: cheap, self-correcting,
// no extra infra (Redis/BullMQ queue is still Phase 0 blocker #1 — this is
// intentionally simple until that lands, at which point it becomes a
// repeatable BullMQ job instead).
//
// For multi-instance deployments, disable this (STORY_TOPUP_ENABLED=false)
// and run `scripts/topup-stories.ts` on external cron instead, so only one
// process tops up the shared Mongo bank.
// ============================================

let started = false;

export function startStoryTopUpScheduler(): void {
  if (!config.storyTopUpEnabled) {
    console.log("⏸️  Story bank top-up scheduler disabled (STORY_TOPUP_ENABLED=false)");
    return;
  }
  if (started) return;
  started = true;

  const run = async () => {
    try {
      const { ready } = await storyBankStats();
      if (ready >= config.storyTopUpThreshold) {
        console.log(`📚 Story bank OK (${ready} ready, threshold ${config.storyTopUpThreshold})`);
        return;
      }
      console.log(
        `📚 Story bank low (${ready} ready < ${config.storyTopUpThreshold}) — topping up ${config.storyTopUpCount} (${config.storyTopUpMode})`
      );
      await topUpStoryBank(config.storyTopUpCount, config.storyTopUpMode as StorySource, "value");
    } catch (error: unknown) {
      console.error("Story bank top-up check failed:", getErrorMessage(error));
    }
  };

  console.log(
    `📚 Story bank top-up scheduler started (every ${Math.round(config.storyTopUpIntervalMs / 60000)}min, threshold ${config.storyTopUpThreshold}, mode ${config.storyTopUpMode})`
  );

  // Run once shortly after boot, then on the interval.
  setTimeout(run, 10_000);
  setInterval(run, config.storyTopUpIntervalMs);
}
