import { describe, expect, it } from "vitest";

import {
  type AcceptedChainState,
  type ComponentKnownEvents,
  classifyLineage,
  classifyMergeLineage,
  type LineageCandidate,
  mergeUnionContext,
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

/**
 * Phase 17 §14. The account has studied this component (A1 → A2, revisions 1–2)
 * and a guest history is being imported into it (G1 → G2, numbering from 1
 * again). The merge rule is a SEPARATE entry point: `classifyLineage` has no
 * parameter that could carry a union context, so these cases call
 * `classifyMergeLineage`, and the A/B below shows the two side by side.
 */
describe("classifyMergeLineage — merge union (Phase 17 §14)", () => {
  const accountChain = () =>
    chain({
      headEventId: "A2",
      headRevision: 2,
      acceptedEventIds: new Set(["A1", "A2"]),
    });
  const accountKnown = () =>
    known({
      parentByEventId: new Map<string, string | null>([
        ["A1", null],
        ["A2", "A1"],
      ]),
    });
  const accountRevisions = () =>
    mergeUnionContext([
      { eventId: "A1", clientComponentRevision: 1 },
      { eventId: "A2", clientComponentRevision: 2 },
    ]);

  const guestRoot = candidate({
    eventId: "G1",
    parentEventId: null,
    clientComponentRevision: 1,
  });

  it("accepts a guest ROOT that ordinary sync rejects as a stale branch", () => {
    // The A/B that defines the mode: identical inputs, two entry points.
    expect(classifyLineage(guestRoot, accountChain(), accountKnown())).toEqual({
      decision: "reject",
      reasonCode: "stale_branch_conflict",
    });

    expect(
      classifyMergeLineage(
        guestRoot,
        accountChain(),
        accountKnown(),
        accountRevisions(),
      ),
    ).toEqual({ decision: "accept", reasonCode: "accepted" });
  });

  it("rejects a root below revision 1 — no chain numbers from there", () => {
    const r = classifyMergeLineage(
      candidate({
        eventId: "G1",
        parentEventId: null,
        clientComponentRevision: 0,
      }),
      accountChain(),
      accountKnown(),
      accountRevisions(),
    );
    expect(r).toEqual({ decision: "reject", reasonCode: "invalid_revision" });
  });

  it("accepts a guest child extending a guest event that is NOT the head", () => {
    // G1 was accepted earlier in this import; the head is still the account's
    // A2, because head selection is chronological for a merged component.
    const r = classifyMergeLineage(
      candidate({
        eventId: "G2",
        parentEventId: "G1",
        clientComponentRevision: 2,
      }),
      chain({
        headEventId: "A2",
        headRevision: 2,
        acceptedEventIds: new Set(["A1", "A2", "G1"]),
      }),
      known({
        parentByEventId: new Map<string, string | null>([
          ["A1", null],
          ["A2", "A1"],
          ["G1", null],
        ]),
      }),
      mergeUnionContext([
        { eventId: "A1", clientComponentRevision: 1 },
        { eventId: "A2", clientComponentRevision: 2 },
        { eventId: "G1", clientComponentRevision: 1 },
      ]),
    );
    expect(r).toEqual({ decision: "accept", reasonCode: "accepted" });
  });

  it("measures contiguity against the PARENT, not the union — a guest revision 2 under a high account head is fine", () => {
    // Ordinary sync would demand headRevision + 1 == 10 here. The guest chain
    // knows nothing of the account's numbering, so the rule is per-chain.
    const r = classifyMergeLineage(
      candidate({
        eventId: "G2",
        parentEventId: "G1",
        clientComponentRevision: 2,
      }),
      chain({
        headEventId: "A9",
        headRevision: 9,
        acceptedEventIds: new Set(["A9", "G1"]),
      }),
      known({
        parentByEventId: new Map<string, string | null>([
          ["A9", null],
          ["G1", null],
        ]),
      }),
      mergeUnionContext([
        { eventId: "A9", clientComponentRevision: 9 },
        { eventId: "G1", clientComponentRevision: 1 },
      ]),
    );
    expect(r).toEqual({ decision: "accept", reasonCode: "accepted" });
  });

  it("requires EXACT contiguity within the chain — a gap is rejected, not tolerated (REL-001)", () => {
    // An imported guest chain is `complete` in the client's terms (root with no
    // parent, numbering from 1), and partitionScheduling requires a complete
    // chain's revisions to be exactly contiguous. A merely-increasing rule would
    // accept this, and the very next replayComponent would throw ChainError —
    // which ingest.ts treats as fatal for the WHOLE component, taking the rest
    // of the batch down with the one orphan.
    const gapped = classifyMergeLineage(
      candidate({
        eventId: "G3",
        parentEventId: "G1",
        clientComponentRevision: 3,
      }),
      chain({
        headEventId: "A2",
        headRevision: 2,
        acceptedEventIds: new Set(["A1", "A2", "G1"]),
      }),
      known({
        parentByEventId: new Map<string, string | null>([
          ["A1", null],
          ["A2", "A1"],
          ["G1", null],
        ]),
      }),
      mergeUnionContext([
        { eventId: "A1", clientComponentRevision: 1 },
        { eventId: "A2", clientComponentRevision: 2 },
        { eventId: "G1", clientComponentRevision: 1 },
      ]),
    );
    expect(gapped).toEqual({
      decision: "reject",
      reasonCode: "impossible_lineage",
    });
  });

  it("rejects a revision that does not increase along its own chain", () => {
    const r = classifyMergeLineage(
      candidate({
        eventId: "G2",
        parentEventId: "G1",
        clientComponentRevision: 1,
      }),
      chain({
        headEventId: "A2",
        headRevision: 2,
        acceptedEventIds: new Set(["A1", "A2", "G1"]),
      }),
      known({
        parentByEventId: new Map<string, string | null>([
          ["A1", null],
          ["A2", "A1"],
          ["G1", null],
        ]),
      }),
      mergeUnionContext([
        { eventId: "A1", clientComponentRevision: 1 },
        { eventId: "A2", clientComponentRevision: 2 },
        { eventId: "G1", clientComponentRevision: 1 },
      ]),
    );
    expect(r).toEqual({ decision: "reject", reasonCode: "invalid_revision" });
  });

  it("rejects a FORK — the union joins histories, it does not let one contradict itself", () => {
    // A2 already claims A1 as its parent. A second child of A1 is a fork, which
    // the client's partitionScheduling throws on even with allowMergeUnion, so
    // accepting it would persist a component that can never be replayed again.
    const r = classifyMergeLineage(
      candidate({
        eventId: "G2",
        parentEventId: "A1",
        clientComponentRevision: 2,
      }),
      accountChain(),
      accountKnown(),
      accountRevisions(),
    );
    expect(r).toEqual({
      decision: "reject",
      reasonCode: "stale_branch_conflict",
    });
  });

  it("refuses an accepted parent whose revision the context does not carry", () => {
    // An inconsistent context is a caller bug; guessing would persist a chain
    // whose contiguity was never actually checked.
    const r = classifyMergeLineage(
      candidate({
        eventId: "G2",
        parentEventId: "A2",
        clientComponentRevision: 3,
      }),
      accountChain(),
      accountKnown(),
      mergeUnionContext([{ eventId: "A1", clientComponentRevision: 1 }]),
    );
    expect(r).toEqual({ decision: "reject", reasonCode: "impossible_lineage" });
  });

  it("holds a child whose parent is pending, and one whose parent is unknown", () => {
    const heldParent = classifyMergeLineage(
      candidate({
        eventId: "G3",
        parentEventId: "G2",
        clientComponentRevision: 3,
      }),
      accountChain(),
      known({
        parentByEventId: new Map<string, string | null>([
          ["A1", null],
          ["A2", "A1"],
          ["G2", "G1"],
        ]),
        pendingEventIds: new Set(["G2"]),
      }),
      accountRevisions(),
    );
    expect(heldParent).toEqual({
      decision: "pending",
      reasonCode: "pending_parent",
    });

    const unknownParent = classifyMergeLineage(
      candidate({
        eventId: "G3",
        parentEventId: "not-here-yet",
        clientComponentRevision: 3,
      }),
      accountChain(),
      accountKnown(),
      accountRevisions(),
    );
    expect(unknownParent).toEqual({
      decision: "pending",
      reasonCode: "pending_parent",
    });
  });

  it("detects cycles in merge mode too — the union never suspends those", () => {
    const selfParent = classifyMergeLineage(
      candidate({
        eventId: "G1",
        parentEventId: "G1",
        clientComponentRevision: 1,
      }),
      accountChain(),
      accountKnown(),
      accountRevisions(),
    );
    expect(selfParent).toEqual({
      decision: "reject",
      reasonCode: "cycle_detected",
    });

    const indirect = classifyMergeLineage(
      candidate({
        eventId: "G1",
        parentEventId: "G2",
        clientComponentRevision: 5,
      }),
      accountChain(),
      known({
        parentByEventId: new Map<string, string | null>([
          ["G2", "G3"],
          ["G3", "G1"],
        ]),
      }),
      accountRevisions(),
    );
    expect(indirect).toEqual({
      decision: "reject",
      reasonCode: "cycle_detected",
    });
  });

  it("leaves ordinary sync bit-for-bit unchanged — its classifier cannot even name the union", () => {
    // The guard against the mode leaking. `classifyLineage` takes three
    // parameters and there is no fourth to pass, so these are the only answers
    // ordinary sync can give for the three structural cases.
    const staleBranch = classifyLineage(
      candidate({
        eventId: "E3",
        parentEventId: "A1",
        clientComponentRevision: 3,
      }),
      accountChain(),
      accountKnown(),
    );
    expect(staleBranch.reasonCode).toBe("stale_branch_conflict");

    const competingRoot = classifyLineage(
      guestRoot,
      accountChain(),
      accountKnown(),
    );
    expect(competingRoot.reasonCode).toBe("stale_branch_conflict");

    const gap = classifyLineage(
      candidate({
        eventId: "E3",
        parentEventId: "A2",
        clientComponentRevision: 9,
      }),
      accountChain(),
      accountKnown(),
    );
    expect(gap.reasonCode).toBe("impossible_lineage");
  });
});
