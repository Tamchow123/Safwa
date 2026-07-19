/**
 * Hint derivation for objective quiz questions (PRODUCT_REQUIREMENTS.md §4.4,
 * Phase 11): first letter, root, word length, bāb, another form.
 *
 * Availability is derived from the QUESTION, not hard-coded per mode, under
 * two rules enforced here:
 *
 *  1. **Eligibility (CLAUDE.md hard rule 2)** — a hint only ever exposes a
 *     quiz-eligible value: the root hint requires `quiz_eligibility.root`
 *     (so entries 369/372 can never leak an unverified root), the bāb hint
 *     requires `quiz_eligibility.bab`, and the "another form" hint only picks
 *     eligible source forms.
 *  2. **No self-reveal** — a hint must never hand over the answer itself: no
 *     root hint on a root question NOR on a māḍī answer (the māḍī is the bare
 *     root plus vowels — its root is a near-total reveal), no bāb hint on a
 *     bāb question, no "another form" hint on a bāb question (prompt form +
 *     another form spell out the pattern pair), the "another form" hint never
 *     shows the prompt or the answer field, and any hint whose full value
 *     compares equal to the correct answer (approved Arabic comparison
 *     policy) is dropped.
 *
 * Values are read programmatically from the entry via the shared `fieldValue`
 * resolver (never copied or hand-typed — hard rule 3) and only ever SLICED or
 * COUNTED for display; nothing normalised is written back anywhere (rule 4).
 *
 * Hints are recorded per attempt (`hint_used` / `hint_type`) by the session
 * engine; the FSRS mapping (hinted correct ⇒ Hard, hinted incorrect ⇒ Again)
 * lives in `modules/scheduler/ratings.ts` (§5).
 *
 * Pure TypeScript: no React, DOM or DB imports (docs/ARCHITECTURE.md §2).
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

import {
  fieldValue,
  isFieldEligible,
  isSourceFormField,
} from "@/modules/study-engine/fields";
import type {
  HintType,
  QuestionContext,
  QuestionInstance,
} from "@/modules/study-engine/generator";
import { QuestionGenerationError } from "@/modules/study-engine/generator";

/** One offerable hint: its type, a display label, and the value to show. */
export type HintContent = {
  type: HintType;
  /** English chrome naming the hint (e.g. "Root", "First letter"). */
  label: string;
  /** The revealed hint text. */
  value: string;
  /** True when `value` is Arabic script (render with <ArabicText>). */
  isArabic: boolean;
};

/**
 * The single display word the first-letter / word-length hints describe. For
 * a maṣdar cell the FIRST listed alternative (the alternatives are equal
 * answers; hinting one is enough); for the English base meaning the first
 * comma/semicolon-separated gloss with any leading "to " dropped (nearly every
 * verb gloss starts with "to", which would make the hint useless).
 */
function hintTargetWord(answerField: AnswerField, value: string): string {
  if (answerField === "meaning") {
    const firstGloss = value.split(/[,;]/, 1)[0].trim();
    return firstGloss.replace(/^to\s+/i, "");
  }
  if (answerField === "masdar") {
    return splitMasdarAlternatives(value)[0].trim();
  }
  return value.trim();
}

/** The first LETTER (Unicode Letter property) for display — combining marks,
 * punctuation and digits are never "the first letter". */
function firstLetterOf(word: string): string {
  return [...word].find((char) => /\p{L}/u.test(char)) ?? "";
}

/**
 * Letters in the word: Unicode Letter code points ONLY. The hint says
 * "letters", so punctuation (parentheses, apostrophes, hyphens), digits,
 * spaces and Arabic combining marks (ḥarakāt are Mn, not L) never count.
 */
function letterCountOf(word: string): number {
  return [...word].filter((char) => /\p{L}/u.test(char)).length;
}

/** Fields whose value is Arabic script (everything except the meaning). */
function isArabicAnswerField(field: AnswerField): boolean {
  return field !== "meaning";
}

/**
 * Word-shaped answer fields — the ones where a first letter or letter count
 * is a meaningful partial reveal. Bāb / verb-type answers are PATTERN PAIRS
 * (two words of fixed shape), where both hints would be noise.
 */
function isWordAnswerField(field: AnswerField): boolean {
  return isSourceFormField(field) || field === "meaning" || field === "root";
}

/**
 * Does a candidate hint value REVEAL the correct answer, under the approved
 * FIELD-AWARE comparison policy (hard rule 4)? For a maṣdar answer the cell
 * lists ALTERNATIVES separated by " / " and EVERY alternative is an accepted
 * answer — so a candidate equal to ANY single alternative reveals the answer,
 * even though it never equals the whole cell. Every other field is plain
 * normalise-and-compare. Exported for direct testing.
 */
export function hintRevealsAnswer(
  answerField: AnswerField,
  correctValue: string,
  candidateValue: string,
): boolean {
  const candidateKey = normalizeForComparison(candidateValue);
  if (answerField === "masdar") {
    return splitMasdarAlternatives(correctValue).some(
      (alternative) => normalizeForComparison(alternative) === candidateKey,
    );
  }
  return normalizeForComparison(correctValue) === candidateKey;
}

/**
 * The deterministic "another form" pick: the first eligible source form (in
 * canonical field order) that is neither the prompt nor the answer field and
 * whose value does not reveal the correct answer (a form that happens to
 * match the answer surface — or any single maṣdar ALTERNATIVE — must not
 * silently reveal it).
 */
function anotherFormFor(
  entry: LearnerEntry,
  instance: QuestionInstance,
  correctValue: string,
): SourceQuizFormField | null {
  for (const field of SOURCE_QUIZ_FORM_FIELDS) {
    if (field === instance.promptField || field === instance.answerField) {
      continue;
    }
    if (!isFieldEligible(entry, field)) continue;
    if (
      hintRevealsAnswer(
        instance.answerField,
        correctValue,
        fieldValue(entry, field),
      )
    ) {
      continue;
    }
    return field;
  }
  return null;
}

/**
 * Every hint offerable for this question, in the stable §4.4 order
 * (first letter, root, word length, bāb, another form). Deterministic in
 * (context, instance); returns an empty array when nothing safe is available.
 */
export function availableHints(
  context: QuestionContext,
  instance: QuestionInstance,
): HintContent[] {
  const entry = context.entriesById.get(instance.entryId);
  if (!entry) {
    throw new QuestionGenerationError(
      `entry ${instance.entryId} is not in the loaded content release`,
    );
  }
  const correctValue = fieldValue(entry, instance.answerField);
  const targetWord = hintTargetWord(instance.answerField, correctValue);
  const hints: HintContent[] = [];

  if (isWordAnswerField(instance.answerField)) {
    const firstLetter = firstLetterOf(targetWord);
    if (firstLetter !== "") {
      hints.push({
        type: "first_letter",
        label: "First letter",
        value: firstLetter,
        isArabic: isArabicAnswerField(instance.answerField),
      });
    }
  }

  // No root hint when the answer IS the root, and none when the answer is
  // the māḍī: the māḍī is the bare root plus vowels, so its root hint would
  // hand over the full consonant skeleton — a near-total reveal, not a hint.
  if (
    instance.answerField !== "root" &&
    instance.answerField !== "madi" &&
    isFieldEligible(entry, "root")
  ) {
    const root = fieldValue(entry, "root");
    if (!hintRevealsAnswer(instance.answerField, correctValue, root)) {
      hints.push({ type: "root", label: "Root", value: root, isArabic: true });
    }
  }

  // Letter count is only informative for word answers, and a three-radical
  // root's count is always three — no information, so no hint.
  if (
    isWordAnswerField(instance.answerField) &&
    instance.answerField !== "root"
  ) {
    const letters = letterCountOf(targetWord);
    if (letters > 0) {
      hints.push({
        type: "word_length",
        label: "Word length",
        value: `${letters} letters`,
        isArabic: false,
      });
    }
  }

  if (instance.answerField !== "bab" && isFieldEligible(entry, "bab")) {
    const bab = fieldValue(entry, "bab");
    if (!hintRevealsAnswer(instance.answerField, correctValue, bab)) {
      hints.push({ type: "bab", label: "Bāb", value: bab, isArabic: true });
    }
  }

  // No "another form" hint on a bāb question: the shown prompt form plus a
  // second form of the same entry effectively spell out the bāb pair being
  // asked for (māḍī + muḍāriʿ IS the answer's pattern pair).
  if (instance.answerField !== "bab") {
    const formField = anotherFormFor(entry, instance, correctValue);
    if (formField !== null) {
      hints.push({
        type: "form",
        label: "Another form",
        value: fieldValue(entry, formField),
        isArabic: true,
      });
    }
  }

  return hints;
}

/** The offerable hint of one type, or null when unavailable/unsafe. */
export function hintOfType(
  context: QuestionContext,
  instance: QuestionInstance,
  type: HintType,
): HintContent | null {
  return (
    availableHints(context, instance).find((hint) => hint.type === type) ?? null
  );
}
