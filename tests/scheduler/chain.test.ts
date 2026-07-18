import { describe, expect, it } from "vitest";
import { createEmptyCard, fsrs, generatorParameters, Rating } from "ts-fsrs";

import {
  chainHead,
  ChainError,
  orderCausally,
  replayChain,
  undoLastEvent,
} from "@/modules/scheduler/chain";
import type { ReviewEvent } from "@/modules/scheduler/events";
import type { SchedulerCard } from "@/modules/scheduler/fsrs";

import { buildChain, buildNaturalChain } from "./fixtures";

const T0 = Date.UTC(2026, 6, 17, 9, 0, 0);

const GRADE = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
} as const;
const STATE: Record<number, SchedulerCard["state"]> = {
  0: "new",
  1: "learning",
  2: "review",
  3: "relearning",
};

/**
 * INDEPENDENT oracle: replay a chain by driving RAW ts-fsrs (not the module's
 * wrapper) at each event's recorded instant, returning the equivalent card.
 */
function rawReplay(events: readonly ReviewEvent[]): SchedulerCard {
  const f = fsrs(generatorParameters({ enable_fuzz: false }));
  const ordered = [...events].sort(
    (a, b) => a.clientComponentRevision - b.clientComponentRevision,
  );
  let card = createEmptyCard(new Date(Date.parse(ordered[0].occurredAtClient)));
  for (const event of ordered) {
    card = f.next(
      card,
      new Date(Date.parse(event.occurredAtClient)),
      GRADE[event.rating],
    ).card;
  }
  return {
    stability: card.stability,
    difficulty: card.difficulty,
    dueAtMs: card.due.getTime(),
    state: STATE[card.state],
    reps: card.reps,
    lapses: card.lapses,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    lastReviewAtMs: card.last_review ? card.last_review.getTime() : null,
  };
}

describe("causal chain — replay determinism", () => {
  it("replays to a card bit-for-bit equal to an INDEPENDENT raw ts-fsrs oracle", () => {
    // A chain that reaches the Review state and applies due Review-state Hard
    // and Again, so the raw-vs-replay comparison covers the core scheduling
    // algorithm (elapsed time, stability, lapses, long intervals).
    const { events } = buildNaturalChain(
      ["good", "good", "good", "good", "good", "hard", "again"],
      T0,
      (i) => `2026-07-${17 + i}`,
    );
    expect(replayChain(events).card).toEqual(rawReplay(events));
  });

  it("is order-independent of the input array (causal order is by revision)", () => {
    const { events } = buildNaturalChain(
      ["good", "again", "good"],
      T0,
      (i) => `2026-07-${17 + i}`,
    );
    const shuffled = [events[2], events[0], events[1]];
    expect(replayChain(shuffled).card).toEqual(replayChain(events).card);
  });

  it("returns a null card and no mastery dates for an empty chain", () => {
    const replay = replayChain([]);
    expect(replay.card).toBeNull();
    expect(replay.masteryDates).toEqual([]);
    expect(replay.scheduledEventCount).toBe(0);
    expect(replay.headEventId).toBeNull();
  });

  it("two and three sequential reviews all schedule with monotonic revisions", () => {
    const two = buildChain([
      { isCorrect: true },
      { isCorrect: true, occurredAtUtc: "2026-07-18T09:00:00.000Z" },
    ]);
    expect(replayChain(two).scheduledEventCount).toBe(2);
    expect(two.map((e) => e.clientComponentRevision)).toEqual([1, 2]);
    expect(two[1].parentEventId).toBe(two[0].eventId);

    const three = buildChain([
      { isCorrect: true },
      { isCorrect: true, occurredAtUtc: "2026-07-18T09:00:00.000Z" },
      { isCorrect: true, occurredAtUtc: "2026-07-19T09:00:00.000Z" },
    ]);
    expect(replayChain(three).scheduledEventCount).toBe(3);
    expect(three.map((e) => e.clientComponentRevision)).toEqual([1, 2, 3]);
    expect(chainHead(three)?.eventId).toBe(three[2].eventId);
  });
});

describe("causal chain — validation", () => {
  it("rejects a broken parent link", () => {
    const events = buildChain([{ isCorrect: true }, { isCorrect: true }]);
    const tampered = [
      events[0],
      { ...events[1], parentEventId: "wrong-parent" },
    ];
    expect(() => orderCausally(tampered)).toThrow(ChainError);
  });

  it("rejects a duplicate / non-contiguous revision (a branch — Phase 19)", () => {
    const events = buildChain([{ isCorrect: true }, { isCorrect: true }]);
    const branched = [
      events[0],
      { ...events[1], clientComponentRevision: 1, parentEventId: null },
    ];
    expect(() => orderCausally(branched)).toThrow(ChainError);
  });

  it("only accepted `scheduling` events are replayed", () => {
    const events = buildChain([{ isCorrect: true }, { isCorrect: true }]);
    const withRevoked = [
      events[0],
      { ...events[1], status: "revoked" as const },
    ];
    // The revoked event is ignored; only the root remains (a valid 1-event chain).
    expect(replayChain(withRevoked).scheduledEventCount).toBe(1);
  });
});

describe("causal chain — undo (pre-sync)", () => {
  it("removes the head event, returns it, and restores the prior card", () => {
    const { events } = buildNaturalChain(
      ["good", "good", "good"],
      T0,
      (i) => `2026-07-${17 + i}`,
    );
    const beforeLast = replayChain(events.slice(0, 2));
    const result = undoLastEvent(events);
    expect(result.events).toHaveLength(2);
    // The removed head event is returned so the caller can delete its attempt.
    expect(result.removedEvent.eventId).toBe(events[2].eventId);
    expect(result.removedEvent.attemptId).toBe(events[2].attemptId);
    // The restored card matches re-replay of the remaining chain.
    expect(result.restoredCard).toEqual(beforeLast.card);
    expect(replayChain(result.events).card).toEqual(beforeLast.card);
  });

  it("throws when there is nothing to undo", () => {
    expect(() => undoLastEvent([])).toThrow(ChainError);
  });
});
