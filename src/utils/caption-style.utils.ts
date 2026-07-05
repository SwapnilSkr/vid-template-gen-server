import type { ICaptionStyle } from "../models";

/** Convert a stored caption style to a plain object.
 *  A Mongoose single-nested subdocument does NOT expose its schema fields as
 *  enumerable own properties, so `{ ...subdoc }` copies none of them — every
 *  field then silently falls back to the render default. `toObject()` is the
 *  only safe way to read the real values back out. */
export function captionStylePlain(existing?: ICaptionStyle | null): ICaptionStyle {
  if (!existing) return {};
  const doc = existing as ICaptionStyle & { toObject?: () => ICaptionStyle };
  if (typeof doc.toObject === "function") return doc.toObject();
  return { ...existing };
}

/** Merge caption patches without dropping fields already stored on the reel. */
export function mergeCaptionStyle(
  existing: ICaptionStyle | undefined | null,
  patch: ICaptionStyle
): ICaptionStyle {
  const prev = captionStylePlain(existing);
  return {
    ...prev,
    ...patch,
    alignment: 2,
    marginV: Math.round(
      Math.min(Math.max(patch.marginV ?? prev.marginV ?? 480, 0), 1900)
    ),
  };
}
