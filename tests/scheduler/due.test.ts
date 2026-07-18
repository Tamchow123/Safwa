import { describe, expect, it } from "vitest";

import {
  buildMixedSession,
  DEFAULT_DAILY_TARGETS,
  selectDue,
  type SchedulableItem,
} from "@/modules/scheduler/due";
import {
  newCard,
  reviewCard,
  type SchedulerCard,
} from "@/modules/scheduler/fsrs";

const NOW = Date.UTC(2026, 6, 17, 12, 0, 0);

function cardDueAt(dueAtMs: number): SchedulerCard {
  return {
    ...reviewCard(newCard(dueAtMs - 1000), dueAtMs - 1000, "good"),
    dueAtMs,
  };
}

describe("due selection", () => {
  it("selects only cards due at or before now, most overdue first", () => {
    const items: SchedulableItem[] = [
      {
        componentKey: "c-future",
        card: cardDueAt(NOW + 1000),
        state: "learning",
      },
      {
        componentKey: "c-due-1",
        card: cardDueAt(NOW - 5000),
        state: "learning",
      },
      {
        componentKey: "c-due-2",
        card: cardDueAt(NOW - 1000),
        state: "needs_review",
      },
      { componentKey: "c-new", card: null, state: "not_started" },
    ];
    const due = selectDue(items, NOW);
    expect(due.map((i) => i.componentKey)).toEqual(["c-due-1", "c-due-2"]);
  });
});

describe("mixed session ordering (due → weak → new)", () => {
  it("orders due first, then weak, then new, within daily targets", () => {
    const items: SchedulableItem[] = [
      { componentKey: "due-a", card: cardDueAt(NOW - 2000), state: "learning" },
      { componentKey: "due-b", card: cardDueAt(NOW - 1000), state: "learning" },
      {
        componentKey: "weak-a",
        card: cardDueAt(NOW + 100000),
        state: "learning",
        weakScore: 0.9,
      },
      {
        componentKey: "weak-b",
        card: cardDueAt(NOW + 100000),
        state: "learning",
        weakScore: 0.5,
      },
      { componentKey: "new-a", card: null, state: "not_started" },
      { componentKey: "new-b", card: null, state: "not_started" },
    ];
    const session = buildMixedSession(items, NOW, {
      newLimit: 10,
      reviewLimit: 10,
    });
    // due (by due time) → weak (weakest first) → new (stable).
    expect(session).toEqual([
      "due-a",
      "due-b",
      "weak-a",
      "weak-b",
      "new-a",
      "new-b",
    ]);
  });

  it("respects the daily targets (defaults 10 new / 20 reviews)", () => {
    expect(DEFAULT_DAILY_TARGETS).toEqual({ newLimit: 10, reviewLimit: 20 });
    const many: SchedulableItem[] = Array.from({ length: 30 }, (_, i) => ({
      componentKey: `new-${String(i).padStart(2, "0")}`,
      card: null,
      state: "not_started" as const,
    }));
    const session = buildMixedSession(many, NOW);
    expect(session).toHaveLength(10); // new capped at 10
  });

  it("never lists a component in more than one tier (no double-add)", () => {
    // A due wrong-only card is `not_started` (no clean success yet) but HAS a
    // card — it must appear only in the due tier, never also as 'new'. The
    // non-due wrong-only card carries its weakness evidence (score from the
    // incorrect first attempt), which is what makes it a weak-tier member.
    const items: SchedulableItem[] = [
      {
        componentKey: "wrong-due",
        card: cardDueAt(NOW - 1000),
        state: "not_started",
      },
      {
        componentKey: "wrong-not-due",
        card: cardDueAt(NOW + 100000),
        state: "not_started",
        weakScore: 1,
      },
      { componentKey: "truly-new", card: null, state: "not_started" },
    ];
    const session = buildMixedSession(items, NOW);
    expect(new Set(session).size).toBe(session.length); // no duplicates
    expect(session).toContain("wrong-due"); // due
    expect(session).toContain("wrong-not-due"); // weak (evidence: score > 0)
    expect(session).toContain("truly-new"); // new (no card)
    // The due wrong-only card appears exactly once.
    expect(session.filter((k) => k === "wrong-due")).toHaveLength(1);
  });

  it("weak membership needs evidence: a score-zero learning card is not re-drilled", () => {
    const items: SchedulableItem[] = [
      // Answered correctly, not yet due, no weakness evidence: NOT selected.
      {
        componentKey: "fine-not-due",
        card: cardDueAt(NOW + 100000),
        state: "learning",
        weakScore: 0,
      },
      // Recent incorrect first attempt: weak.
      {
        componentKey: "weak-evidence",
        card: cardDueAt(NOW + 100000),
        state: "learning",
        weakScore: 0.4,
      },
      // Projected needs_review qualifies even without a computed score.
      {
        componentKey: "needs-review",
        card: cardDueAt(NOW + 100000),
        state: "needs_review",
      },
      // Mastered non-due never qualifies, whatever the score says.
      {
        componentKey: "mastered",
        card: cardDueAt(NOW + 100000),
        state: "mastered",
        weakScore: 1,
      },
      // Due stays the top tier even at score zero.
      {
        componentKey: "due-score-zero",
        card: cardDueAt(NOW - 1000),
        state: "learning",
        weakScore: 0,
      },
    ];
    const session = buildMixedSession(items, NOW);
    expect(session).toEqual([
      "due-score-zero",
      "weak-evidence",
      "needs-review",
    ]);
  });

  it("orders new items by the caller's rank, never raw key order", () => {
    const items: SchedulableItem[] = [
      // Raw key order would run a-first; the caller's ranks say otherwise.
      { componentKey: "new-a", card: null, state: "not_started", newRank: 2 },
      { componentKey: "new-b", card: null, state: "not_started", newRank: 0 },
      { componentKey: "new-c", card: null, state: "not_started", newRank: 1 },
      // Unranked new items run after every ranked one.
      { componentKey: "new-0-unranked", card: null, state: "not_started" },
    ];
    const session = buildMixedSession(items, NOW);
    expect(session).toEqual(["new-b", "new-c", "new-a", "new-0-unranked"]);
  });

  it("caps reviews (due+weak) at the review target", () => {
    const dueItems: SchedulableItem[] = Array.from({ length: 25 }, (_, i) => ({
      componentKey: `due-${String(i).padStart(2, "0")}`,
      card: cardDueAt(NOW - (i + 1) * 1000),
      state: "learning" as const,
    }));
    const session = buildMixedSession(dueItems, NOW, {
      newLimit: 10,
      reviewLimit: 20,
    });
    expect(session).toHaveLength(20); // reviews capped at 20
  });
});
