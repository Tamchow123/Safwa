import { describe, expect, it } from "vitest";

import {
  createEntryAnswerResolver,
  deriveObjectiveCorrectness,
  flashcardSelfGradeIsCorrect,
  InvalidSelectionError,
  referencesResolveEqual,
} from "@/modules/study-engine/correctness";
import { generateQuestion } from "@/modules/study-engine/generator";

import { entriesById, questionContext } from "./fixtures";

const resolver = createEntryAnswerResolver(entriesById);

function babQuestion(entryId: number) {
  return generateQuestion(questionContext, {
    identity: { entryId, skillType: "bab_identification" },
    deliveryMode: "mc",
    questionSeed: "corr",
    position: 0,
  });
}

describe("objective correctness", () => {
  it("marks the correct option correct and a distractor incorrect", () => {
    const question = babQuestion(1);
    const correct = question.options.find((o) => o.isCorrect)!;
    const wrong = question.options.find((o) => !o.isCorrect)!;

    expect(
      deriveObjectiveCorrectness(question, correct.ref, resolver).isCorrect,
    ).toBe(true);
    expect(
      deriveObjectiveCorrectness(question, wrong.ref, resolver).isCorrect,
    ).toBe(false);
  });

  it("treats an answer resolving to the same value as correct", () => {
    // Two distinct entries sharing a bāb resolve to the same bab_arabic; a ref
    // to either is correct — exactly what the server derives.
    const question = babQuestion(1);
    const correctValue = resolver(question.correctAnswerRef);
    const sameBabOption = question.options.find(
      (o) => resolver(o.ref) === correctValue,
    )!;
    expect(
      deriveObjectiveCorrectness(question, sameBabOption.ref, resolver)
        .isCorrect,
    ).toBe(true);
  });

  it("rejects a selection outside the presented option set", () => {
    const question = babQuestion(1);
    expect(() =>
      deriveObjectiveCorrectness(
        question,
        { entryId: 9999, field: "bab" },
        resolver,
      ),
    ).toThrow(InvalidSelectionError);
  });

  it("refuses to grade a flashcard as objective", () => {
    const flashcard = generateQuestion(questionContext, {
      identity: {
        entryId: 1,
        skillType: "meaning_recognition",
        sourceField: "madi",
        direction: "arabic_to_english",
      },
      deliveryMode: "flashcard",
      questionSeed: "corr",
      position: 0,
    });
    expect(() =>
      deriveObjectiveCorrectness(
        flashcard,
        flashcard.correctAnswerRef,
        resolver,
      ),
    ).toThrow(InvalidSelectionError);
  });

  it("referencesResolveEqual uses the Arabic comparison policy", () => {
    expect(
      referencesResolveEqual(
        { entryId: 1, field: "madi" },
        { entryId: 1, field: "madi" },
        resolver,
      ),
    ).toBe(true);
    expect(
      referencesResolveEqual(
        { entryId: 1, field: "madi" },
        { entryId: 2, field: "madi" },
        resolver,
      ),
    ).toBe(false);
  });

  it("flashcard self-grade maps know→correct, dont_know→incorrect", () => {
    expect(flashcardSelfGradeIsCorrect("know")).toBe(true);
    expect(flashcardSelfGradeIsCorrect("dont_know")).toBe(false);
  });
});
