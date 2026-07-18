/**
 * Shared correctness logic. On the client this produces the optimistic result
 * for instant feedback; in Phase 16 the server runs the SAME comparison
 * authoritatively, resolving answer references through the assessment manifest
 * (docs/ARCHITECTURE.md §2 — client `is_correct` is never trusted for
 * objective attempts).
 *
 * An objective answer is correct iff the resolved value of the selected
 * reference equals the resolved value of the correct reference under the
 * approved field-aware Arabic comparison policy (NFC + invisible stripping +
 * trim only, ḥarakāt/shaddah/hamzah preserved; maṣdar compared as its
 * order-independent " / " alternative set — CLAUDE.md hard rule 4). Flashcards
 * are self-assessed and are validated structurally, never by value comparison.
 *
 * Pure TypeScript: no React, DOM or DB imports.
 */
import type { AnswerReference } from "@/modules/content/answer-reference";
import type { LearnerEntry } from "@/modules/content/schema";

import { answerValuesEqual, fieldValue } from "@/modules/study-engine/fields";
import type { QuestionInstance } from "@/modules/study-engine/generator";

/** Resolves an answer reference to its canonical value. */
export type AnswerResolver = (ref: AnswerReference) => string;

export class AnswerResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnswerResolutionError";
  }
}

export class InvalidSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSelectionError";
  }
}

/**
 * Build a resolver from the loaded learner entries (client-side optimistic
 * path). The server's resolver reads the assessment manifest instead, but the
 * comparison below is identical.
 */
export function createEntryAnswerResolver(
  entriesById: ReadonlyMap<number, LearnerEntry>,
): AnswerResolver {
  return (ref) => {
    const entry = entriesById.get(ref.entryId);
    if (!entry) {
      throw new AnswerResolutionError(
        `no entry ${ref.entryId} in the loaded release`,
      );
    }
    return fieldValue(entry, ref.field);
  };
}

/**
 * Are two answer references equal after resolution and field-aware Arabic
 * comparison? The two refs must denote the same field (both are the question's
 * answer field); maṣdar comparison is alternative-set aware (hard rule 4).
 */
export function referencesResolveEqual(
  a: AnswerReference,
  b: AnswerReference,
  resolve: AnswerResolver,
): boolean {
  if (a.field !== b.field) return false;
  return answerValuesEqual(a.field, resolve(a), resolve(b));
}

function refsShallowEqual(a: AnswerReference, b: AnswerReference): boolean {
  return a.entryId === b.entryId && a.field === b.field;
}

export type ObjectiveCorrectness = {
  isCorrect: boolean;
  selectedAnswerRef: AnswerReference;
  correctAnswerRef: AnswerReference;
};

/**
 * Derive correctness for an objective (MC) question. The selection MUST be one
 * of the question's allowed answer references — a selection outside the
 * presented option set is a tampering/robustness error, not a wrong answer.
 * Correctness is by resolved-value comparison, so two references that resolve
 * to the same canonical value (e.g. distinct entries sharing a bāb) are both
 * correct — exactly what the server derives.
 */
export function deriveObjectiveCorrectness(
  instance: QuestionInstance,
  selectedAnswerRef: AnswerReference,
  resolve: AnswerResolver,
): ObjectiveCorrectness {
  if (instance.mode !== "mc") {
    throw new InvalidSelectionError(
      "objective correctness applies only to multiple-choice questions",
    );
  }
  const allowed = instance.allowedAnswerRefs.some((ref) =>
    refsShallowEqual(ref, selectedAnswerRef),
  );
  if (!allowed) {
    throw new InvalidSelectionError(
      "selected answer reference is not among the question's options",
    );
  }
  return {
    isCorrect: referencesResolveEqual(
      selectedAnswerRef,
      instance.correctAnswerRef,
      resolve,
    ),
    selectedAnswerRef,
    correctAnswerRef: instance.correctAnswerRef,
  };
}

export type FlashcardSelfGrade = "know" | "dont_know";

/**
 * Flashcard "correctness" is the learner's self-assessment. "I know" is a
 * clean success; "I don't know" is not. (Phase 7 maps these to Good/Again.)
 */
export function flashcardSelfGradeIsCorrect(
  grade: FlashcardSelfGrade,
): boolean {
  return grade === "know";
}
