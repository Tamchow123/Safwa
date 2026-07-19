/**
 * Cross-consumer weakness contract (Phase 13 §22): Weak Areas
 * (`ComponentWeakness.qualifiesAsWeak`), the mixed-revision weak tier
 * (`modules/scheduler/due.ts`'s `isWeakEvidence`, exercised through
 * `buildMixedSession`) and the Custom Session `weak` state filter
 * (`modules/study-session/custom.ts`'s `componentStateClasses`) must never
 * disagree on which components are weak under one snapshot and time.
 *
 * All three read the SAME number: `qualifyingWeaknessScore(cw)` — this test
 * proves that number is >0 if and only if `cw.qualifiesAsWeak`, and that
 * both scheduling consumers classify a component as weak if and only if
 * that same condition holds, for every representative reachable state.
 *
 * Scoped to states genuinely reachable via the real write path: every
 * scheduling-relevant graded attempt materialises its FSRS card and stored
 * learner-state projection together (`modules/study-session/persistence.ts`
 * `recordGradedAttempt`), so a component with attempt/lapse evidence always
 * has a matching card — this test constructs `stored`/`card` fixtures that
 * are mutually consistent with each scenario's `effectiveState` through the
 * SAME shared `effectiveLearnerState` helper Custom Session uses, never a
 * hand-typed label that could quietly diverge from it.
 */
import { describe, expect, it } from "vitest";

import { componentStateClasses } from "@/modules/study-session/custom";
import type { StoredComponentState } from "@/modules/study-session/mixed";
import {
  buildMixedSession,
  type SchedulableItem,
} from "@/modules/scheduler/due";
import {
  newCard,
  reviewCard,
  type SchedulerCard,
} from "@/modules/scheduler/fsrs";
import { effectiveLearnerState } from "@/modules/scheduler/states";
import {
  computeComponentWeakness,
  qualifyingWeaknessScore,
} from "@/modules/analytics/weakness";
import type {
  WeaknessAttemptEvidence,
  WeaknessComponentEvidence,
} from "@/modules/analytics/weakness-evidence";

const NOW = 1_784_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
let counter = 0;

function firstAttempt(
  overrides: Partial<WeaknessAttemptEvidence> = {},
): WeaknessAttemptEvidence {
  counter += 1;
  return {
    attemptId: `attempt-${counter}`,
    componentKey: "k",
    entryId: 1,
    skillType: "meaning_recognition",
    direction: "arabic_to_english",
    analysisForm: "madi",
    isCorrect: false,
    occurredAtMs: NOW,
    ...overrides,
  };
}

function evidence(
  overrides: Partial<WeaknessComponentEvidence> = {},
): WeaknessComponentEvidence {
  return {
    componentKey: "k",
    entryId: 1,
    skillType: "meaning_recognition",
    direction: "arabic_to_english",
    sourceField: "madi",
    effectiveState: "learning",
    fsrsLapses: 0,
    firstAttempts: [],
    ...overrides,
  };
}

/** A future-due, non-relearning card — usable for "learning"/"mastered". */
function cardNotDue(): SchedulerCard {
  return {
    ...reviewCard(newCard(NOW - DAY_MS), NOW - DAY_MS, "good"),
    dueAtMs: NOW + DAY_MS,
  };
}

/** A due (past-due) card, not relearning. */
function cardDue(): SchedulerCard {
  return {
    ...reviewCard(newCard(NOW - DAY_MS), NOW - DAY_MS, "good"),
    dueAtMs: NOW - 1000,
  };
}

/** A relearning (lapsed, not necessarily due) card. */
function cardRelearning(): SchedulerCard {
  return { ...cardNotDue(), state: "relearning" };
}

type Scenario = {
  name: string;
  evidence: WeaknessComponentEvidence;
  storedLearnerState: StoredComponentState["learnerState"];
  card: SchedulerCard;
  expectWeak: boolean;
};

const SCENARIOS: Scenario[] = [
  {
    name: "genuinely weak: learning, two recent incorrect first attempts",
    evidence: evidence({
      effectiveState: "learning",
      firstAttempts: [
        firstAttempt({ isCorrect: false, occurredAtMs: NOW }),
        firstAttempt({ isCorrect: false, occurredAtMs: NOW - DAY_MS }),
      ],
    }),
    storedLearnerState: "learning",
    card: cardNotDue(),
    expectWeak: true,
  },
  {
    name: "strong: learning, all-correct recent history",
    evidence: evidence({
      effectiveState: "learning",
      firstAttempts: [
        firstAttempt({ isCorrect: true, occurredAtMs: NOW }),
        firstAttempt({ isCorrect: true, occurredAtMs: NOW - DAY_MS }),
      ],
    }),
    storedLearnerState: "learning",
    card: cardNotDue(),
    expectWeak: false,
  },
  {
    name: "mastered with an old lapse: never weak (mastered excludes it)",
    evidence: evidence({ effectiveState: "mastered", fsrsLapses: 5 }),
    storedLearnerState: "mastered",
    card: cardNotDue(),
    expectWeak: false,
  },
  {
    name: "untouched: no evidence at all, never weak",
    evidence: evidence({ effectiveState: "learning" }),
    storedLearnerState: "learning",
    card: cardNotDue(),
    expectWeak: false,
  },
  {
    name: "needs_review via genuine relearning lapse: weak",
    // A real lapse-triggering write updates the STORED projection to
    // needs_review in the SAME transaction (modules/study-session/
    // persistence.ts), so — unlike the stale-mastered-due case below — the
    // raw stored value is already "needs_review" here, not "mastered".
    evidence: evidence({
      effectiveState: "needs_review",
      fsrsLapses: 3,
      firstAttempts: [firstAttempt({ isCorrect: false, occurredAtMs: NOW })],
    }),
    storedLearnerState: "needs_review",
    card: cardRelearning(),
    expectWeak: true,
  },
  {
    name: "needs_review via ordinary due-again mastery, no failure evidence: NOT weak",
    // No new event has been written since mastery — the raw stored value
    // stays "mastered" and only the CLOCK makes it effectively due/needs_review
    // (modules/study-session/mixed.ts's documented raw-state invariant (b):
    // the due tier itself, not the state field, is what would surface a
    // stale-mastered-due card — never the weak tier without real evidence).
    evidence: evidence({ effectiveState: "needs_review" }),
    storedLearnerState: "mastered",
    card: cardDue(),
    expectWeak: false,
  },
];

describe("weakness cross-consumer contract (§22)", () => {
  it.each(SCENARIOS)(
    "$name",
    ({ evidence: ev, storedLearnerState, card, expectWeak }) => {
      // Sanity: the fixture's stored state + card genuinely produce the
      // scenario's declared effectiveState through the SAME shared helper
      // Custom Session uses — never a hand-typed label that could diverge.
      expect(effectiveLearnerState(storedLearnerState, card, NOW)).toBe(
        ev.effectiveState,
      );

      const cw = computeComponentWeakness(ev, NOW);
      const score = qualifyingWeaknessScore(cw);

      // 1. Weak Areas' own qualification flag agrees with the adapted score.
      expect(cw.qualifiesAsWeak).toBe(expectWeak);
      expect(score > 0).toBe(expectWeak);

      // 2. Custom Session's weak filter, fed the SAME score.
      const stored: StoredComponentState = {
        componentKey: ev.componentKey,
        fsrs: card,
        learnerState: storedLearnerState,
      };
      const classes = componentStateClasses(stored, score, NOW);
      expect(classes.includes("weak")).toBe(expectWeak);

      // 3. Mixed revision's weak tier, fed the SAME score, for a NON-DUE
      // card (isolating the weak-tier decision from the due tier, which
      // would otherwise always win regardless of weakness).
      const item: SchedulableItem = {
        componentKey: ev.componentKey,
        card: cardNotDue(),
        state: storedLearnerState ?? "not_started",
        weakScore: score,
      };
      const session = buildMixedSession([item], NOW, {
        newLimit: 0,
        reviewLimit: 10,
      });
      expect(session.includes(ev.componentKey)).toBe(expectWeak);
    },
  );

  it("agrees across every scenario simultaneously (no cross-consumer disagreement)", () => {
    for (const scenario of SCENARIOS) {
      const cw = computeComponentWeakness(scenario.evidence, NOW);
      const score = qualifyingWeaknessScore(cw);
      const stored: StoredComponentState = {
        componentKey: scenario.evidence.componentKey,
        fsrs: scenario.card,
        learnerState: scenario.storedLearnerState,
      };
      const customWeak = componentStateClasses(stored, score, NOW).includes(
        "weak",
      );
      const item: SchedulableItem = {
        componentKey: scenario.evidence.componentKey,
        card: cardNotDue(),
        state: scenario.storedLearnerState ?? "not_started",
        weakScore: score,
      };
      const mixedWeak = buildMixedSession([item], NOW, {
        newLimit: 0,
        reviewLimit: 10,
      }).includes(scenario.evidence.componentKey);

      // A component must not be weak in Custom Session but strong in Weak
      // Areas, or missing from mixed revision, or vice versa.
      expect(customWeak).toBe(cw.qualifiesAsWeak);
      expect(mixedWeak).toBe(cw.qualifiesAsWeak);
    }
  });
});
