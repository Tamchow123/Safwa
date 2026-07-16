/**
 * Arabic comparison/search keys.
 *
 * NAMING NOTE: this is NOT the study-component natural-key builder — that
 * concept (`entry:<id>:skill:<skill>...`) belongs to Phase 6 and lives in
 * the study-engine module when it is built. This file only derives stable
 * comparison keys from Arabic text for search/dedup purposes.
 */
import { normalizeForComparison } from "@/shared/arabic/normalize";

/**
 * Stable comparison key for Arabic (or English) display text: the approved
 * comparison normalisation, nothing more. Never persisted back to content.
 */
export function arabicComparisonKey(value: string): string {
  return normalizeForComparison(value);
}
