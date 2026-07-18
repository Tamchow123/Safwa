/**
 * Distractor selection for objective multiple-choice questions.
 *
 * Rules (PRODUCT_REQUIREMENTS.md §4.5):
 *   - same answer field as the target (the generator supplies a same-field
 *     candidate pool);
 *   - only quiz-eligible values (the generator only ever supplies eligible
 *     candidates — CLAUDE.md hard rule 2);
 *   - no duplicate visible choices after Arabic normalisation
 *     (normalised-uniqueness);
 *   - entries with identical surface forms are excluded from each other's
 *     option sets — both the correct answer's surface and any answer value
 *     that would be ambiguous given the prompt (`excludeNormalizedValues`);
 *   - plausibility-ranked: prefer the same bāb, then the same verb type, then
 *     the same book page.
 *
 * Fully deterministic given the injected RNG (docs/ARCHITECTURE.md §2).
 * Pure TypeScript: no React, DOM or DB imports.
 */
import type { BabId, VerbTypeId } from "@/modules/content/constants";
import type { AnswerReference } from "@/modules/content/answer-reference";
import { normalizeForComparison } from "@/shared/arabic/normalize";

import type { Rng } from "@/modules/study-engine/rng";

/** Comparison-key function for option values (field-aware; e.g. maṣdar split). */
export type ComparisonKey = (value: string) => string;

export type DistractorCandidate = {
  ref: AnswerReference;
  /** The display value shown as an option (Arabic form, meaning, bāb pair…). */
  value: string;
  entryId: number;
  bab: BabId | null;
  verbType: VerbTypeId | null;
  bookPage: number | null;
};

export type DistractorTarget = {
  correctValue: string;
  correctEntryId: number;
  bab: BabId | null;
  verbType: VerbTypeId | null;
  bookPage: number | null;
};

const PLAUSIBILITY_SAME_BAB = 4;
const PLAUSIBILITY_SAME_VERB_TYPE = 2;
const PLAUSIBILITY_SAME_PAGE = 1;

function plausibilityScore(
  target: DistractorTarget,
  candidate: DistractorCandidate,
): number {
  let score = 0;
  if (target.bab !== null && candidate.bab === target.bab) {
    score += PLAUSIBILITY_SAME_BAB;
  }
  if (target.verbType !== null && candidate.verbType === target.verbType) {
    score += PLAUSIBILITY_SAME_VERB_TYPE;
  }
  if (target.bookPage !== null && candidate.bookPage === target.bookPage) {
    score += PLAUSIBILITY_SAME_PAGE;
  }
  return score;
}

/**
 * Select up to `count` distractors, plausibility-ranked and unique under the
 * supplied comparison key (default: normalise-only; the generator passes a
 * maṣdar-split-aware key), excluding the correct value and any ambiguous value.
 * Returns fewer than `count` only when the eligible, unambiguous pool is too
 * small; the generator treats that as a generation failure.
 */
export function selectDistractors(
  target: DistractorTarget,
  candidates: readonly DistractorCandidate[],
  count: number,
  rng: Rng,
  excludeComparisonKeys: ReadonlySet<string> = new Set(),
  comparisonKey: ComparisonKey = normalizeForComparison,
): DistractorCandidate[] {
  if (count < 0) throw new Error("count must be non-negative");
  const correctKey = comparisonKey(target.correctValue);

  // Stable base order first, so RNG consumption and dedup are reproducible.
  // Compare by codepoint (never locale-sensitive) so ordering is identical on
  // every platform — this module's whole premise is cross-platform determinism.
  const ordered = [...candidates].sort(
    (a, b) =>
      a.entryId - b.entryId ||
      (a.ref.field < b.ref.field ? -1 : a.ref.field > b.ref.field ? 1 : 0),
  );

  // Group by comparison key and keep the MOST plausible eligible representative
  // per surface form (ties → lowest entry id, since `ordered` is id-ascending
  // and we only replace on a strictly higher score). Picking an arbitrary
  // first-seen representative before scoring would defeat plausibility when a
  // duplicate surface has more-plausible metadata on a higher-id entry.
  const bestByKey = new Map<
    string,
    { candidate: DistractorCandidate; score: number }
  >();
  for (const candidate of ordered) {
    if (candidate.entryId === target.correctEntryId) continue;
    const key = comparisonKey(candidate.value);
    if (key === correctKey) continue; // ambiguous surface form
    if (excludeComparisonKeys.has(key)) continue;
    const score = plausibilityScore(target, candidate);
    const existing = bestByKey.get(key);
    if (!existing || score > existing.score) {
      bestByKey.set(key, { candidate, score });
    }
  }
  // Deterministic order for RNG consumption: by representative entry id.
  const eligible = [...bestByKey.values()].sort(
    (a, b) => a.candidate.entryId - b.candidate.entryId,
  );

  // Rank: higher plausibility first; seeded jitter breaks ties fairly but
  // deterministically; entry id is the final deterministic tie-breaker.
  const ranked = eligible.map((entry) => ({ ...entry, jitter: rng.next() }));
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      a.jitter - b.jitter ||
      a.candidate.entryId - b.candidate.entryId,
  );

  return ranked.slice(0, count).map((entry) => entry.candidate);
}
