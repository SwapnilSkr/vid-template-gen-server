// ============================================
// Reddit-story narration normalization.
//
// Story text is written for the eye, not the ear: it is full of subreddit
// acronyms (AITA, NTA), age/gender tags (31M, (28F)), chat shorthand (bc, tbh),
// censored profanity (f*ck), and editor cruft (markdown, "Edit:", URLs, emoji).
// Sent raw to TTS it is mispronounced ("aita" as a word) or read literally
// ("asterisk"). This module rewrites it BEFORE synthesis.
//
// speech ↔ caption alignment (see Issue 1 / caption-timing.ts)
// ---------------------------------------------------------------
// Captions must keep matching what is actually spoken, and the per-word
// highlighter aligns caption tokens 1:1 with spoken tokens by whitespace. So
// every rule here emits a `{ speech, caption }` pair with the SAME whitespace
// token count in both forms:
//
//   • Letter-spelled acronyms → speech "A.I.T.A." (dotted, ONE token, read as
//     letters by TTS) / caption "AITA" (ONE token, still reads as the acronym
//     on screen). 1 token ↔ 1 token.
//   • Expansions that read well either way → same string in both, e.g.
//     "31M" → "31 male" / "31 male" (2 ↔ 2), "bc" → "because" (1 ↔ 1).
//
// Because `normalizeNarration` returns two strings with identical token counts,
// callers can synth from `.speech`, caption from `.caption`, split both on
// whitespace, and the amber highlighter maps word-for-word with zero drift.
//
// The tables below are intentionally plain data — extend them freely.
// ============================================

export interface NormalizedNarration {
  /** Text to send to TTS (letters spelled, profanity de-censored, expansions). */
  speech: string;
  /** Text to show as captions (acronyms kept readable, otherwise == speech). */
  caption: string;
}

interface TokenForm {
  speech: string;
  caption: string;
}

/**
 * Acronyms TTS should SPELL OUT letter by letter. Caption keeps the acronym as
 * written; speech uses a dotted single token so it reads as letters without
 * adding a whitespace boundary the caption lacks.
 *
 * Decision log (letters vs expansion — override freely):
 *  - AITA/AITAH/WIBTA are the *brand* of the format; spelling them out is how
 *    creators read them aloud, so we letter-spell and keep the on-screen acronym.
 *  - NTA/YTA/ESH/NAH are verdicts read as letters in practice → letter-spell.
 *  - TIFU is read "tifu"/"T.I.F.U." inconsistently; letters are unambiguous.
 */
const LETTER_SPELL = new Set([
  "AITA",
  "AITAH",
  "WIBTA",
  "NTA",
  "YTA",
  "ESH",
  "NAH",
  "TIFU",
  "OP",
  "CPS",
  "DNA",
  "PTO",
  "HR",
  "ER",
]);

/**
 * Expansions read the same on screen and aloud. Keys are matched
 * case-insensitively on alphanumeric-stripped tokens. Multi-word values keep
 * caption == speech so token counts stay aligned.
 */
const EXPANSIONS: Record<string, string> = {
  // chat shorthand
  bc: "because",
  b4: "before",
  cuz: "because",
  tho: "though",
  ngl: "not gonna lie",
  tbh: "to be honest",
  smh: "shaking my head",
  imo: "in my opinion",
  imho: "in my opinion",
  istg: "I swear to god",
  idk: "I don't know",
  idc: "I don't care",
  iirc: "if I recall correctly",
  afaik: "as far as I know",
  fwiw: "for what it's worth",
  imu: "I miss you",
  irl: "in real life",
  rn: "right now",
  atm: "at the moment",
  fyi: "for your information",
  omg: "oh my god",
  lmao: "laughing my ass off",
  af: "as fuck",
  ffs: "for fuck's sake",
  wtf: "what the fuck",
  eli5: "explain like I'm five",
};

/**
 * Reddit relationship shorthand (keys lowercase). Most forms match
 * case-insensitively so MiL / SiL / mil all expand. Keys in
 * RELATIONSHIP_ALL_CAPS_ONLY also collide with English words and only expand
 * when every letter is uppercase (SO yes, "so" / "So" no).
 */
const RELATIONSHIP_EXPANSIONS: Record<string, string> = {
  so: "significant other",
  dh: "dear husband",
  dw: "dear wife",
  dd: "dear daughter",
  ds: "dear son",
  mil: "mother in law",
  fil: "father in law",
  bil: "brother in law",
  sil: "sister in law",
  so2: "significant other",
};

/** Collides with English — require ALL-CAPS letters (SO, SO2). */
const RELATIONSHIP_ALL_CAPS_ONLY = new Set(["so", "so2"]);

function relationshipExpansion(alnum: string): string | undefined {
  const key = alnum.toLowerCase();
  const exp = RELATIONSHIP_EXPANSIONS[key];
  if (!exp) return undefined;
  if (RELATIONSHIP_ALL_CAPS_ONLY.has(key)) {
    const letters = alnum.replace(/[^A-Za-z]/g, "");
    if (!letters || letters !== letters.toUpperCase()) return undefined;
  }
  return exp;
}

/** Multi-word phrase replacements applied before tokenizing (order matters). */
const PHRASE_EXPANSIONS: [RegExp, string][] = [
  [/\bTL\s*;?\s*DR\b/gi, "too long, didn't read"],
  [/\bTL\s*;?\s*DW\b/gi, "too long, didn't write"],
];

/**
 * Censored / misspelled profanity → the real word so TTS says it, not
 * "f asterisk ck". Applied token-wise (see stripAffixes) and here for the
 * common inline forms.
 */
const PROFANITY: Record<string, string> = {
  fck: "fuck",
  fuk: "fuck",
  fuck: "fuck",
  fk: "fuck",
  fcking: "fucking",
  fckin: "fucking",
  sht: "shit",
  shet: "shit",
  bitchh: "bitch",
  azz: "ass",
  damm: "damn",
};

/** Strip markdown, URLs, emoji, and editor labels TTS reads awkwardly. */
function precleanShared(text: string): string {
  let t = text;
  // Markdown links [label](url) → label
  t = t.replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1");
  // Bare URLs
  t = t.replace(/https?:\/\/\S+/gi, " ");
  t = t.replace(/\bwww\.\S+/gi, " ");
  // Editor labels at a line/segment head: "Edit:", "Update:", "TL;DR:" handled elsewhere
  t = t.replace(/\b(edit|update|eta|edit\s*\d+|final edit)\s*:\s*/gi, " ");
  // Markdown emphasis / headings / quotes / bullets (leave asterisks that sit
  // INSIDE a word for the profanity de-censor, handled per token).
  t = t.replace(/(^|\s)[#>*\-_]+(\s)/g, "$1$2");
  t = t.replace(/[_`~]+/g, "");
  // Emoji / pictographs / symbols (+ variation selectors / ZWJ they carry)
  t = t.replace(
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu,
    " "
  );
  t = t.replace(/[\u{FE0F}\u{200D}]/gu, "");
  // Collapse repeated sentence punctuation ("!!!" → "!", "?!?" → "?").
  t = t.replace(/([!?.,])\1{1,}/g, "$1");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

/** letters → dotted single token, e.g. "AITA" → "A.I.T.A." */
function letterSpell(acronym: string): string {
  return `${acronym.split("").join(".")}.`;
}

/** Split leading/trailing punctuation off a token so rules match the core. */
function stripAffixes(token: string): { pre: string; core: string; post: string } {
  const m = /^([^\p{L}\p{N}*]*)(.*?)([^\p{L}\p{N}*]*)$/u.exec(token);
  if (!m) return { pre: "", core: token, post: "" };
  return { pre: m[1] ?? "", core: m[2] ?? "", post: m[3] ?? "" };
}

/** Age/gender tag → "<age> male/female" (2 tokens). Returns undefined if no match. */
function ageGender(core: string): TokenForm | undefined {
  // 31M, 31m, 31F  |  M31, f28  |  31M/31F with surrounding parens handled by affixes
  let m = /^(\d{1,2})\s*([MmFf])$/.exec(core);
  if (!m) {
    const m2 = /^([MmFf])\s*(\d{1,2})$/.exec(core);
    if (m2) m = [m2[0], m2[2], m2[1]] as unknown as RegExpExecArray;
  }
  if (!m) return undefined;
  const age = m[1];
  const sex = m[2].toLowerCase() === "m" ? "male" : "female";
  const form = `${age} ${sex}`;
  return { speech: form, caption: form };
}

/**
 * De-censor asterisked/truncated profanity: "f*ck"/"f**k"/"sh*t"/"fck" → the
 * real word. Masking symbols are dropped, then the bare consonant skeleton is
 * looked up in PROFANITY (e.g. "sh*t" → "sht" → "shit").
 */
function decensor(core: string): string | undefined {
  const skeleton = core.toLowerCase().replace(/[^a-z]/g, "");
  if (!skeleton) return undefined;
  return PROFANITY[skeleton];
}

function normalizeToken(token: string): TokenForm {
  const { pre, core, post } = stripAffixes(token);
  if (!core) return { speech: token, caption: token };

  const upper = core.toUpperCase();
  const alnum = core.replace(/[^A-Za-z0-9]/g, "");

  // 1. Letter-spelled acronyms (AITA → A.I.T.A. / AITA)
  if (LETTER_SPELL.has(upper.replace(/[^A-Z]/g, ""))) {
    const letters = upper.replace(/[^A-Z]/g, "");
    return {
      speech: `${pre}${letterSpell(letters)}${post}`,
      caption: `${pre}${letters}${post}`,
    };
  }

  // 2. Age/gender tags (31M → 31 male)
  const ag = ageGender(core);
  if (ag) {
    return {
      speech: `${pre}${ag.speech}${post}`,
      caption: `${pre}${ag.caption}${post}`,
    };
  }

  // 3. De-censored profanity (f*ck → fuck)
  const prof = decensor(core);
  if (prof) {
    return { speech: `${pre}${prof}${post}`, caption: `${pre}${prof}${post}` };
  }

  // 4. Expansions that read the same both ways (bc → because)
  const exp = EXPANSIONS[alnum.toLowerCase()];
  if (exp) {
    return { speech: `${pre}${exp}${post}`, caption: `${pre}${exp}${post}` };
  }

  // 5. Relationship shorthand (MiL/SiL/mil ok; "so" stays English unless SO)
  const rel = relationshipExpansion(alnum);
  if (rel) {
    return { speech: `${pre}${rel}${post}`, caption: `${pre}${rel}${post}` };
  }

  return { speech: token, caption: token };
}

/**
 * Normalize a chunk of story text into aligned speech + caption forms.
 * Both returned strings have identical whitespace-token counts so the caption
 * word-highlighter stays in sync with the spoken audio (see module header).
 */
export function normalizeNarration(text: string): NormalizedNarration {
  let pre = precleanShared(text);
  for (const [pattern, replacement] of PHRASE_EXPANSIONS) {
    pre = pre.replace(pattern, replacement);
  }
  const tokens = pre.split(/\s+/).filter(Boolean);
  const speechParts: string[] = [];
  const captionParts: string[] = [];
  for (const token of tokens) {
    const form = normalizeToken(token);
    // A rule may expand a single token into several words; both forms carry the
    // same word count, so alignment is preserved when callers re-split.
    speechParts.push(form.speech);
    captionParts.push(form.caption);
  }
  return {
    speech: speechParts.join(" ").replace(/\s+/g, " ").trim(),
    caption: captionParts.join(" ").replace(/\s+/g, " ").trim(),
  };
}

/** Convenience: speech-only normalization (title narration, part-outro, etc.). */
export function normalizeForSpeech(text: string): string {
  return normalizeNarration(text).speech;
}
