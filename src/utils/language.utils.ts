// Cheap heuristic language gate — no external NLP dependency needed since we
// only need a yes/no "is this usable as an English-language trend signal"
// answer before feeding titles into an LLM summarization prompt.
/* eslint-disable no-misleading-character-class --
   intentional: several scripts here (Devanagari, Tamil, etc.) include
   combining marks, and we want the whole block matched as "non-Latin",
   combining marks included. */
const NON_LATIN_SCRIPT_PATTERN = new RegExp(
  "[" +
    "\\u0400-\\u04FF" + // Cyrillic
    "\\u0590-\\u05FF" + // Hebrew
    "\\u0600-\\u06FF" + // Arabic
    "\\u0900-\\u097F" + // Devanagari (Hindi)
    "\\u0980-\\u09FF" + // Bengali
    "\\u0A00-\\u0A7F" + // Gurmukhi
    "\\u0A80-\\u0AFF" + // Gujarati
    "\\u0B80-\\u0BFF" + // Tamil
    "\\u0C00-\\u0C7F" + // Telugu
    "\\u0C80-\\u0CFF" + // Kannada
    "\\u0D00-\\u0D7F" + // Malayalam
    "\\u0E00-\\u0E7F" + // Thai
    "\\u0E80-\\u0EFF" + // Lao
    "\\u10A0-\\u10FF" + // Georgian
    "\\u3040-\\u30FF" + // Hiragana + Katakana
    "\\u4E00-\\u9FFF" + // CJK Unified Ideographs
    "\\uAC00-\\uD7A3" + // Hangul syllables
    "\\uF900-\\uFAFF" + // CJK compatibility ideographs
    "]",
  "g"
);
/* eslint-enable no-misleading-character-class */

/** True if `text` reads as predominantly English/Latin-script — i.e. safe to
 * feed into an English trend-pattern digest without polluting it with
 * untranslated foreign-script titles. Not a real language classifier: just a
 * script-ratio heuristic (non-Latin-script chars / letter-ish chars). */
export function isEnglishText(text: string, maxForeignRatio = 0.1): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return true; // no letters at all (emoji/numbers only) — nothing to object to
  const foreign = text.match(NON_LATIN_SCRIPT_PATTERN) ?? [];
  return foreign.length / letters.length <= maxForeignRatio;
}
