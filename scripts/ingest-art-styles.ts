// Ingest reference-art images for the horror art styles into S3 (served via
// CloudFront) and write art-styles/manifest.json, which art-style.service.ts
// prefers over the registry defaults.
//
// Usage:
//   bun scripts/ingest-art-styles.ts                     # seed all curated (PD download) styles
//   bun scripts/ingest-art-styles.ts ink_horror_comic    # one curated style only
//   bun scripts/ingest-art-styles.ts <styleId> <path-or-url> [more...]  # custom refs
//   bun scripts/ingest-art-styles.ts --generate [styleId]  # GENERATE animation refs via OpenRouter
//
// SOURCING POLICY: the curated references are PUBLIC-DOMAIN works (pre-1929 via
// Wikimedia Commons). The --generate mode instead creates each reference frame
// with our own image model (OpenRouter) — fully license-clean, on-brand, and the
// only sane way to seed synthetic ANIMATION looks (3D cartoon, Pixar, anime,
// claymation) that don't exist as PD artwork. Attribution is recorded regardless.
import { readFile } from "node:fs/promises";
import { uploadToS3, cdnUrlFor } from "../src/services/s3.service";
import { generateImage } from "../src/services/openrouter-media.service";
import { ART_STYLES } from "../src/config/art-styles";

// Reference-frame generation prompts for the synthetic animation styles. Each is
// a strong, iconic exemplar scene (kept slightly ominous so it anchors mood too);
// the style's promptSuffix is appended by generateImage.
const GENERATE: Record<string, string> = {
  cartoon_3d_story:
    "a frightened wide-eyed man in a jacket standing on an empty city street at dusk, worried people behind him, dramatic storytelling framing",
  pixar_3d:
    "a small anxious character alone at the end of a long dim hallway looking back over their shoulder, one warm lamp glowing",
  dark_anime:
    "a lone figure standing in a rain-soaked neon alley at night looking up, dramatic shadows and reflections",
  comic_book_color:
    "a shocked person recoiling as a door creaks open behind them in a dim room, dynamic dramatic angle",
  claymation:
    "a nervous clay character holding a candle in a dark old house, long shadows on the wall",
};

interface RefSource {
  url: string;
  title: string;
  license: string;
  source: string;
}

const wm = (file: string): string =>
  `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=1024`;

// Curated public-domain references per style (verified to resolve 2026-07).
const CURATED: Record<string, RefSource[]> = {
  ink_horror_comic: [
    { url: wm("Harry Clarke Poe Tales of Mystery and Imagination 1.jpg"), title: "Harry Clarke — Tales of Mystery and Imagination", license: "public-domain", source: "Wikimedia Commons" },
    { url: wm("Clarke-TellTaleHeart.jpeg"), title: "Harry Clarke — The Tell-Tale Heart", license: "public-domain", source: "Wikimedia Commons" },
  ],
  junji_ito_manga: [
    { url: wm("Hokusai Kohada Koheiji.jpg"), title: "Hokusai — Kohada Koheiji (Hyaku Monogatari)", license: "public-domain", source: "Wikimedia Commons" },
    { url: wm("Katsushika Hokusai - The Lantern Ghost, Iwa - Google Art Project.jpg"), title: "Hokusai — The Lantern Ghost, Iwa", license: "public-domain", source: "Wikimedia Commons" },
  ],
  charcoal_dread: [
    { url: wm("Redon, Odilon, Apparition, 1905-10.jpg"), title: "Odilon Redon — Apparition", license: "public-domain", source: "Wikimedia Commons" },
    { url: wm("Escapan entre las llamas, Los desastres de la guerra (Goya).jpg"), title: "Goya — Los Desastres de la Guerra", license: "public-domain", source: "Wikimedia Commons" },
  ],
  gothic_storybook: [
    { url: wm("Harry Clarke Ligeia.jpg"), title: "Harry Clarke — Ligeia", license: "public-domain", source: "Wikimedia Commons" },
    { url: wm("Dore raven shadow2.jpg"), title: "Gustave Doré — The Raven", license: "public-domain", source: "Wikimedia Commons" },
  ],
};

interface ManifestStyle {
  id: string;
  referenceKeys: string[];
  attribution: { title?: string; license?: string; source?: string }[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function loadBytes(pathOrUrl: string): Promise<Buffer> {
  if (!/^https?:\/\//.test(pathOrUrl)) return readFile(pathOrUrl);
  // Wikimedia rate-limits bursts (429) — retry with backoff, be a good citizen.
  let lastStatus = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(1500 * attempt);
    const res = await fetch(pathOrUrl, { headers: { "User-Agent": "Mozilla/5.0 vid-template-gen/art-ingest (contact: swapnilcrlm@gmail.com)" } });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    lastStatus = res.status;
    if (res.status !== 429 && res.status !== 503) break;
  }
  throw new Error(`download ${lastStatus}`);
}

function extFor(src: string): string {
  const m = src.split("?")[0].match(/\.(png|jpe?g|webp)$/i);
  return (m?.[1] ?? "png").toLowerCase().replace("jpeg", "jpg");
}

async function fetchExistingManifest(): Promise<Map<string, ManifestStyle>> {
  try {
    const res = await fetch(cdnUrlFor("art-styles/manifest.json"));
    if (!res.ok) return new Map();
    const json = (await res.json()) as { styles?: ManifestStyle[] };
    return new Map((json.styles ?? []).map((s) => [s.id, s]));
  } catch {
    return new Map();
  }
}

async function ingestStyle(id: string, sources: RefSource[]): Promise<ManifestStyle | undefined> {
  if (!ART_STYLES[id]) console.warn(`⚠️  "${id}" is not in the art-style registry — ingesting anyway.`);
  const referenceKeys: string[] = [];
  const attribution: ManifestStyle["attribution"] = [];
  let n = 0;
  for (const src of sources) {
    n += 1;
    try {
      const buf = await loadBytes(src.url);
      const filename = `${id}/ref-${n}.${extFor(src.url)}`;
      await uploadToS3(buf, "art-styles", filename, `image/${extFor(src.url)}`);
      referenceKeys.push(`art-styles/${filename}`);
      attribution.push({ title: src.title, license: src.license, source: src.source });
      console.log(`  ✓ ${id} ref-${n} ← ${src.title}`);
      await sleep(1200); // space out Wikimedia requests
    } catch (error) {
      console.warn(`  ✗ ${id} ref-${n} failed (${src.url}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!referenceKeys.length) return undefined;
  return { id, referenceKeys, attribution };
}

/** Generate a style's reference frame with our own image model and upload it. */
async function generateStyleRef(id: string, scenePrompt: string): Promise<ManifestStyle | undefined> {
  const style = ART_STYLES[id];
  if (!style) {
    console.warn(`  ✗ ${id} not in registry — skipping generate`);
    return undefined;
  }
  const model = process.env.ART_REF_IMAGE_MODEL || "google/gemini-3.1-flash-image"; // value tier — crisp canonical anchor
  try {
    const localPath = await generateImage(scenePrompt, style.promptSuffix, { model });
    const buf = await readFile(localPath);
    const filename = `${id}/ref-1.png`;
    await uploadToS3(buf, "art-styles", filename, "image/png");
    console.log(`  ✓ ${id} ref-1 ← generated (${model})`);
    return {
      id,
      referenceKeys: [`art-styles/${filename}`],
      attribution: [{ title: `${style.displayName} — generated reference`, license: "generated", source: model }],
    };
  } catch (error) {
    console.warn(`  ✗ ${id} generate failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // --generate [styleId]: synthesize animation references via OpenRouter.
  if (args[0] === "--generate") {
    const only = args[1];
    const ids = only ? [only] : Object.keys(GENERATE);
    const manifest = await fetchExistingManifest();
    for (const id of ids) {
      const prompt = GENERATE[id];
      if (!prompt) {
        console.warn(`  ✗ no generation prompt for "${id}" (known: ${Object.keys(GENERATE).join(", ")})`);
        continue;
      }
      const result = await generateStyleRef(id, prompt);
      if (result) manifest.set(id, result);
    }
    const body = Buffer.from(JSON.stringify({ styles: [...manifest.values()] }, null, 2));
    await uploadToS3(body, "art-styles", "manifest.json", "application/json");
    console.log(`\n✅ Wrote art-styles/manifest.json (${manifest.size} style(s) with references).`);
    process.exit(0);
  }

  const jobs: Record<string, RefSource[]> = {};

  if (args.length >= 2) {
    // custom: <styleId> <path-or-url> [...]
    const [styleId, ...refs] = args;
    jobs[styleId] = refs.map((r, i) => ({ url: r, title: `${styleId} custom ref ${i + 1}`, license: "user-provided", source: r }));
  } else if (args.length === 1) {
    if (!CURATED[args[0]]) throw new Error(`No curated sources for "${args[0]}". Known: ${Object.keys(CURATED).join(", ")}`);
    jobs[args[0]] = CURATED[args[0]];
  } else {
    Object.assign(jobs, CURATED);
  }

  const manifest = await fetchExistingManifest();
  for (const [id, sources] of Object.entries(jobs)) {
    const result = await ingestStyle(id, sources);
    if (result) manifest.set(id, result);
  }

  const body = Buffer.from(JSON.stringify({ styles: [...manifest.values()] }, null, 2));
  await uploadToS3(body, "art-styles", "manifest.json", "application/json");
  console.log(`\n✅ Wrote art-styles/manifest.json (${manifest.size} style(s) with references).`);
  process.exit(0);
}

main().catch((error) => {
  console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
