#!/usr/bin/env bun
/**
 * CLI: bun run smoke:captions
 * Exit 0 only when ASS captions burn successfully on this machine.
 */
import { runCaptionSmokeTest } from "../src/services/caption-smoke.service";

const keep = process.argv.includes("--keep");
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
console.log(`\n${result.success ? "✅" : "❌"} ${result.message}`);
process.exit(result.success ? 0 : 1);
