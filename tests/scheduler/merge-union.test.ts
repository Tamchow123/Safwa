/**
 * Phase 17 §14 — the guest→account MERGE UNION shape of a component's accepted
 * scheduling events, and the deterministic replay that makes "the final state
 * equals replay of the accepted union" a well-defined, reproducible claim.
 *
 * The strict single-chain invariants (Phase 7) are pinned in chain.test.ts and
 * are deliberately NOT relaxed here: this file proves which additional shapes
 * are legitimate, that everything else is still rejected, and that a union
 * replays identically to an independent chronological oracle.
 */
import { createEmptyCard, fsrs, generatorParameters } from "ts-fsrs";
import { describe, expect, it } from "vitest";

import {
  chainHead,
  ChainError,
  deriveNextLineage,
  orderForReplay,
  partitionScheduling,
  replayChain,
} from "@/modules/scheduler/chain";
import type { ReviewEvent } from "@/modules/scheduler/events";
import type { SchedulerCard } from "@/modules/scheduler/fsrs";
import { projectComponent } from "@/modules/scheduler/states";

import { buildChain, RAW_FSRS_GRADE, RAW_FSRS_STATE } from "./fixtures";

/**
 * INDEPENDENT oracle for a union: drive RAW ts-fsrs over the events in
 * chronological order (the order a learner actually experienced them), with no
 * reference to the module's own ordering code.
 */
function rawChronologicalReplay(events: readonly ReviewEvent[]): SchedulerCard {
  const engine = fsrs(generatorParameters({ enable_fuzz: false }));
  const ordered = [...events].sort(
    (a, b) =>
      Date.parse(a.occurredAtClient) - Date.parse(b.occurredAtClient) ||
      a.clientComponentRevision - b.clientComponentRevision ||
      (a.eventId < b.eventId ? -1 : 1),
  );
  let card = createEmptyCard(new Date(Date.parse(ordered[0].occurredAtClient)));
  for (const event of ordered) {
    card = engine.next(
      card,
      new Date(Date.parse(event.occurredAtClient)),
      RAW_FSRS_GRADE[event.rating],
    ).card;
  }
  return {
    stability: card.stability,
    difficulty: card.difficulty,
    dueAtMs: card.due.getTime(),
    state: RAW_FSRS_STATE[card.state],
    reps: card.reps,
    lapses: card.lapses,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    lastReviewAtMs: card.last_review ? card.last_review.getTime() : null,
  };
}

/** Re-label a chain's ids/prefix so two fixture chains are disjoint. */
function relabel(events: ReviewEvent[], prefix: string): ReviewEvent[] {
  const idFor = (id: string) => `${prefix}-${id}`;
  return events.map((event) => ({
    ...event,
    eventId: idFor(event.eventId),
    attemptId: idFor(event.attemptId),
    parentEventId:
      event.parentEventId === null ? null : idFor(event.parentEventId),
    deviceId: prefix,
  }));
}

/** The account's chain: two reviews, days 1 and 3. */
function accountChain(): ReviewEvent[] {
  return relabel(
    buildChain([
      { isCorrect: true, occurredAtUtc: "2026-07-01T09:00:00.000Z" },
      { isCorrect: true, occurredAtUtc: "2026-07-03T09:00:00.000Z" },
    ]),
    "acct",
  );
}

/** The imported guest chain: two reviews, days 2 and 4 — INTERLEAVED with the account's. */
function guestChain(): ReviewEvent[] {
  return relabel(
    buildChain([
      { isCorrect: false, occurredAtUtc: "2026-07-02T09:00:00.000Z" },
      { isCorrect: true, occurredAtUtc: "2026-07-04T09:00:00.000Z" },
    ]),
    "guest",
  );
}

/** Every entry point must honour the union opt-in identically. */
const UNION = { allowMergeUnion: true } as const;

describe("merge union — classification (phases-17.md §14)", () => {
  it("classifies one sequential chain as strict and self-contained", () => {
    const partition = partitionScheduling(accountChain());
    expect(partition.shape).toBe("strict");
    expect(partition.complete).toBe(true);
    expect(partition.chains).toHaveLength(1);
    expect(partition.chains[0].complete).toBe(true);
  });

  it("classifies an account+guest union as a union, self-contained", () => {
    const union = [...accountChain(), ...guestChain()];
    const partition = partitionScheduling(union, UNION);
    expect(partition.shape).toBe("union");
    expect(partition.complete).toBe(true);
    expect(partition.chains).toHaveLength(2);
    expect(partition.chains.every((chain) => chain.complete)).toBe(true);
    // Both sides keep their own two events, in their own causal order.
    expect(partition.chains.map((chain) => chain.events.length)).toEqual([
      2, 2,
    ]);
  });

  it("treats a chain rooted on an absent parent as partial, not corrupt", () => {
    // R2-F2: a device that bootstrapped from a pulled lineage anchor holds a
    // chain whose root parents an event it never stored. Before Phase 17 this
    // threw; it is a partial history, not corruption — and it needs NO opt-in,
    // because it is an ordinary-sync shape, not a merge union.
    const [first, second] = accountChain();
    const anchored = [
      { ...first, parentEventId: "server-head-never-stored-here" },
      second,
    ];
    const partition = partitionScheduling(anchored);
    expect(partition.shape).toBe("partial");
    expect(partition.complete).toBe(false);
    expect(partition.chains).toHaveLength(1);
    expect(() => replayChain(anchored)).not.toThrow();
    expect(replayChain(anchored).complete).toBe(false);
    expect(chainHead(anchored)?.eventId).toBe(second.eventId);
  });

  it("treats a rooted chain that starts above revision 1 as partial", () => {
    const [first, second] = accountChain();
    const shifted = [
      { ...first, clientComponentRevision: 4 },
      { ...second, clientComponentRevision: 5 },
    ];
    const partition = partitionScheduling(shifted);
    expect(partition.shape).toBe("partial");
    expect(partition.complete).toBe(false);
  });

  it("reports an empty set as strict, complete and empty", () => {
    const partition = partitionScheduling([]);
    expect(partition).toEqual({ shape: "strict", chains: [], complete: true });
    expect(replayChain([]).complete).toBe(true);
  });

  it("ignores non-scheduling events when classifying", () => {
    const [first, second] = accountChain();
    const withRevoked = [first, { ...second, status: "revoked" as const }];
    const partition = partitionScheduling(withRevoked);
    expect(partition.shape).toBe("strict");
    expect(partition.chains[0].events).toHaveLength(1);
  });
});

describe("merge union — rejected shapes stay rejected", () => {
  it("rejects a fork (two events sharing one parent) as a Phase 19 concern", () => {
    const [first, second] = accountChain();
    const fork = [
      first,
      second,
      { ...second, eventId: "acct-event-2b", attemptId: "acct-attempt-2b" },
    ];
    expect(() => partitionScheduling(fork)).toThrow(ChainError);
    expect(() => replayChain(fork)).toThrow(ChainError);
  });

  it("rejects a duplicate event id", () => {
    const chain = accountChain();
    expect(() => partitionScheduling([...chain, chain[0]])).toThrow(ChainError);
  });

  it("rejects a self-parenting event", () => {
    const [first] = accountChain();
    expect(() =>
      partitionScheduling([{ ...first, parentEventId: first.eventId }]),
    ).toThrow(ChainError);
  });

  it("rejects a cycle with no root", () => {
    const [first, second] = accountChain();
    const cyclic = [
      { ...first, parentEventId: second.eventId },
      { ...second, parentEventId: first.eventId },
    ];
    expect(() => partitionScheduling(cyclic)).toThrow(ChainError);
  });

  it("rejects a revision that does not increase along a chain", () => {
    const [first, second] = accountChain();
    const backwards = [first, { ...second, clientComponentRevision: 1 }];
    expect(() => partitionScheduling(backwards)).toThrow(ChainError);
  });

  it("rejects an unparseable event instant", () => {
    const [first] = accountChain();
    expect(() =>
      orderForReplay([{ ...first, occurredAtClient: "not-a-date" }]),
    ).toThrow(ChainError);
  });

  it("rejects a gap in a self-contained chain's revisions", () => {
    const [first, second] = accountChain();
    const gapped = [first, { ...second, clientComponentRevision: 4 }];
    expect(() => partitionScheduling(gapped)).toThrow(ChainError);
  });
});

describe("merge union — only an explicit merge may union two histories (§14)", () => {
  const union = () => [...accountChain(), ...guestChain()];

  it("rejects a union at EVERY entry point unless the caller opts in", () => {
    // Ordinary sync can never legitimately hold two accepted roots for one
    // component (modules/sync/server/lineage.ts rejects the second root), so a
    // union arriving here means something is wrong — fail loudly rather than
    // silently replay a card nobody asked for.
    expect(() => partitionScheduling(union())).toThrow(ChainError);
    expect(() => orderForReplay(union())).toThrow(ChainError);
    expect(() => replayChain(union())).toThrow(ChainError);
    expect(() => chainHead(union())).toThrow(ChainError);
    expect(() => projectComponent(union(), Date.now())).toThrow(ChainError);
    expect(() =>
      deriveNextLineage(union(), { eventId: "next", clientSequence: 1 }),
    ).toThrow(ChainError);
  });

  it("accepts the same union at every entry point WITH the opt-in", () => {
    expect(() => partitionScheduling(union(), UNION)).not.toThrow();
    expect(() => orderForReplay(union(), UNION)).not.toThrow();
    expect(() => replayChain(union(), UNION)).not.toThrow();
    expect(() => chainHead(union(), UNION)).not.toThrow();
    expect(() => projectComponent(union(), Date.now(), UNION)).not.toThrow();
    expect(() =>
      deriveNextLineage(
        union(),
        { eventId: "next", clientSequence: 1 },
        0,
        UNION,
      ),
    ).not.toThrow();
  });

  it("does not gate the single-chain shapes ordinary sync legitimately holds", () => {
    expect(() => replayChain(accountChain())).not.toThrow();
    const [first, second] = accountChain();
    expect(() =>
      replayChain([{ ...first, parentEventId: "elsewhere" }, second]),
    ).not.toThrow();
  });
});

describe("merge union — bounded work", () => {
  it("merges a pathological many-chain set without quadratic blow-up", () => {
    // Every event roots its own chain (a parent that is not in the set), the
    // worst case for a k-way merge: k === n. The heap keeps this O(n log k), so
    // a set far larger than any real component still completes quickly — the
    // replay runs inside the server's per-component advisory-locked transaction.
    const base = accountChain()[0];
    const many = Array.from({ length: 4000 }, (_, index) => ({
      ...base,
      eventId: `orphan-${String(index).padStart(5, "0")}`,
      attemptId: `orphan-attempt-${index}`,
      parentEventId: `absent-parent-${index}`,
      clientComponentRevision: (index % 7) + 2,
      occurredAtClient: new Date(
        Date.parse("2026-07-01T00:00:00.000Z") +
          ((index * 7919) % 100000) * 1000,
      ).toISOString(),
    }));

    const startedAt = Date.now();
    const ordered = orderForReplay(many, UNION);
    const elapsedMs = Date.now() - startedAt;

    expect(ordered).toHaveLength(many.length);
    expect(new Set(ordered.map((event) => event.eventId)).size).toBe(
      many.length,
    );
    // Ordered by instant, then revision, then id — never violated.
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = Date.parse(ordered[index - 1].occurredAtClient);
      expect(
        Date.parse(ordered[index].occurredAtClient),
      ).toBeGreaterThanOrEqual(previous);
    }
    // A generous ceiling: the quadratic version took seconds at this size.
    expect(elapsedMs).toBeLessThan(2000);
  });
});

describe("merge union — deterministic replay", () => {
  it("interleaves the two histories by event instant, preserving each chain's own order", () => {
    const account = accountChain();
    const guest = guestChain();
    const ordered = orderForReplay([...account, ...guest], UNION);
    expect(ordered.map((event) => event.eventId)).toEqual([
      account[0].eventId, // Jul 1
      guest[0].eventId, // Jul 2
      account[1].eventId, // Jul 3
      guest[1].eventId, // Jul 4
    ]);
  });

  it("is independent of input order (a pure function of the event set)", () => {
    const union = [...accountChain(), ...guestChain()];
    const shuffled = [union[3], union[1], union[2], union[0]];
    expect(orderForReplay(shuffled, UNION).map((e) => e.eventId)).toEqual(
      orderForReplay(union, UNION).map((e) => e.eventId),
    );
    expect(replayChain(shuffled, UNION).card).toEqual(
      replayChain(union, UNION).card,
    );
  });

  it("replays a union bit-for-bit equal to an INDEPENDENT chronological ts-fsrs oracle", () => {
    const union = [...accountChain(), ...guestChain()];
    expect(replayChain(union, UNION).card).toEqual(
      rawChronologicalReplay(union),
    );
  });

  it("never copies either side's state: the union differs from either chain alone", () => {
    const account = accountChain();
    const guest = guestChain();
    const union = replayChain([...account, ...guest], UNION);
    expect(union.scheduledEventCount).toBe(4);
    expect(union.card).not.toEqual(replayChain(account).card);
    expect(union.card).not.toEqual(replayChain(guest).card);
  });

  it("breaks an identical-instant tie deterministically by revision then event id", () => {
    const account = accountChain();
    const guest = guestChain().map((event) => ({
      ...event,
      // Force both chains' first events onto the SAME instant.
      occurredAtClient:
        event.clientComponentRevision === 1
          ? account[0].occurredAtClient
          : event.occurredAtClient,
    }));
    const ordered = orderForReplay([...account, ...guest], UNION);
    const tied = ordered.slice(0, 2).map((event) => event.eventId);
    expect(tied).toEqual([account[0].eventId, guest[0].eventId].sort());
    // Stable across input permutations.
    expect(
      orderForReplay([...guest, ...account], UNION).map(
        (event) => event.eventId,
      ),
    ).toEqual(ordered.map((event) => event.eventId));
  });

  it("preserves every original id and internal parent link (§9.4)", () => {
    const account = accountChain();
    const guest = guestChain();
    const union = [...account, ...guest];
    const before = JSON.stringify(union);
    const ordered = orderForReplay(union, UNION);
    expect(JSON.stringify(union)).toBe(before); // no mutation
    for (const original of union) {
      const replayed = ordered.find(
        (event) => event.eventId === original.eventId,
      );
      expect(replayed?.parentEventId).toBe(original.parentEventId);
      expect(replayed?.attemptId).toBe(original.attemptId);
      expect(replayed?.clientComponentRevision).toBe(
        original.clientComponentRevision,
      );
    }
  });

  it("projects a learner state through the same shared scheduler", () => {
    const union = [...accountChain(), ...guestChain()];
    const projection = projectComponent(
      union,
      Date.parse("2026-07-05T09:00:00.000Z"),
      UNION,
    );
    expect(projection.shape).toBe("union");
    expect(projection.complete).toBe(true);
    expect(projection.scheduledEventCount).toBe(4);
    expect(projection.card).toEqual(replayChain(union, UNION).card);
  });
});

describe("merge union — extending the union with a new review", () => {
  it("heads on the chronologically last event and takes the union's max revision", () => {
    const account = accountChain();
    // Give the account chain the HIGHER revisions but the EARLIER instants, so
    // "head" (chronological) and "max revision" genuinely disagree.
    const bumped = account.map((event) => ({
      ...event,
      clientComponentRevision: event.clientComponentRevision + 5,
    }));
    const guest = guestChain();
    const union = [...bumped, ...guest];

    const replay = replayChain(union, UNION);
    expect(replay.headEventId).toBe(guest[1].eventId); // Jul 4, latest
    expect(replay.headRevision).toBe(7); // max across the union (5 + 2)

    const lineage = deriveNextLineage(
      union,
      { eventId: "next-event", clientSequence: 99 },
      0,
      UNION,
    );
    expect(lineage.parentEventId).toBe(guest[1].eventId);
    expect(lineage.clientComponentRevision).toBe(8);
    expect(lineage.clientSequence).toBe(99);
  });

  it("matches the Phase 7 lineage exactly for a strict chain", () => {
    const account = accountChain();
    const lineage = deriveNextLineage(account, {
      eventId: "next-event",
      clientSequence: 3,
    });
    expect(lineage.parentEventId).toBe(account[1].eventId);
    expect(lineage.clientComponentRevision).toBe(3);
  });

  it("roots a fresh chain when there are no events", () => {
    const lineage = deriveNextLineage([], {
      eventId: "first",
      clientSequence: 1,
    });
    expect(lineage.parentEventId).toBeNull();
    expect(lineage.clientComponentRevision).toBe(1);
  });
});
