// Preflight model validation — proves every frontend-selectable model actually
// works so a generation can never fail (or silently overspend) because of a bad
// model. Writes `model-health.json` to S3; listImageModels() then hides any image
// model that FAILED, so the picker only offers working models.
//
// Usage:
//   bun scripts/validate-models.ts            # images + tts + video report
//   bun scripts/validate-models.ts images     # image models only
//   bun scripts/validate-models.ts tts        # tts voices only
//   bun scripts/validate-models.ts video      # video availability + pricing (no burn)
//
// Cost: images = one tiny generation per model (cheapest); tts = a 4-word clip
// per voice (fractions of a cent); video = READ-ONLY (lists models + per-second
// SKU price, submits nothing) so it never burns video spend.
import { config } from "../src/config";
import { probeImageModel, probeTtsVoice } from "../src/services/openrouter-media.service";
import { listImageModels, putJson } from "../src/services";
import { TTS_VOICE_CATALOG, REGISTRY } from "../src/config/models";

type Result = { ok: boolean; costUsd?: number; error?: string };

const HEALTH_KEY = "model-health.json";
const usd = (n?: number) => (n === undefined ? "  n/a  " : `$${n.toFixed(5)}`);

/** Run tasks with limited concurrency to stay under provider rate limits. */
async function pool<T, R>(items: T[], size: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

async function validateImages(): Promise<Record<string, Result>> {
  const models = await listImageModels();
  console.log(`\n🖼️  Validating ${models.length} image model(s)…`);
  const entries: Record<string, Result> = {};
  await pool(models, 4, async (m) => {
    const r = await probeImageModel(m.model);
    entries[m.model] = r;
    console.log(`  ${r.ok ? "✓" : "✗"} ${usd(r.costUsd)}  ${m.model}${r.ok ? "" : `  — ${r.error?.slice(0, 90)}`}`);
  });
  const ok = Object.values(entries).filter((r) => r.ok).length;
  console.log(`  → ${ok}/${models.length} image models OK`);
  return entries;
}

async function validateTts(): Promise<Record<string, Result>> {
  console.log(`\n🎤 Validating ${TTS_VOICE_CATALOG.length} TTS voice(s)…`);
  const entries: Record<string, Result> = {};
  await pool(TTS_VOICE_CATALOG, 4, async (v) => {
    const key = `${v.model}/${v.voice}`;
    const r = await probeTtsVoice(v.model, v.voice, v.format);
    entries[key] = r;
    console.log(`  ${r.ok ? "✓" : "✗"} ${usd(r.costUsd)}  ${key}${r.ok ? "" : `  — ${r.error?.slice(0, 90)}`}`);
  });
  const ok = Object.values(entries).filter((r) => r.ok).length;
  console.log(`  → ${ok}/${TTS_VOICE_CATALOG.length} TTS voices OK`);
  return entries;
}

/** READ-ONLY video check — lists models, flags image-to-video support + per-second
 *  price. Submits nothing, so it never spends video budget. */
async function validateVideo(): Promise<Record<string, { ok: boolean; imageToVideo?: boolean; perSecondUsd?: number; note?: string }>> {
  console.log(`\n🎬 Video models (read-only — availability + pricing, no jobs submitted):`);
  const tierVideoModels = [...new Set(Object.values(REGISTRY).map((set) => set.video))];
  const out: Record<string, { ok: boolean; imageToVideo?: boolean; perSecondUsd?: number; note?: string }> = {};
  try {
    const res = await fetch(`${config.openRouterBaseUrl}/videos/models`, {
      headers: { Authorization: `Bearer ${config.openRouterApiKey}` },
    });
    const data = (await res.json()) as {
      data?: { id: string; architecture?: { input_modalities?: string[] }; pricing_skus?: Record<string, string | number> }[];
    };
    const byId = new Map((data.data ?? []).map((m) => [m.id, m]));
    for (const id of tierVideoModels) {
      const m = byId.get(id);
      if (!m) {
        out[id] = { ok: false, note: "not found in /videos/models" };
        console.log(`  ✗ ${id} — not listed`);
        continue;
      }
      const i2v = (m.architecture?.input_modalities ?? []).includes("image");
      const skus = m.pricing_skus ?? {};
      const rawSec =
        skus.duration_seconds_without_audio_720p ?? skus.duration_seconds_without_audio ?? skus.duration_seconds_720p ?? skus.duration_seconds;
      const perSec = typeof rawSec === "number" ? rawSec : typeof rawSec === "string" ? Number(rawSec) : undefined;
      out[id] = { ok: true, imageToVideo: i2v, perSecondUsd: Number.isFinite(perSec) ? perSec : undefined };
      console.log(
        `  ${i2v ? "✓" : "⚠"} ${id}  img2vid=${i2v ? "yes" : "NO"}  ${
          perSec !== undefined ? `~$${perSec}/s → 5s≈$${(perSec * 5).toFixed(2)}` : "price n/a"
        }`
      );
    }
  } catch (error) {
    console.warn(`  video model list failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return out;
}

async function main(): Promise<void> {
  const scope = process.argv[2];
  const health: {
    images?: Record<string, Result>;
    tts?: Record<string, Result>;
    videos?: Record<string, unknown>;
    generatedAt: string;
  } = { generatedAt: new Date().toISOString() };

  if (!scope || scope === "images") health.images = await validateImages();
  if (!scope || scope === "tts") health.tts = await validateTts();
  if (!scope || scope === "video") health.videos = await validateVideo();

  // Merge with any existing health so a scoped run doesn't wipe other sections.
  try {
    const existingRes = await fetch(`https://${config.s3Bucket}.s3.${config.awsRegion}.amazonaws.com/${HEALTH_KEY}?t=${Date.now()}`);
    if (existingRes.ok) {
      const prev = (await existingRes.json()) as typeof health;
      health.images ??= prev.images;
      health.tts ??= prev.tts;
      health.videos ??= prev.videos;
    }
  } catch {
    // no prior report — fine
  }

  await putJson(HEALTH_KEY, health);
  const badImg = Object.entries(health.images ?? {}).filter(([, r]) => !r.ok).map(([m]) => m);
  const badTts = Object.entries(health.tts ?? {}).filter(([, r]) => !r.ok).map(([m]) => m);
  console.log(`\n✅ Wrote ${HEALTH_KEY}.`);
  if (badImg.length) console.log(`   ⚠ ${badImg.length} image model(s) will be HIDDEN from the picker: ${badImg.join(", ")}`);
  if (badTts.length) console.log(`   ⚠ ${badTts.length} TTS voice(s) failed: ${badTts.join(", ")}`);
  process.exit(0);
}

main().catch((error) => {
  console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
