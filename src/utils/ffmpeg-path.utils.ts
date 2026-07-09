import { resolve } from "node:path";

/**
 * Escape a filesystem path for use inside an ffmpeg filtergraph option value
 * (e.g. `ass='…'`, `fontsdir='…'`, `fontfile='…'`, `textfile='…'`).
 *
 * Windows drive letters (`C:`) and backslashes must be escaped — otherwise the
 * filter parser treats `C:` as an option separator / protocol and the rest of
 * the path (plus following filters like `,fade=…`) becomes a bogus output path.
 * That is why caption burn fails on Windows but works on macOS/Linux.
 */
export function escapeFilterPath(p: string): string {
  // Absolute + forward slashes: ffmpeg filtergraphs are happier with `/` even
  // on Windows, and it avoids backslash-escaping hell.
  return resolve(p).replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}
