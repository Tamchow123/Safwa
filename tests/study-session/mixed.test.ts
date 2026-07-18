import { describe, expect, it } from "vitest";

import { DEFAULT_DAILY_TARGETS } from "@/modules/scheduler/due";
import {
  newCard,
  reviewCard,
  type SchedulerCard,
} from "@/modules/scheduler/fsrs";
import { isComponentEligible } from "@/modules/study-engine/components";
import { buildComponentKey } from "@/modules/study-engine/natural-key";
import {
  buildMixedPlan,
  computeWeakScores,
  defaultEntryPromptForm,
  remainingDailyTargets,
  WEAK_SCORE_RECENT_WINDOW,
  type SchedulingEventSummary,
  type StoredComponentState,
  type WeaknessAttempt,
} from "@/modules/study-session/mixed";

import { entriesById, entry, learnerEntries } from "../study-engine/fixtures";

const NOW = Date.UTC(2026, 6, 17, 12, 0, 0);

function cardDueAt(dueAtMs: number): SchedulerCard {
  return {
    ...reviewCard(newCard(dueAtMs - 1000), dueAtMs - 1000, "good"),
    dueAtMs,
  };
}

function attempt(
  componentKey: string,
  overrides: Partial<WeaknessAttempt> = {},
): WeaknessAttempt {
  return {
    id: overrides.id ?? `${componentKey}:${overrides.attemptedAt ?? 0}`,
    componentKey,
    isFirstAttempt: true,
    isCorrect: true,
    attemptedAt: 0,
    ...overrides,
  };
}

describe("computeWeakScores (heuristic v1: recent first-attempt accuracy)", () => {
  it("scores the fraction of recent first attempts that were incorrect", () => {
    const scores = computeWeakScores([
      attempt("c", { attemptedAt: 1, isCorrect: false, id: "a1" }),
      attempt("c", { attemptedAt: 2, isCorrect: true, id: "a2" }),
      attempt("c", { attemptedAt: 3, isCorrect: false, id: "a3" }),
      attempt("c", { attemptedAt: 4, isCorrect: true, id: "a4" }),
    ]);
    expect(scores.get("c")).toBe(0.5);
  });

  it("ignores reinforcement recoveries — they never launder weakness", () => {
    const scores = computeWeakScores([
      attempt("c", { attemptedAt: 1, isCorrect: false, id: "a1" }),
      // A same-session recovery: correct, but NOT a first attempt.
      attempt("c", {
        attemptedAt: 2,
        isCorrect: true,
        isFirstAttempt: false,
        id: "a2",
      }),
    ]);
    expect(scores.get("c")).toBe(1);
  });

  it("only the most recent window counts (old failures age out)", () => {
    const oldFailures = Array.from(
      { length: WEAK_SCORE_RECENT_WINDOW },
      (_, index) =>
        attempt("c", {
          attemptedAt: index,
          isCorrect: false,
          id: `old-${index}`,
        }),
    );
    const recentSuccesses = Array.from(
      { length: WEAK_SCORE_RECENT_WINDOW },
      (_, index) =>
        attempt("c", {
          attemptedAt: 100 + index,
          isCorrect: true,
          id: `new-${index}`,
        }),
    );
    const scores = computeWeakScores([...oldFailures, ...recentSuccesses]);
    expect(scores.get("c")).toBe(0);
  });

  it("is insensitive to input order (deterministic recency sort)", () => {
    const attempts = [
      attempt("c", { attemptedAt: 3, isCorrect: false, id: "a3" }),
      attempt("c", { attemptedAt: 1, isCorrect: true, id: "a1" }),
      attempt("c", { attemptedAt: 2, isCorrect: false, id: "a2" }),
    ];
    const forward = computeWeakScores(attempts);
    const reversed = computeWeakScores([...attempts].reverse());
    expect(forward).toEqual(reversed);
  });

  it("a component with no first attempts has no score", () => {
    const scores = computeWeakScores([
      attempt("c", { isFirstAttempt: false, isCorrect: false }),
    ]);
    expect(scores.has("c")).toBe(false);
  });
});

describe("remainingDailyTargets (per-day accounting)", () => {
  const TODAY = "2026-07-17";

  function schedulingEvent(
    overrides: Partial<SchedulingEventSummary> = {},
  ): SchedulingEventSummary {
    return {
      componentKey: "c",
      parentEventId: null,
      status: "scheduling",
      localDateAtEvent: TODAY,
      ...overrides,
    };
  }

  it("chain-root events consume the new budget; later events the review budget", () => {
    const events = [
      schedulingEvent({ componentKey: "a" }), // introduced today
      schedulingEvent({ componentKey: "b" }), // introduced today
      schedulingEvent({ componentKey: "a", parentEventId: "e1" }), // review
    ];
    expect(
      remainingDailyTargets(events, TODAY, { newLimit: 10, reviewLimit: 20 }),
    ).toEqual({ newLimit: 8, reviewLimit: 19 });
  });

  it("events from other local dates never consume today's budget", () => {
    const events = [
      schedulingEvent({ localDateAtEvent: "2026-07-16" }),
      schedulingEvent({ parentEventId: "e1", localDateAtEvent: "2026-07-16" }),
      schedulingEvent({ localDateAtEvent: null }),
    ];
    expect(remainingDailyTargets(events, TODAY)).toEqual(DEFAULT_DAILY_TARGETS);
  });

  it("non-scheduling events never consume budget", () => {
    const events = [
      schedulingEvent({ status: "reinforcement" }),
      schedulingEvent({ status: null }),
    ];
    expect(remainingDailyTargets(events, TODAY)).toEqual(DEFAULT_DAILY_TARGETS);
  });

  it("clamps at zero once a day's budget is exhausted", () => {
    const events = Array.from({ length: 15 }, (_, index) =>
      schedulingEvent({ componentKey: `c-${index}` }),
    );
    expect(
      remainingDailyTargets(events, TODAY, { newLimit: 10, reviewLimit: 20 }),
    ).toEqual({ newLimit: 0, reviewLimit: 20 });
  });

  it("an undone event (removed from the store) refunds its budget", () => {
    const before = [
      schedulingEvent({ componentKey: "a" }),
      schedulingEvent({ componentKey: "b" }),
    ];
    // Undo deletes b's event; recomputation sees one introduction only.
    const after = before.slice(0, 1);
    expect(remainingDailyTargets(after, TODAY).newLimit).toBe(
      remainingDailyTargets(before, TODAY).newLimit + 1,
    );
  });

  it("feeds buildMixedPlan: exhausted budgets yield no new items", () => {
    const events = Array.from({ length: 10 }, (_, index) =>
      schedulingEvent({ componentKey: `c-${index}` }),
    );
    const targets = remainingDailyTargets(events, TODAY);
    expect(targets.newLimit).toBe(0);
    const plan = buildMixedPlan(learnerEntries, [], new Map(), NOW, targets);
    // No stored cards → nothing due/weak, and the new budget is spent.
    expect(plan).toHaveLength(0);
  });
});

describe("defaultEntryPromptForm", () => {
  it("prefers the māḍī when eligible", () => {
    expect(defaultEntryPromptForm(entry(1))).toBe("madi");
  });

  it("is always an eligible form (or null) for every entry", () => {
    for (const candidate of learnerEntries) {
      const form = defaultEntryPromptForm(candidate);
      if (form !== null) {
        expect(candidate.quiz_eligibility[form]).toBe(true);
      }
    }
  });
});

describe("buildMixedPlan (due → weak → new, seeded fixture)", () => {
  // Real component keys from the loaded release, used as the seeded fixture.
  const babKey = (entryId: number) =>
    buildComponentKey({ entryId, skillType: "bab_identification" });
  const recognitionKey = (entryId: number) =>
    buildComponentKey({
      entryId,
      skillType: "meaning_recognition",
      sourceField: "madi",
      direction: "arabic_to_english",
    });

  it("a brand-new guest (no stored state) gets a plan of new items", () => {
    const plan = buildMixedPlan(learnerEntries, [], new Map(), NOW);
    expect(plan).toHaveLength(DEFAULT_DAILY_TARGETS.newLimit);
    for (const item of plan) {
      const source = entriesById.get(item.identity.entryId)!;
      expect(isComponentEligible(source, item.identity)).toBe(true);
    }
  });

  it("orders due before weak before new, within the given targets", () => {
    const due = recognitionKey(1);
    const weakHigh = babKey(2);
    const weakLow = recognitionKey(3);
    const stored: StoredComponentState[] = [
      {
        componentKey: due,
        fsrs: cardDueAt(NOW - 1000),
        learnerState: "learning",
      },
      {
        componentKey: weakHigh,
        fsrs: cardDueAt(NOW + 100_000),
        learnerState: "learning",
      },
      {
        componentKey: weakLow,
        fsrs: cardDueAt(NOW + 100_000),
        learnerState: "learning",
      },
    ];
    const weakScores = new Map([
      [weakHigh, 0.9],
      [weakLow, 0.4],
    ]);
    const plan = buildMixedPlan(learnerEntries, stored, weakScores, NOW, {
      newLimit: 2,
      reviewLimit: 3,
    });
    const keys = plan.map((item) => buildComponentKey(item.identity));
    // due (most overdue first) → weak (weakest first) → new (2 items).
    expect(keys.slice(0, 3)).toEqual([due, weakHigh, weakLow]);
    expect(plan).toHaveLength(5);
    // The new-tier items are never ones that already have a card.
    for (const key of keys.slice(3)) {
      expect(stored.some((record) => record.componentKey === key)).toBe(false);
    }
  });

  it("mastered non-due components are not selected as weak", () => {
    const mastered = recognitionKey(1);
    const stored: StoredComponentState[] = [
      {
        componentKey: mastered,
        fsrs: cardDueAt(NOW + 100_000),
        learnerState: "mastered",
      },
    ];
    const plan = buildMixedPlan(
      learnerEntries,
      stored,
      new Map([[mastered, 1]]),
      NOW,
      { newLimit: 0, reviewLimit: 10 },
    );
    expect(plan.map((item) => buildComponentKey(item.identity))).not.toContain(
      mastered,
    );
  });

  it("drops stored components that are no longer derivable (stale/ineligible)", () => {
    // Entry 369's root component is not derivable (root unverified) — a stored
    // card for it must never be planned.
    const stale: StoredComponentState = {
      componentKey: "entry:369:skill:root_identification",
      fsrs: cardDueAt(NOW - 1000),
      learnerState: "learning",
    };
    const plan = buildMixedPlan(learnerEntries, [stale], new Map(), NOW);
    expect(plan.map((item) => buildComponentKey(item.identity))).not.toContain(
      stale.componentKey,
    );
  });

  it("entry-level items carry an eligible prompt form; translations carry none", () => {
    const dueBab = babKey(1);
    const dueTranslation = recognitionKey(2);
    const stored: StoredComponentState[] = [
      {
        componentKey: dueBab,
        fsrs: cardDueAt(NOW - 2000),
        learnerState: "learning",
      },
      {
        componentKey: dueTranslation,
        fsrs: cardDueAt(NOW - 1000),
        learnerState: "learning",
      },
    ];
    const plan = buildMixedPlan(learnerEntries, stored, new Map(), NOW, {
      newLimit: 0,
      reviewLimit: 2,
    });
    expect(plan).toHaveLength(2);
    const [babItem, translationItem] = plan;
    expect(buildComponentKey(babItem.identity)).toBe(dueBab);
    expect(babItem.promptForm).toBe("madi");
    expect(buildComponentKey(translationItem.identity)).toBe(dueTranslation);
    expect(translationItem.promptForm).toBeUndefined();
  });

  it("weak scores from attempt history feed the ordering end-to-end", () => {
    const often = babKey(4);
    const rarely = babKey(5);
    const stored: StoredComponentState[] = [
      {
        componentKey: often,
        fsrs: cardDueAt(NOW + 100_000),
        learnerState: "learning",
      },
      {
        componentKey: rarely,
        fsrs: cardDueAt(NOW + 100_000),
        learnerState: "learning",
      },
    ];
    const weakScores = computeWeakScores([
      attempt(often, { attemptedAt: 1, isCorrect: false, id: "o1" }),
      attempt(often, { attemptedAt: 2, isCorrect: false, id: "o2" }),
      attempt(rarely, { attemptedAt: 1, isCorrect: false, id: "r1" }),
      attempt(rarely, { attemptedAt: 2, isCorrect: true, id: "r2" }),
    ]);
    const plan = buildMixedPlan(learnerEntries, stored, weakScores, NOW, {
      newLimit: 0,
      reviewLimit: 2,
    });
    expect(plan.map((item) => buildComponentKey(item.identity))).toEqual([
      often,
      rarely,
    ]);
  });

  it("caps one session at the default 20 questions, reviews making the cut first", () => {
    // A full review tier (20 due) PLUS an untouched new-item budget: the
    // session must still be 20 questions (§4.4 default), filled by the due
    // reviews — the 10 new items the daily budget would allow don't fit in
    // this sitting.
    const dueKeys = learnerEntries
      .slice(0, 20)
      .map((source) => recognitionKey(source.id));
    const stored: StoredComponentState[] = dueKeys.map(
      (componentKey, index) => ({
        componentKey,
        fsrs: cardDueAt(NOW - (index + 1) * 1000),
        learnerState: "learning",
      }),
    );
    const plan = buildMixedPlan(learnerEntries, stored, new Map(), NOW);
    expect(plan).toHaveLength(20);
    const keys = plan.map((item) => buildComponentKey(item.identity));
    expect(new Set(keys)).toEqual(new Set(dueKeys));

    // An explicit larger session limit admits the new tier again.
    const larger = buildMixedPlan(
      learnerEntries,
      stored,
      new Map(),
      NOW,
      DEFAULT_DAILY_TARGETS,
      30,
    );
    expect(larger).toHaveLength(30);
  });

  it("rejects a non-positive session limit", () => {
    expect(() =>
      buildMixedPlan(
        learnerEntries,
        [],
        new Map(),
        NOW,
        DEFAULT_DAILY_TARGETS,
        0,
      ),
    ).toThrow();
  });

  it("is deterministic in its inputs", () => {
    const stored: StoredComponentState[] = [
      {
        componentKey: recognitionKey(1),
        fsrs: cardDueAt(NOW - 1000),
        learnerState: "learning",
      },
    ];
    const a = buildMixedPlan(learnerEntries, stored, new Map(), NOW);
    const b = buildMixedPlan(learnerEntries, stored, new Map(), NOW);
    expect(a).toEqual(b);
  });
});
