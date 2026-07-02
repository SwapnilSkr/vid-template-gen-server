// Ingest gameplay background clips into S3 (served via CloudFront) + local cache.
//
// Usage:
//   bun scripts/ingest-gameplay.ts <file-or-dir> [<file-or-dir> ...]
//
// Each source is cropped to 9:16, stripped of audio, normalised to 30fps, and
// split into ~75s loop segments. Source your clips from license-clear providers
// (Pexels / Pixabay / Mixkit / archive.org CC0) or footage you own.
import { stat } from "node:fs/promises";
import {
  ingestGameplaySource,
  ingestGameplayDir,
} from "../src/services/gameplay-ingest.service";

const args = process.argv.slice(2);
if (!args.length) {
  console.error("Usage: bun scripts/ingest-gameplay.ts <file-or-dir> ...");
  process.exit(1);
}

let total = 0;
for (const p of args) {
  const s = await stat(p).catch(() => null);
  if (!s) {
    console.warn(`skip (not found): ${p}`);
    continue;
  }
  const clips = s.isDirectory() ? await ingestGameplayDir(p) : await ingestGameplaySource(p);
  total += clips.length;
  for (const c of clips) console.log(`  → ${c.url}`);
}
console.log(`\n✅ Ingested ${total} gameplay segment(s).`);
process.exit(0);
