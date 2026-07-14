/**
 * Text normalisation for data that crosses the SAP → pdf.js → LLM boundary.
 *
 * SAP report PDFs, the pdf.js text layer, and the LLM that extracts the
 * ZSO-VISIBILITY material list all inject characters that are invisible to a
 * human but defeat exact/prefix string comparison. A single non-breaking space
 * (U+00A0) or zero-width space (U+200B) between "IV" and "BR" was enough to make
 * a real SAP material code ("YT2REIR090200Z3P") fail to match its Material row
 * and fall back to the useless family prefix ("OT2FJ") — which then corrupts
 * plant routing, bundle weight, and the branch-facing emails.
 *
 * These helpers are the single choke point that makes such text comparable.
 */

/**
 * Zero-width / bidi / soft-hyphen characters that carry NO visible glyph. They
 * are removed outright (not turned into a space) because they sit *between*
 * glyphs that must stay adjacent.
 *   U+00AD soft hyphen
 *   U+200B..U+200F zero-width space/non-joiner/joiner + LRM/RLM bidi marks
 *   U+2060 word joiner
 *   U+FEFF BOM / zero-width no-break space
 */
const INVISIBLE_RE = /[\u00AD\u200B\u200C\u200D\u200E\u200F\u2060\uFEFF]/g;

/**
 * Canonicalise arbitrary extracted text so two strings that look identical to a
 * human compare equal. Layered so nothing slips through:
 *   1. NFKC — folds compatibility forms: non-breaking / narrow / figure / thin /
 *      hair / ideographic spaces → ASCII space, full-width digits/letters →
 *      ASCII, ligatures decomposed. Turns most "weird space" variants into a
 *      plain U+0020 for step 4.
 *   2. strip invisibles (INVISIBLE_RE) — removed, not spaced.
 *   3. any remaining control / format char (\p{Cc}\p{Cf}, e.g. NEL, exotic
 *      separators) → space.
 *   4. collapse every run of whitespace to one ASCII space, then trim.
 *
 * Case is preserved — callers that compare case-insensitively append
 * `.toUpperCase()`. Null/undefined → "".
 */
export function sanitizeText(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .normalize('NFKC')
    .replace(INVISIBLE_RE, '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Comparison key for descriptions and batch tokens: fully sanitised + upper-cased.
 * Use for all match logic (never for storage/display, which keeps the original casing).
 */
export function normaliseForMatch(s: string | null | undefined): string {
  return sanitizeText(s).toUpperCase();
}
