import { describe, expect, it } from "vitest";

import {
  ratingForAttempt,
  type AttemptMode,
} from "@/modules/scheduler/ratings";

describe("FSRS rating mapping (PRODUCT_REQUIREMENTS §5)", () => {
  it.each([
    { mode: "mc", isCorrect: true, hintUsed: false, expected: "good" },
    { mode: "mc", isCorrect: true, hintUsed: true, expected: "hard" }, // hinted-correct
    { mode: "mc", isCorrect: false, hintUsed: false, expected: "again" },
    { mode: "mc", isCorrect: false, hintUsed: true, expected: "again" }, // hinted-incorrect
    // test & timed modes map identically to mc (objective + hint based).
    { mode: "test", isCorrect: true, hintUsed: false, expected: "good" },
    { mode: "test", isCorrect: true, hintUsed: true, expected: "hard" },
    { mode: "test", isCorrect: false, hintUsed: false, expected: "again" },
    { mode: "timed", isCorrect: true, hintUsed: false, expected: "good" },
    { mode: "timed", isCorrect: true, hintUsed: true, expected: "hard" },
    { mode: "timed", isCorrect: false, hintUsed: false, expected: "again" },
    // Flashcards are self-graded: "I know" is always Good, never downgraded to
    // Hard by a (spurious) hint; "I don't know" is Again.
    { mode: "flashcard", isCorrect: true, hintUsed: false, expected: "good" },
    { mode: "flashcard", isCorrect: true, hintUsed: true, expected: "good" },
    { mode: "flashcard", isCorrect: false, hintUsed: false, expected: "again" },
  ] as {
    mode: AttemptMode;
    isCorrect: boolean;
    hintUsed: boolean;
    expected: string;
  }[])(
    "$mode correct=$isCorrect hinted=$hintUsed → $expected",
    ({ mode, isCorrect, hintUsed, expected }) => {
      expect(ratingForAttempt({ mode, isCorrect, hintUsed })).toBe(expected);
    },
  );

  it("never produces Easy", () => {
    const modes: AttemptMode[] = ["mc", "test", "timed", "flashcard"];
    const ratings = new Set(
      modes.flatMap((mode) =>
        [true, false].flatMap((isCorrect) =>
          [true, false].map((hintUsed) =>
            ratingForAttempt({ mode, isCorrect, hintUsed }),
          ),
        ),
      ),
    );
    expect(ratings.has("easy")).toBe(false);
  });
});
