import { cdnUrlFor, getJson } from "./s3.service";
import { ART_STYLES, artStylesForNiche, getArtStyle, type ArtStyle } from "../config/art-styles";

// ============================================
// Reference-art style catalog for the create UI. Merges the static registry
// (config/art-styles.ts) with the S3 manifest written by
// scripts/ingest-art-styles.ts — the manifest is the source of truth for which
// reference images actually exist, so a style that hasn't been ingested yet
// still shows up (with its registry defaults) but flags no thumbnails.
// Mirrors the horror-audio.service.ts manifest pattern.
// ============================================

export interface ArtStyleAttribution {
  title?: string;
  license?: string;
  source?: string;
}

export interface ArtStyleOption {
  id: string;
  displayName: string;
  description: string;
  niches: string[];
  referenceKeys: string[];
  thumbnailUrl?: string;
  attribution: ArtStyleAttribution[];
  motionHint?: ArtStyle["motionHint"];
}

interface ArtStyleManifest {
  styles?: {
    id?: string;
    referenceKeys?: string[];
    attribution?: ArtStyleAttribution[];
  }[];
}

async function fetchManifest(): Promise<Map<string, { referenceKeys: string[]; attribution: ArtStyleAttribution[] }>> {
  // Read straight from S3 (not the CDN): CloudFront caches manifest.json and
  // ignores query-busters, so a fetch via cdnUrlFor serves a stale manifest for
  // a long time after `ingest-art-styles.ts` re-uploads it (a newly generated
  // reference wouldn't appear). Mirrors listImageModels reading model-health.json.
  const manifest = await getJson<ArtStyleManifest>("art-styles/manifest.json");
  if (!manifest) return new Map();
  return new Map(
    (manifest.styles ?? [])
      .filter((s) => s.id)
      .map((s) => [
        s.id!,
        { referenceKeys: s.referenceKeys ?? [], attribution: s.attribution ?? [] },
      ])
  );
}

function toOption(style: ArtStyle, manifest: Map<string, { referenceKeys: string[]; attribution: ArtStyleAttribution[] }>): ArtStyleOption {
  const fromManifest = manifest.get(style.id);
  const referenceKeys = fromManifest?.referenceKeys.length ? fromManifest.referenceKeys : style.referenceKeys;
  return {
    id: style.id,
    displayName: style.displayName,
    description: style.description,
    niches: style.niches,
    referenceKeys,
    thumbnailUrl: referenceKeys[0] ? cdnUrlFor(referenceKeys[0]) : undefined,
    attribution: fromManifest?.attribution ?? [],
    motionHint: style.motionHint,
  };
}

/** List art styles for the picker, optionally filtered to a niche. */
export async function listArtStyles(niche?: string): Promise<ArtStyleOption[]> {
  const manifest = await fetchManifest();
  const styles = niche ? artStylesForNiche(niche) : Object.values(ART_STYLES);
  return styles.map((style) => toOption(style, manifest));
}

/** Resolve one style's reference keys (manifest-preferred) for image conditioning. */
export async function resolveArtStyleRefKeys(id?: string): Promise<{ style: ArtStyle; keys: string[] } | undefined> {
  const style = getArtStyle(id);
  if (!style) return undefined;
  const manifest = await fetchManifest();
  const fromManifest = manifest.get(style.id);
  const keys = fromManifest?.referenceKeys.length ? fromManifest.referenceKeys : style.referenceKeys;
  return { style, keys };
}
