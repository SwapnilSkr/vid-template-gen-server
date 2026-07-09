import { resolve } from "node:path";
import { FONTS_DIR, hasFontsDir } from "../config/fonts";

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

/**
 * Escape a path for ffmpeg's concat demuxer list format:
 *   file '/absolute/path.mp3'
 *
 * Windows backslashes are escape characters inside the quoted path, so they
 * must become forward slashes. Single quotes in the path are closed/reopened
 * per the demuxer rules (`'\''`).
 */
export function escapeConcatDemuxerPath(p: string): string {
  return resolve(p)
    .replace(/\\/g, "/")
    .replace(/'/g, "'\\''");
}

/** One concat-list line: `file '/escaped/path'`. */
export function concatDemuxerEntry(p: string): string {
  return `file '${escapeConcatDemuxerPath(p)}'`;
}

/**
 * Build an `ass=` video-filter fragment with optional bundled `fontsdir`.
 * Always prefer this over hand-rolling `ass='…'` so Windows paths and
 * non-system fonts (Poppins, etc.) work on every device.
 *
 * @param extras Optional trailing filters, e.g. `fade=t=in:st=0:d=0.4`
 */
export function assVideoFilter(assPath: string, extras?: string): string {
  const fontsdir = hasFontsDir() ? `:fontsdir='${escapeFilterPath(FONTS_DIR)}'` : "";
  const base = `ass='${escapeFilterPath(assPath)}'${fontsdir}`;
  return extras ? `${base},${extras}` : base;
}

/**
 * Same as {@link assVideoFilter} but for filtergraph labels that need the
 * `filename=` form: `ass=filename='…':fontsdir='…'`.
 */
export function assFilenameFilter(assPath: string): string {
  const fontsdir = hasFontsDir() ? `:fontsdir='${escapeFilterPath(FONTS_DIR)}'` : "";
  return `ass=filename='${escapeFilterPath(assPath)}'${fontsdir}`;
}
