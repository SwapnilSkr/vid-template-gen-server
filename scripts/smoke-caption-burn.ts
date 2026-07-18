#!/usr/bin/env bun
/**
 * CLI: bun run smoke:captions
 * Exit 0 only when (a) the deterministic caption-timing/normalization checks
 * pass AND (b) ASS captions burn successfully on this machine.
 *
 * The timing checks are pure (no ffmpeg/TTS spend) and verify the Issue-1
 * guarantees — no 0.75 compression, cues track real audio, monotonic + bounded,
 * amber highlight — plus the Issue-2 narration normalization invariants.
 */
import {
  runCaptionSmokeTest,
  runCaptionTimingChecks,
} from "../src/services/caption-smoke.service";

const keep = process.argv.includes("--keep");

// 1. Pure timing + normalization checks (always run — no external deps).
console.log("— caption timing + normalization —");
const timingChecks = await runCaptionTimingChecks();
for (const check of timingChecks) {
  console.log(`${check.ok ? "✓" : "✗"} [${check.id}] ${check.detail}`);
}
const timingOk = timingChecks.every((c) => c.ok);

// 2. Full environment + burn smoke test (needs ffmpeg/libass/fonts).
console.log("\n— caption burn (ffmpeg/libass) —");
const result = await runCaptionSmokeTest({ keepOutput: keep });
for (const check of result.checks) {
  console.log(`${check.ok ? "✓" : "✗"} [${check.id}] ${check.detail}`);
}
if (result.filterPreview) {
  console.log(`\nfilter: ${result.filterPreview}`);
}
if (result.outputPath) {
  console.log(`\noutput kept at: ${result.outputPath}`);
}

const success = timingOk && result.success;
console.log(
  `\n${success ? "✅" : "❌"} ${
    timingOk ? result.message : "Caption timing/normalization checks failed — see above"
  }`
);
process.exit(success ? 0 : 1);
