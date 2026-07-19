/**
 * Weakness heuristic v2 (Phase 13 §10, §24): recency-decayed accuracy,
 * FSRS lapse signal, recent-failure signal, composite scoring, and
 * mastered/due/untouched qualification rules.
 */
import { describe, expect, it } from "vitest";

import {
  ACCURACY_HALF_LIFE_DAYS,
  LAPSE_SATURATION,
  RECENT_FIRST_ATTEMPT_WINDOW,
  WEAK_THRESHOLD,
  computeComponentWeakness,
} from "@/modules/analytics/weakness";
import type {
  WeaknessAttemptEvidence,
  WeaknessComponentEvidence,
} from "@/modules/analytics/weakness-evidence";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_784_000_000_000;

let counter = 0;

function firstAttempt(
  overrides: Partial<WeaknessAttemptEvidence> = {},
): WeaknessAttemptEvidence {
  counter += 1;
  return {
    attemptId: `attempt-${counter}`,
    componentKey: "entry:1:skill:bab_identification",
    entryId: 1,
    skillType: "bab_identification",
    direction: null,
    analysisForm: "madi",
    isCorrect: true,
    occurredAtMs: NOW,
    ...overrides,
  };
}

function evidence(
  overrides: Partial<WeaknessComponentEvidence> = {},
): WeaknessComponentEvidence {
  return {
    componentKey: "entry:1:skill:bab_identification",
    entryId: 1,
    skillType: "bab_identification",
    direction: null,
    sourceField: null,
    effectiveState: "learning",
    fsrsLapses: 0,
    firstAttempts: [],
    ...overrides,
  };
}

function daysAgo(days: number): number {
  return NOW - days * DAY_MS;
}

describe("computeComponentWeakness — baseline (§24.1, §24.22)", () => {
  it("1. no attempts and no lapses -> score zero", () => {
    const result = computeComponentWeakness(evidence(), NOW);
    expect(result.score).toBe(0);
    expect(result.qualifiesAsWeak).toBe(false);
  });

  it("22. untouched new component is not weak", () => {
    const result = computeComponentWeakness(
      evidence({ effectiveState: "not_started" }),
      NOW,
    );
    expect(result.qualifiesAsWeak).toBe(false);
  });

  it("2. all-correct attempts -> not weak", () => {
    const e = evidence({
      firstAttempts: [
        firstAttempt({ isCorrect: true, occurredAtMs: daysAgo(1) }),
        firstAttempt({ isCorrect: true, occurredAtMs: daysAgo(2) }),
        firstAttempt({ isCorrect: true, occurredAtMs: daysAgo(3) }),
      ],
    });
    const result = computeComponentWeakness(e, NOW);
    expect(result.score).toBe(0);
    expect(result.qualifiesAsWeak).toBe(false);
  });
});

describe("computeComponentWeakness — accuracy signal (§24.3, §24.4, §24.5)", () => {
  it("3. one recent incorrect first attempt creates weakness", () => {
    const e = evidence({
      firstAttempts: [firstAttempt({ isCorrect: false, occurredAtMs: NOW })],
    });
    const result = computeComponentWeakness(e, NOW);
    expect(result.score).toBeGreaterThan(WEAK_THRESHOLD);
    expect(result.qualifiesAsWeak).toBe(true);
  });

  it("4. a reinforcement recovery does not erase the earlier incorrect first attempt's weakness", () => {
    // Reinforcement attempts never reach WeaknessComponentEvidence (excluded
    // by modules/analytics/weakness-evidence.ts §8) — evidence here reflects
    // exactly what survives that filter: the incorrect first attempt alone.
    const e = evidence({
      firstAttempts: [firstAttempt({ isCorrect: false, occurredAtMs: NOW })],
    });
    const result = computeComponentWeakness(e, NOW);
    expect(result.qualifiesAsWeak).toBe(true);
    expect(result.incorrectFirstAttemptCount).toBe(1);
  });

  it("5. later correct first attempts reduce the score", () => {
    const isolatedIncorrect = evidence({
      firstAttempts: [firstAttempt({ isCorrect: false, occurredAtMs: NOW })],
    });
    const dilutedByCorrect = evidence({
      firstAttempts: [
        firstAttempt({ isCorrect: false, occurredAtMs: NOW }),
        ...Array.from({ length: 9 }, () =>
          firstAttempt({ isCorrect: true, occurredAtMs: NOW }),
        ),
      ],
    });
    const isolatedScore = computeComponentWeakness(
      isolatedIncorrect,
      NOW,
    ).score;
    const dilutedScore = computeComponentWeakness(dilutedByCorrect, NOW).score;
    expect(dilutedScore).toBeLessThan(isolatedScore);
  });
});

describe("computeComponentWeakness — recency (§24.6, §24.7)", () => {
  it("6. a recent failure weighs more than an equivalent old failure", () => {
    const recent = evidence({
      firstAttempts: [
        firstAttempt({ isCorrect: false, occurredAtMs: daysAgo(0) }),
      ],
    });
    const old = evidence({
      firstAttempts: [
        firstAttempt({ isCorrect: false, occurredAtMs: daysAgo(60) }),
      ],
    });
    const recentScore = computeComponentWeakness(recent, NOW).score;
    const oldScore = computeComponentWeakness(old, NOW).score;
    expect(recentScore).toBeGreaterThan(oldScore);
  });

  it("7. an ancient isolated failure decays below the threshold", () => {
    const ancient = evidence({
      firstAttempts: [
        firstAttempt({
          isCorrect: false,
          occurredAtMs: daysAgo(ACCURACY_HALF_LIFE_DAYS * 12),
        }),
      ],
    });
    const result = computeComponentWeakness(ancient, NOW);
    expect(result.score).toBeLessThan(WEAK_THRESHOLD);
    expect(result.qualifiesAsWeak).toBe(false);
  });
});

describe("computeComponentWeakness — lapses (§24.8, §24.9, §24.10)", () => {
  it("8. lapses increase the score", () => {
    const oneLapse = computeComponentWeakness(evidence({ fsrsLapses: 1 }), NOW);
    const twoLapses = computeComponentWeakness(
      evidence({ fsrsLapses: 2 }),
      NOW,
    );
    expect(twoLapses.score).toBeGreaterThan(oneLapse.score);
    expect(oneLapse.qualifiesAsWeak).toBe(false); // below threshold alone
  });

  it("9. lapse saturation caps safely", () => {
    const atSaturation = computeComponentWeakness(
      evidence({ fsrsLapses: LAPSE_SATURATION }),
      NOW,
    );
    const beyondSaturation = computeComponentWeakness(
      evidence({ fsrsLapses: LAPSE_SATURATION * 5 }),
      NOW,
    );
    expect(atSaturation.lapseSignal).toBe(1);
    expect(beyondSaturation.lapseSignal).toBe(1);
    expect(beyondSaturation.score).toBe(atSaturation.score);
  });

  it("10. invalid negative lapses fail safely to zero", () => {
    const result = computeComponentWeakness(evidence({ fsrsLapses: -5 }), NOW);
    expect(result.lapseSignal).toBe(0);
    expect(result.lapses).toBe(0);
    expect(result.qualifiesAsWeak).toBe(false);
  });
});

describe("computeComponentWeakness — determinism and safety (§24.11–§24.15)", () => {
  it("11. score remains finite and clamped for extreme inputs", () => {
    const extreme = evidence({
      fsrsLapses: Number.MAX_SAFE_INTEGER,
      firstAttempts: Array.from({ length: 50 }, (_, i) =>
        firstAttempt({ isCorrect: false, occurredAtMs: NOW - i * DAY_MS }),
      ),
    });
    const result = computeComponentWeakness(extreme, NOW);
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it("12. same inputs produce identical output", () => {
    const e = evidence({
      fsrsLapses: 2,
      firstAttempts: [
        firstAttempt({ isCorrect: false, occurredAtMs: daysAgo(1) }),
        firstAttempt({ isCorrect: true, occurredAtMs: daysAgo(5) }),
      ],
    });
    const first = computeComponentWeakness(e, NOW);
    const second = computeComponentWeakness(e, NOW);
    expect(second).toEqual(first);
  });

  it("13. attempt input order does not change output", () => {
    const attempts = [
      firstAttempt({ isCorrect: false, occurredAtMs: daysAgo(1) }),
      firstAttempt({ isCorrect: true, occurredAtMs: daysAgo(5) }),
      firstAttempt({ isCorrect: false, occurredAtMs: daysAgo(3) }),
    ];
    const forward = computeComponentWeakness(
      evidence({ firstAttempts: attempts }),
      NOW,
    );
    const reversed = computeComponentWeakness(
      evidence({ firstAttempts: [...attempts].reverse() }),
      NOW,
    );
    expect(reversed).toEqual(forward);
  });

  it("14. equal timestamps use stable attempt-id ordering", () => {
    const a = firstAttempt({
      attemptId: "attempt-aaa",
      isCorrect: false,
      occurredAtMs: NOW,
    });
    const b = firstAttempt({
      attemptId: "attempt-bbb",
      isCorrect: true,
      occurredAtMs: NOW,
    });
    const order1 = computeComponentWeakness(
      evidence({ firstAttempts: [a, b] }),
      NOW,
    );
    const order2 = computeComponentWeakness(
      evidence({ firstAttempts: [b, a] }),
      NOW,
    );
    expect(order2).toEqual(order1);
    // Deterministic tie-break: higher attemptId sorts first (descending).
    expect(order1.lastAttemptAtMs).toBe(NOW);
  });

  it("15. a future timestamp is deterministically clamped to age zero", () => {
    const future = evidence({
      firstAttempts: [
        firstAttempt({ isCorrect: false, occurredAtMs: NOW + 10 * DAY_MS }),
      ],
    });
    const atNow = evidence({
      firstAttempts: [firstAttempt({ isCorrect: false, occurredAtMs: NOW })],
    });
    // The weight/score math clamps a future instant's AGE to zero (same
    // decay as an attempt occurring exactly now); the raw recorded instant
    // itself is still reported honestly in lastAttemptAtMs/lastIncorrectAtMs.
    const futureResult = computeComponentWeakness(future, NOW);
    const atNowResult = computeComponentWeakness(atNow, NOW);
    expect(futureResult.score).toBe(atNowResult.score);
    expect(futureResult.accuracySignal).toBe(atNowResult.accuracySignal);
    expect(futureResult.recentFailureSignal).toBe(
      atNowResult.recentFailureSignal,
    );
    // Calling it again with the same (future-dated) evidence is still
    // perfectly deterministic.
    expect(computeComponentWeakness(future, NOW)).toEqual(futureResult);
  });
});

describe("computeComponentWeakness — revoked/rejected/conflict-demoted evidence (§24.16–§24.18)", () => {
  // These exclusions happen upstream in modules/analytics/weakness-evidence.ts
  // (see tests/analytics/weakness-evidence.test.ts for the exhaustive cases);
  // here we confirm the heuristic itself only ever sees what survives that
  // filter, so a component whose only attempt was excluded scores as
  // untouched, exactly like a genuinely revoked/rejected/conflict-demoted
  // attempt would once weakness-evidence has done its job.
  it("16-18. a component with no surviving evidence (as if revoked/rejected/conflict-demoted) is not weak", () => {
    const result = computeComponentWeakness(
      evidence({ fsrsLapses: 0, firstAttempts: [] }),
      NOW,
    );
    expect(result.qualifiesAsWeak).toBe(false);
    expect(result.score).toBe(0);
  });
});

describe("computeComponentWeakness — qualification (§24.19–§24.21)", () => {
  it("19. a wrong-only not_started component can qualify", () => {
    const e = evidence({
      effectiveState: "not_started",
      firstAttempts: [firstAttempt({ isCorrect: false, occurredAtMs: NOW })],
    });
    const result = computeComponentWeakness(e, NOW);
    expect(result.qualifiesAsWeak).toBe(true);
  });

  it("20. a mastered non-due component is excluded even with an old lapse", () => {
    const e = evidence({
      effectiveState: "mastered",
      fsrsLapses: 5,
      firstAttempts: [
        firstAttempt({ isCorrect: false, occurredAtMs: daysAgo(1) }),
      ],
    });
    const result = computeComponentWeakness(e, NOW);
    expect(result.qualifiesAsWeak).toBe(false);
  });

  it("21. a due (needs_review), all-correct component is not falsely called weak", () => {
    const e = evidence({
      effectiveState: "needs_review",
      firstAttempts: [
        firstAttempt({ isCorrect: true, occurredAtMs: daysAgo(1) }),
        firstAttempt({ isCorrect: true, occurredAtMs: daysAgo(2) }),
      ],
    });
    const result = computeComponentWeakness(e, NOW);
    expect(result.qualifiesAsWeak).toBe(false);
  });
});

describe("computeComponentWeakness — recent-attempt window (§24.23)", () => {
  it("23. only the ten most recent first attempts are considered", () => {
    const recentTen = Array.from(
      { length: RECENT_FIRST_ATTEMPT_WINDOW },
      (_, i) => firstAttempt({ isCorrect: true, occurredAtMs: daysAgo(i) }),
    );
    const ancientEleventh = firstAttempt({
      isCorrect: false,
      occurredAtMs: daysAgo(9999),
    });
    const withoutEleventh = computeComponentWeakness(
      evidence({ firstAttempts: recentTen }),
      NOW,
    );
    const withEleventh = computeComponentWeakness(
      evidence({ firstAttempts: [...recentTen, ancientEleventh] }),
      NOW,
    );
    expect(withEleventh.firstAttemptCount).toBe(RECENT_FIRST_ATTEMPT_WINDOW);
    expect(withEleventh).toEqual(withoutEleventh);
  });

  it("consideredFirstAttempts exposes exactly the windowed, newest-first set the score was computed from", () => {
    const eleven = Array.from(
      { length: RECENT_FIRST_ATTEMPT_WINDOW + 1 },
      (_, i) => firstAttempt({ isCorrect: true, occurredAtMs: daysAgo(i) }),
    );
    const result = computeComponentWeakness(
      evidence({ firstAttempts: eleven }),
      NOW,
    );
    expect(result.consideredFirstAttempts).toHaveLength(
      RECENT_FIRST_ATTEMPT_WINDOW,
    );
    expect(result.consideredFirstAttempts.length).toBe(
      result.firstAttemptCount,
    );
    // Newest-first: the most recent (daysAgo(0)) attempt leads.
    expect(result.consideredFirstAttempts[0].occurredAtMs).toBe(daysAgo(0));
    // The ancient (11th) attempt is excluded from the considered set.
    const ancientMs = daysAgo(RECENT_FIRST_ATTEMPT_WINDOW);
    expect(
      result.consideredFirstAttempts.some((a) => a.occurredAtMs === ancientMs),
    ).toBe(false);
  });
});
