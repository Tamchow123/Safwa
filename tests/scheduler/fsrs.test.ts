import { describe, expect, it } from "vitest";
import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating,
  type Grade,
} from "ts-fsrs";

import {
  isDue,
  isReviewState,
  newCard,
  reviewCard,
  type SchedulerCard,
} from "@/modules/scheduler/fsrs";

const T0 = Date.UTC(2026, 6, 17, 9, 0, 0);

describe("ts-fsrs integration", () => {
  it("creates a brand-new card in the New state, due at now", () => {
    const card = newCard(T0);
    expect(card.state).toBe("new");
    expect(card.reps).toBe(0);
    expect(card.lapses).toBe(0);
    expect(card.lastReviewAtMs).toBeNull();
    expect(card.dueAtMs).toBe(T0);
  });

  it("applies a rating deterministically (same inputs ⇒ same card)", () => {
    const base = newCard(T0);
    const a = reviewCard(base, T0, "good");
    const b = reviewCard(base, T0, "good");
    expect(a).toEqual(b);
    expect(a.reps).toBe(1);
    expect(a.lastReviewAtMs).toBe(T0);
    expect(a.dueAtMs).toBeGreaterThan(T0); // scheduled into the future
  });

  it("matches raw ts-fsrs bit-for-bit through the Review-state algorithm", () => {
    // Golden reference: drive RAW ts-fsrs and our wrapper in lockstep through
    // New → Learning → Review, then apply due Review-state Good, Hard and Again
    // (the core spaced-review path where elapsed time, retrievability, stability
    // and lapses matter). Assert EVERY stored field after each step.
    const STATE: Record<number, string> = {
      0: "new",
      1: "learning",
      2: "review",
      3: "relearning",
    };
    const f = fsrs(generatorParameters({ enable_fuzz: false }));
    let ref = createEmptyCard(new Date(T0));
    let ours: SchedulerCard = newCard(T0);

    const assertEqual = () =>
      expect(ours).toEqual({
        stability: ref.stability,
        difficulty: ref.difficulty,
        dueAtMs: ref.due.getTime(),
        state: STATE[ref.state],
        reps: ref.reps,
        lapses: ref.lapses,
        scheduledDays: ref.scheduled_days,
        learningSteps: ref.learning_steps,
        lastReviewAtMs: ref.last_review ? ref.last_review.getTime() : null,
      });

    const step = (rating: "good" | "hard" | "again", grade: Grade) => {
      const now = ref.due.getTime(); // a genuine due review
      ref = f.next(ref, new Date(now), grade).card;
      ours = reviewCard(ours, now, rating);
      assertEqual();
    };

    // Progress to the Review state.
    let guard = 0;
    while (STATE[ref.state] !== "review" && guard++ < 10) {
      step("good", Rating.Good);
    }
    expect(STATE[ref.state]).toBe("review");

    // Due Review-state ratings.
    step("good", Rating.Good);
    step("hard", Rating.Hard);
    step("again", Rating.Again); // lapse from Review
    expect(ours.lapses).toBeGreaterThanOrEqual(1);
  });

  it("Again increases lapses once the card is past learning", () => {
    let card = newCard(T0);
    card = reviewCard(card, T0, "good"); // new → learning
    card = reviewCard(card, card.dueAtMs, "good"); // → review
    expect(isReviewState(card)).toBe(true);
    const before = card.lapses;
    card = reviewCard(card, card.dueAtMs, "again"); // lapse
    expect(card.lapses).toBe(before + 1);
  });

  it("isDue reflects the card's due instant", () => {
    let card = newCard(T0);
    card = reviewCard(card, T0, "good");
    expect(isDue(card, card.dueAtMs - 1)).toBe(false);
    expect(isDue(card, card.dueAtMs)).toBe(true);
    expect(isDue(card, card.dueAtMs + 1)).toBe(true);
  });
});
