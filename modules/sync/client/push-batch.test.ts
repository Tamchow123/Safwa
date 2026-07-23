import { describe, expect, it } from "vitest";

import type {
  WireAttempt,
  WireBookmark,
  WireList,
  WireRevocation,
  WireSetting,
} from "@/modules/sync/protocol";

import type { QueuedMutations } from "./mutation-queue";
import {
  buildBoundedPushRequest,
  MUTATION_BATCH_RESERVE,
  schedulingEventLimit,
} from "./push-batch";

// buildBoundedPushRequest only reads array lengths + slices; typed stubs suffice.
const stub = <T>(n: number): T[] => Array.from({ length: n }, () => ({}) as T);

// Small bounds so truncation is easy to reason about.
const BOUNDS = {
  maxItemsPerBatch: 10,
  maxAttempts: 5,
  maxRevocations: 3,
  maxBookmarks: 4,
  maxLists: 2,
  maxSettings: 2,
};

function queued(over: Partial<QueuedMutations> = {}): QueuedMutations {
  return {
    revocations: [],
    bookmarks: [],
    lists: [],
    settings: [],
    reinforcementAttempts: [],
    ...over,
  };
}

describe("schedulingEventLimit", () => {
  it("reserves no room when there are no pending mutations", () => {
    // (10 - 0) / 2 = 5, capped by pushLimit.
    expect(schedulingEventLimit(0, 100, BOUNDS)).toBe(5);
    expect(schedulingEventLimit(0, 3, BOUNDS)).toBe(3); // pushLimit wins
  });

  it("reserves room proportional to the mutation demand, capped at the reserve", () => {
    // 2 pending mutations → reserve 2 → (10 - 2)/2 = 4.
    expect(schedulingEventLimit(2, 100, BOUNDS)).toBe(4);
    // Huge demand → reserve capped at maxItemsPerBatch/... but BOUNDS is tiny;
    // reserve = min(demand, MUTATION_BATCH_RESERVE) = min(9, 250) = 9 → (10-9)/2 = 0.
    expect(schedulingEventLimit(9, 100, BOUNDS)).toBe(0);
  });

  it("caps the reserve at MUTATION_BATCH_RESERVE with production bounds", () => {
    // Default SYNC_BOUNDS: maxItemsPerBatch 1000. A huge mutation backlog still
    // leaves scheduling a healthy share (reserve never exceeds the constant).
    const limit = schedulingEventLimit(100_000, 500);
    expect(limit).toBe(Math.floor((1000 - MUTATION_BATCH_RESERVE) / 2)); // 375
  });
});

describe("buildBoundedPushRequest", () => {
  it("returns null when there is nothing to send", () => {
    expect(
      buildBoundedPushRequest(
        { deviceId: "d", events: [], schedulingAttempts: [], queued: queued() },
        BOUNDS,
      ),
    ).toBeNull();
  });

  it("includes everything when under budget", () => {
    const req = buildBoundedPushRequest(
      {
        deviceId: "d",
        events: stub<WireAttempt>(1) as never,
        schedulingAttempts: stub<WireAttempt>(1),
        queued: queued({
          revocations: stub<WireRevocation>(1),
          bookmarks: stub<WireBookmark>(1),
        }),
      },
      BOUNDS,
    );
    expect(req).not.toBeNull();
    expect(req!.events).toHaveLength(1);
    expect(req!.attempts).toHaveLength(1);
    expect(req!.revocations).toHaveLength(1);
    expect(req!.bookmarks).toHaveLength(1);
  });

  it("fills scheduling first, then truncates queued mutations to the total budget", () => {
    // budget 10; 6 events + 0 attempts leaves 4 for mutations.
    const req = buildBoundedPushRequest(
      {
        deviceId: "d",
        events: stub<WireAttempt>(6) as never,
        schedulingAttempts: [],
        queued: queued({
          revocations: stub<WireRevocation>(3), // cap 3
          bookmarks: stub<WireBookmark>(4), // cap 4, but only 1 budget left
        }),
      },
      BOUNDS,
    );
    // 4 mutation slots: 3 revocations (its cap), then 1 bookmark.
    expect(req!.revocations).toHaveLength(3);
    expect(req!.bookmarks).toHaveLength(1);
    const total =
      req!.events.length +
      req!.attempts.length +
      req!.revocations.length +
      req!.bookmarks.length +
      req!.lists.length +
      req!.settings.length;
    expect(total).toBe(BOUNDS.maxItemsPerBatch);
  });

  it("respects each category's own wire cap", () => {
    const req = buildBoundedPushRequest(
      {
        deviceId: "d",
        events: [],
        schedulingAttempts: [],
        queued: queued({
          lists: stub<WireList>(5),
          settings: stub<WireSetting>(5),
        }),
      },
      BOUNDS,
    );
    expect(req!.lists).toHaveLength(2); // maxLists
    expect(req!.settings).toHaveLength(2); // maxSettings
  });

  it("services a latency-sensitive revocation before a large reinforcement backlog (REL-002)", () => {
    // Only 3 mutation slots, but a full reinforcement backlog: the revocation
    // must still get in ahead of reinforcement attempts.
    const req = buildBoundedPushRequest(
      {
        deviceId: "d",
        events: stub<WireAttempt>(7) as never, // leaves budget 3
        schedulingAttempts: [],
        queued: queued({
          revocations: stub<WireRevocation>(1),
          reinforcementAttempts: stub<WireAttempt>(5),
        }),
      },
      BOUNDS,
    );
    expect(req!.revocations).toHaveLength(1); // NOT starved by reinforcement
    expect(req!.attempts).toHaveLength(2); // the remaining 2 slots
  });

  it("shares the attempt cap between scheduling and reinforcement attempts", () => {
    const req = buildBoundedPushRequest(
      {
        deviceId: "d",
        events: [],
        schedulingAttempts: stub<WireAttempt>(3),
        queued: queued({ reinforcementAttempts: stub<WireAttempt>(5) }),
      },
      BOUNDS,
    );
    // maxAttempts 5; 3 scheduling → only 2 reinforcement fit.
    expect(req!.attempts).toHaveLength(5);
  });
});
