/**
 * Field-value resolution for learner entries — the single place that maps an
 * answer field to its learner-facing value. Bāb and verb type resolve to their
 * Arabic pair (`bab_arabic` / `verb_type_arabic`), never a number or id
 * (CLAUDE.md hard rule 5). Shared by question generation and correctness so
 * both sides agree on exactly what an answer reference denotes.
 *
 * Pure TypeScript: no React, DOM or DB imports.
 */
import {
  SOURCE_QUIZ_FORM_FIELDS,
  type AnswerField,
  type SourceQuizFormField,
} from "@/modules/content/constants";
import type { LearnerEntry } from "@/modules/content/schema";
import {
  normalizeForComparison,
  splitMasdarAlternatives,
} from "@/shared/arabic/normalize";

export class MissingFieldValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingFieldValueError";
  }
}

export function isSourceFormField(
  field: AnswerField,
): field is SourceQuizFormField {
  return (SOURCE_QUIZ_FORM_FIELDS as readonly string[]).includes(field);
}

/**
 * The learner-facing display value for a field. Throws if the value is absent
 * (e.g. an ineligible root that carries no value in the learner release).
 */
export function fieldValue(entry: LearnerEntry, field: AnswerField): string {
  switch (field) {
    case "bab":
      return entry.bab_arabic;
    case "verb_type":
      return entry.verb_type_arabic;
    case "root":
      if (entry.root === undefined) {
        throw new MissingFieldValueError(
          `entry ${entry.id} has no eligible root value`,
        );
      }
      return entry.root;
    default:
      return entry[field];
  }
}

/** Is a field quiz-eligible for an entry (per the learner eligibility booleans)? */
export function isFieldEligible(
  entry: LearnerEntry,
  field: AnswerField,
): boolean {
  return entry.quiz_eligibility[field] === true;
}

/**
 * The comparison key for an answer VALUE under the approved Arabic policy
 * (CLAUDE.md hard rule 4). For every field it is the normalise-only key; for
 * maṣdar it additionally splits alternatives on " / " and compares the
 * order-independent alternative SET, so two maṣdar cells listing the same
 * alternatives (in any order) are equal — never both shown as distinct options.
 * Display strings are never rewritten; this key is used for comparison only.
 */
export function answerComparisonKey(field: AnswerField, value: string): string {
  if (field === "masdar") {
    // A true SET: normalise, de-duplicate, then sort — so "A / B" and
    // "A / B / B" (same alternatives, repeated) compare equal, as do reordered
    // alternatives. The display string is never altered.
    const alternatives = splitMasdarAlternatives(value).map((alternative) =>
      normalizeForComparison(alternative),
    );
    return [...new Set(alternatives)].sort().join(" / ");
  }
  return normalizeForComparison(value);
}

/** Field-aware answer equality under the approved comparison policy. */
export function answerValuesEqual(
  field: AnswerField,
  a: string,
  b: string,
): boolean {
  return answerComparisonKey(field, a) === answerComparisonKey(field, b);
}
