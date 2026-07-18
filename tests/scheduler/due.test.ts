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
    // card — it must appear only in the due tier, never also as 'new'.
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
      },
      { componentKey: "truly-new", card: null, state: "not_started" },
    ];
    const session = buildMixedSession(items, NOW);
    expect(new Set(session).size).toBe(session.length); // no duplicates
    expect(session).toContain("wrong-due"); // due
    expect(session).toContain("wrong-not-due"); // weak (has a card, not mastered)
    expect(session).toContain("truly-new"); // new (no card)
    // The due wrong-only card appears exactly once.
    expect(session.filter((k) => k === "wrong-due")).toHaveLength(1);
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
