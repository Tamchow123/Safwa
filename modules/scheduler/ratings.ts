/**
 * FSRS rating mapping (PRODUCT_REQUIREMENTS.md §5). Derived from a Phase-6
 * attempt's mode + objective outcome + hint usage:
 *
 *   MC/test/timed:  correct & unhinted → Good; correct & hinted → Hard;
 *                   incorrect (hinted or not) → Again.
 *   flashcard:      "I know" (correct) → Good; "I don't know" (incorrect) →
 *                   Again — a self-graded card carries no objective hint credit,
 *                   so a flashcard is NEVER downgraded to Hard.
 *
 * `Easy` is not currently produced (§5).
 *
 * Pure TypeScript: no React, DOM or DB imports.
 */
import type { SchedulerRating } from "@/modules/scheduler/fsrs";

/** Attempt delivery modes (mirrors DATA_MODEL.md §5 / study-engine). */
export type AttemptMode = "flashcard" | "mc" | "test" | "timed";

/** The minimal attempt facts the rating depends on. */
export type RatableAttempt = {
  mode: AttemptMode;
  isCorrect: boolean;
  hintUsed: boolean;
};

/** Map a scheduling-relevant attempt to its FSRS rating. */
export function ratingForAttempt(attempt: RatableAttempt): SchedulerRating {
  if (!attempt.isCorrect) return "again";
  // Flashcards are self-graded: "I know" is always Good (hints do not apply /
  // never downgrade a flashcard to Hard).
  if (attempt.mode === "flashcard") return "good";
  return attempt.hintUsed ? "hard" : "good";
}
