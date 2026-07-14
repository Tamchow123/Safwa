/**
 * Arabic comparison normalisation — the approved policy from
 * docs/vocabulary-schema.md and CLAUDE.md, mirroring
 * normalize_for_comparison() in the Python scripts:
 *
 *   1. NFC normalisation
 *   2. Remove ONLY the documented invisible formatting characters
 *      (U+200B–U+200F, U+061C, U+FEFF, U+2060)
 *   3. Trim surrounding whitespace
 *
 * Nothing else. Harakat, shaddah, sukun, dagger alif and hamzah-seat
 * differences are meaningful and preserved.
 *
 * COMPARISON ONLY: never write the result back to persisted content or use
 * it to "fix" display strings. Browser-safe (no Node imports).
 */

const INVISIBLE_FORMATTING = /[\u200B-\u200F\u061C\uFEFF\u2060]/g;

/** Normalise a string for comparison/search. Never for storage or display. */
export function normalizeForComparison(value: string): string {
  return value.normalize("NFC").replace(INVISIBLE_FORMATTING, "").trim();
}

/** Strict Arabic equality under the approved comparison policy. */
export function arabicEqual(a: string, b: string): boolean {
  return normalizeForComparison(a) === normalizeForComparison(b);
}

/** Split a masdar cell into its alternatives (separator: " / "). */
export function splitMasdarAlternatives(value: string): string[] {
  return value.split(" / ");
}
