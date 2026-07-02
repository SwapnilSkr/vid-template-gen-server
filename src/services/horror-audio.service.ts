import { cdnUrlFor, listKeys } from "./s3.service";

export interface HorrorAudioOption {
  key: string;
  url: string;
  label: string;
  title?: string;
  license?: string;
  landingUrl?: string;
}

interface HorrorAudioManifest {
  files?: {
    s3_key?: string;
    title?: string;
    license?: string;
    landing_url?: string;
  }[];
}

function labelFromKey(key: string): string {
  return key
    .split("/")
    .pop()!
    .replace(/^\d+-/, "")
    .replace(/\.mp3$/i, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

async function fetchManifest(): Promise<Map<string, HorrorAudioOption>> {
  try {
    const res = await fetch(cdnUrlFor("horror-audio/manifest.json"));
    if (!res.ok) return new Map();
    const manifest = (await res.json()) as HorrorAudioManifest;
    return new Map(
      (manifest.files ?? [])
        .filter((file) => file.s3_key?.endsWith(".mp3"))
        .map((file) => [
          file.s3_key!,
          {
            key: file.s3_key!,
            url: cdnUrlFor(file.s3_key!),
            label: file.title ?? labelFromKey(file.s3_key!),
            title: file.title,
            license: file.license,
            landingUrl: file.landing_url,
          },
        ])
    );
  } catch {
    return new Map();
  }
}

export async function listHorrorAudioLibrary(): Promise<HorrorAudioOption[]> {
  const [keys, manifest] = await Promise.all([listKeys("horror-audio/"), fetchManifest()]);
  return keys
    .filter((key) => key.endsWith(".mp3"))
    .sort()
    .map((key) => manifest.get(key) ?? { key, url: cdnUrlFor(key), label: labelFromKey(key) });
}
