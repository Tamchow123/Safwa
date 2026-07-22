import { describe, expect, it } from "vitest";

import {
  type AcceptedChainState,
  type ComponentKnownEvents,
  classifyLineage,
  type LineageCandidate,
} from "./lineage";

function chain(
  overrides: Partial<AcceptedChainState> = {},
): AcceptedChainState {
  return {
    headEventId: null,
    headRevision: 0,
    acceptedEventIds: new Set<string>(),
    ...overrides,
  };
}

function known(
  overrides: Partial<ComponentKnownEvents> = {},
): ComponentKnownEvents {
  return {
    parentByEventId: new Map<string, string | null>(),
    pendingEventIds: new Set<string>(),
    ...overrides,
  };
}

function candidate(
  overrides: Partial<LineageCandidate> = {},
): LineageCandidate {
  return {
    eventId: "E2",
    parentEventId: "E1",
    clientComponentRevision: 2,
    ...overrides,
  };
}

describe("classifyLineage", () => {
  it("accepts the first event on an empty chain", () => {
    const r = classifyLineage(
      candidate({
        eventId: "E1",
        parentEventId: null,
        clientComponentRevision: 1,
      }),
      chain(),
      known(),
    );
    expect(r).toEqual({ decision: "accept", reasonCode: "accepted" });
  });

  it("accepts an event that extends the accepted head (sequential chain)", () => {
    const r = classifyLineage(
      candidate({
        eventId: "E2",
        parentEventId: "E1",
        clientComponentRevision: 2,
      }),
      chain({
        headEventId: "E1",
        headRevision: 1,
        acceptedEventIds: new Set(["E1"]),
      }),
      known({ parentByEventId: new Map([["E1", null]]) }),
    );
    expect(r.decision).toBe("accept");
  });

  it("accepts a parent==head extension regardless of a stale base revision (§14.1)", () => {
    // The classifier does not consider base_server_revision at all; parent==head
    // is sufficient for sequential acceptance.
    const r = classifyLineage(
      candidate({
        eventId: "E3",
        parentEventId: "E2",
        clientComponentRevision: 3,
      }),
      chain({
        headEventId: "E2",
        headRevision: 2,
        acceptedEventIds: new Set(["E1", "E2"]),
      }),
      known({
        parentByEventId: new Map([
          ["E1", null],
          ["E2", "E1"],
        ]),
      }),
    );
    expect(r.decision).toBe("accept");
  });

  it("holds an unknown-parent event as pending", () => {
    const r = classifyLineage(
      candidate({
        eventId: "E3",
        parentEventId: "E2",
        clientComponentRevision: 3,
      }),
      chain({
        headEventId: "E1",
        headRevision: 1,
        acceptedEventIds: new Set(["E1"]),
      }),
      known({ parentByEventId: new Map([["E1", null]]) }),
    );
    expect(r).toEqual({ decision: "pending", reasonCode: "pending_parent" });
  });

  it("holds a child whose parent is itself pending", () => {
    const r = classifyLineage(
      candidate({
        eventId: "E3",
        parentEventId: "E2",
        clientComponentRevision: 3,
      }),
      chain({
        headEventId: "E1",
        headRevision: 1,
        acceptedEventIds: new Set(["E1"]),
      }),
      known({
        parentByEventId: new Map([
          ["E1", null],
          ["E2", "E1"],
        ]),
        pendingEventIds: new Set(["E2"]),
      }),
    );
    expect(r.decision).toBe("pending");
  });

  it("rejects a self-parenting event as a cycle", () => {
    const r = classifyLineage(
      candidate({
        eventId: "E5",
        parentEventId: "E5",
        clientComponentRevision: 5,
      }),
      chain({
        headEventId: "E1",
        headRevision: 1,
        acceptedEventIds: new Set(["E1"]),
      }),
      known(),
    );
    expect(r).toEqual({ decision: "reject", reasonCode: "cycle_detected" });
  });

  it("rejects an indirect cycle", () => {
    // Candidate E2 claims parent E3, but E3's ancestry loops back to E2.
    const r = classifyLineage(
      candidate({
        eventId: "E2",
        parentEventId: "E3",
        clientComponentRevision: 9,
      }),
      chain({
        headEventId: "E1",
        headRevision: 1,
        acceptedEventIds: new Set(["E1"]),
      }),
      known({
        parentByEventId: new Map([
          ["E3", "E2"],
          ["E2", "E3"],
        ]),
      }),
    );
    expect(r.reasonCode).toBe("cycle_detected");
  });

  it("rejects a genuine stale branch (parent is an accepted non-head event)", () => {
    const r = classifyLineage(
      candidate({
        eventId: "E3",
        parentEventId: "E1",
        clientComponentRevision: 3,
      }),
      chain({
        headEventId: "E2",
        headRevision: 2,
        acceptedEventIds: new Set(["E1", "E2"]),
      }),
      known({
        parentByEventId: new Map([
          ["E1", null],
          ["E2", "E1"],
        ]),
      }),
    );
    expect(r).toEqual({
      decision: "reject",
      reasonCode: "stale_branch_conflict",
    });
  });

  it("rejects a second root when the chain already has a head", () => {
    const r = classifyLineage(
      candidate({
        eventId: "EX",
        parentEventId: null,
        clientComponentRevision: 5,
      }),
      chain({
        headEventId: "E1",
        headRevision: 1,
        acceptedEventIds: new Set(["E1"]),
      }),
      known({ parentByEventId: new Map([["E1", null]]) }),
    );
    expect(r).toEqual({
      decision: "reject",
      reasonCode: "stale_branch_conflict",
    });
  });

  it("rejects a revision that regresses at or below the accepted head", () => {
    const r = classifyLineage(
      candidate({
        eventId: "E2",
        parentEventId: "E1",
        clientComponentRevision: 1,
      }),
      chain({
        headEventId: "E1",
        headRevision: 1,
        acceptedEventIds: new Set(["E1"]),
      }),
      known({ parentByEventId: new Map([["E1", null]]) }),
    );
    expect(r).toEqual({ decision: "reject", reasonCode: "invalid_revision" });
  });

  it("classifies a stale branch by structure even when its revision <= head (REL-001)", () => {
    // Structurally identical to the stale-branch test but revision 2 == head 2:
    // the revision must NOT short-circuit to the non-recoverable invalid_revision.
    const r = classifyLineage(
      candidate({
        eventId: "E3",
        parentEventId: "E1",
        clientComponentRevision: 2,
      }),
      chain({
        headEventId: "E2",
        headRevision: 2,
        acceptedEventIds: new Set(["E1", "E2"]),
      }),
      known({
        parentByEventId: new Map([
          ["E1", null],
          ["E2", "E1"],
        ]),
      }),
    );
    expect(r).toEqual({
      decision: "reject",
      reasonCode: "stale_branch_conflict",
    });
  });

  it("rejects an impossible revision gap on a sequential extension", () => {
    // parent == head (E2, rev 2) but the revision jumps to 5 (expected 3).
    const r = classifyLineage(
      candidate({
        eventId: "E3",
        parentEventId: "E2",
        clientComponentRevision: 5,
      }),
      chain({
        headEventId: "E2",
        headRevision: 2,
        acceptedEventIds: new Set(["E1", "E2"]),
      }),
      known({
        parentByEventId: new Map([
          ["E1", null],
          ["E2", "E1"],
        ]),
      }),
    );
    expect(r).toEqual({ decision: "reject", reasonCode: "impossible_lineage" });
  });
});
