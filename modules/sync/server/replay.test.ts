import { describe, expect, it } from "vitest";

import { type ComponentReplayEvent, replayComponent } from "./replay";

const NOW = Date.parse("2026-06-01T10:00:00.000Z");

function event(
  overrides: Partial<ComponentReplayEvent> = {},
): ComponentReplayEvent {
  return {
    eventId: "E1",
    status: "scheduling",
    rating: "good",
    clientComponentRevision: 1,
    parentEventId: null,
    occurredAtCanonical: new Date("2026-01-01T10:00:00.000Z"),
    localDateAtEvent: "2026-01-01",
    ...overrides,
  };
}

const E1 = event();
const E2 = event({
  eventId: "E2",
  clientComponentRevision: 2,
  parentEventId: "E1",
  occurredAtCanonical: new Date("2026-01-02T10:00:00.000Z"),
  localDateAtEvent: "2026-01-02",
});

describe("replayComponent", () => {
  it("returns not_started with a null card for an empty event set", () => {
    const state = replayComponent([], NOW);
    expect(state.learnerState).toBe("not_started");
    expect(state.stability).toBeNull();
    expect(state.dueAt).toBeNull();
    expect(state.reps).toBe(0);
    expect(state.scheduledEventCount).toBe(0);
    expect(state.masteryDates).toEqual([]);
  });

  it("replays a single new-item event into a live card", () => {
    const state = replayComponent([E1], NOW);
    expect(state.scheduledEventCount).toBe(1);
    expect(state.reps).toBe(1);
    expect(state.stability).not.toBeNull();
    expect(state.dueAt).toBeInstanceOf(Date);
    expect(state.learnerState).not.toBe("not_started");
  });

  it("replays a two-event chain (both reps applied)", () => {
    const state = replayComponent([E1, E2], NOW);
    expect(state.scheduledEventCount).toBe(2);
    expect(state.reps).toBe(2);
  });

  it("is deterministic — the same event set yields identical state (replay invariant)", () => {
    expect(replayComponent([E1, E2], NOW)).toEqual(
      replayComponent([E1, E2], NOW),
    );
  });

  it("is order-independent — causal order is by revision, not array order", () => {
    expect(replayComponent([E2, E1], NOW)).toEqual(
      replayComponent([E1, E2], NOW),
    );
  });

  it("replays at CANONICAL time — a different canonical instant changes the schedule", () => {
    const early = replayComponent([E1], NOW);
    const late = replayComponent(
      [event({ occurredAtCanonical: new Date("2026-05-01T10:00:00.000Z") })],
      NOW,
    );
    // Same rating/inputs but a later review instant => a later due date.
    expect(early.dueAt).toBeInstanceOf(Date);
    expect(late.dueAt).toBeInstanceOf(Date);
    expect(late.dueAt?.getTime()).toBeGreaterThan(early.dueAt?.getTime() ?? 0);
  });

  it("records no lapses for an all-correct chain", () => {
    // A chain with no failed reviews can never have accrued a lapse.
    const state = replayComponent([E1, E2], NOW);
    expect(state.lapses).toBe(0);
  });

  it("excludes a non-scheduling (revoked/pending) event from replay (safety net)", () => {
    // A revoked event that leaked into the set must NOT affect the chain — the
    // scheduler's status filter stays live because we pass the real status.
    const withLeak = replayComponent(
      [
        E1,
        event({
          eventId: "REVOKED",
          status: "revoked",
          clientComponentRevision: 2,
          parentEventId: "E1",
          rating: "again",
        }),
      ],
      NOW,
    );
    const cleanSingle = replayComponent([E1], NOW);
    expect(withLeak).toEqual(cleanSingle);
    expect(withLeak.scheduledEventCount).toBe(1);
  });
});
