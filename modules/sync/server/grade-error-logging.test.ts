import { describe, expect, it, vi } from "vitest";

// Force the barrel `generateQuestion` that grade.ts uses to throw an
// UNEXPECTED error (not a QuestionGenerationError) so we can assert the
// unexpected-error logging path (REL-001). QuestionGenerationError is preserved
// from the real module so the `instanceof` narrowing still works.
vi.mock("@/modules/study-engine", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/modules/study-engine")>();
  return {
    ...actual,
    generateQuestion: () => {
      throw new TypeError("unexpected internal reconstruction failure");
    },
  };
});

import type { QuestionContext } from "@/modules/study-engine/generator";

import { gradeObjectiveAttempt, type ObjectiveAttemptFields } from "./grade";

const context = {
  releaseId: "safwa-test",
  contentVersion: "2.2.0",
  questionGeneratorVersion: "1",
  entries: [],
  entriesById: new Map(),
} as unknown as QuestionContext;

const attempt: ObjectiveAttemptFields = {
  identity: {
    entryId: 1,
    skillType: "meaning_recognition",
    componentShape: "form_direction",
    sourceField: "madi",
    direction: "arabic_to_english",
  },
  mode: "mc",
  questionSeed: "s",
  questionPosition: 0,
  optionCount: 4,
  promptField: "madi",
  questionInstanceId: "x",
  questionGeneratorVersion: "1",
  selectedAnswerRef: null,
  hintUsed: false,
  claimedIsCorrect: false,
};

describe("gradeObjectiveAttempt unexpected-error logging (REL-001)", () => {
  it("logs an unexpected reconstruction error and still returns question_mismatch", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = gradeObjectiveAttempt(context, attempt);
    expect(result).toEqual({ ok: false, reasonCode: "question_mismatch" });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
