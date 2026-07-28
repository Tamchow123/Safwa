import { describe, expect, it } from "vitest";

import {
  GUEST_MERGE_BOUNDS,
  SYNC_BOUNDS,
  type WireAttempt,
  type WireBookmark,
  type WireEvent,
  type WireList,
  type WireSetting,
} from "@/modules/sync/protocol";

import type { GuestSnapshot } from "./guest-snapshot";
import {
  declaredCountsOf,
  GuestMergeChunkOverflowError,
  planGuestMergeChunks,
  type GuestMergeChunkBody,
} from "./guest-merge-chunking";

/**
 * The planner reads only `id`/`attemptId` and array lengths, so these stand-ins
 * carry just enough identity to assert PARTITION and CO-LOCATION, which is the
 * whole contract. Building thousands of wire-valid records per case would test
 * the schema, not the planner.
 */
function snapshot(counts: {
  /** Attempts each graded by exactly one event — the ordinary shape. */
  pairs?: number;
  /** Attempts no event references (reinforcement-only). */
  looseAttempts?: number;
  bookmarks?: number;
  lists?: number;
  settings?: number;
}): GuestSnapshot {
  const attempts: WireAttempt[] = [];
  const events: WireEvent[] = [];
  for (let i = 0; i < (counts.pairs ?? 0); i += 1) {
    attempts.push({ id: `a${i}` } as WireAttempt);
    events.push({ eventId: `e${i}`, attemptId: `a${i}` } as WireEvent);
  }
  for (let i = 0; i < (counts.looseAttempts ?? 0); i += 1) {
    attempts.push({ id: `loose-${i}` } as WireAttempt);
  }
  const seq = <T>(n: number, make: (i: number) => T): T[] =>
    Array.from({ length: n }, (_v, i) => make(i));
  return {
    version: 1,
    deviceId: "device-1",
    attempts,
    events,
    bookmarks: seq(counts.bookmarks ?? 0, (i) => ({ entryId: i + 1 }) as WireBookmark), // prettier-ignore
    lists: seq(counts.lists ?? 0, (i) => ({ id: `l${i}` }) as WireList),
    settings: seq(counts.settings ?? 0, (i) => ({ key: `s${i}` }) as unknown as WireSetting), // prettier-ignore
    skipped: { events: 0, attempts: 0, bookmarks: 0, lists: 0, settings: 0 },
  };
}

function totalOf(chunks: GuestMergeChunkBody[]): number {
  return chunks.reduce(
    (sum, c) =>
      sum +
      c.attempts.length +
      c.events.length +
      c.bookmarks.length +
      c.lists.length +
      c.settings.length,
    0,
  );
}

describe("declaredCountsOf", () => {
  it("declares exactly what the snapshot carries", () => {
    expect(declaredCountsOf(snapshot({ pairs: 3, settings: 1 }))).toEqual({
      attempts: 3,
      events: 3,
      bookmarks: 0,
      lists: 0,
      settings: 1,
    });
  });
});

describe("planGuestMergeChunks", () => {
  it("plans no chunks at all for an empty snapshot", () => {
    // `begin` straight to `finalize`. A chunk asserting emptiness would be a
    // request that says nothing, and the server would have to decide what an
    // empty chunk means.
    expect(planGuestMergeChunks(snapshot({}))).toEqual([]);
  });

  it("fits a small snapshot into one chunk", () => {
    const chunks = planGuestMergeChunks(
      snapshot({ pairs: 2, bookmarks: 1, lists: 1, settings: 1 }),
    );
    expect(chunks).toHaveLength(1);
    expect(totalOf(chunks)).toBe(7);
  });

  it("keeps every event in the same chunk as the attempt it grades", () => {
    // THE constraint. The server resolves an event's attempt from the attempts
    // in the SAME request (ingest.ts builds `attemptsById` per call) and rejects
    // an event whose attempt is absent as `malformed_item` — permanent and
    // non-recoverable. Splitting a pair does not delay that event, it destroys
    // it, silently, while every other item succeeds.
    const chunks = planGuestMergeChunks(
      snapshot({ pairs: 2500, bookmarks: 300 }),
    );
    for (const chunk of chunks) {
      const attemptIds = new Set(chunk.attempts.map((a) => a.id));
      for (const event of chunk.events) {
        expect(attemptIds.has(event.attemptId)).toBe(true);
      }
    }
    expect(chunks.flatMap((c) => c.events)).toHaveLength(2500);
  });

  it("never exceeds the per-chunk total or any per-kind cap", () => {
    const chunks = planGuestMergeChunks(
      snapshot({
        pairs: SYNC_BOUNDS.maxAttempts + 137,
        looseAttempts: 50,
        bookmarks: SYNC_BOUNDS.maxBookmarks + 1,
        lists: SYNC_BOUNDS.maxLists + 1,
        settings: SYNC_BOUNDS.maxSettings + 1,
      }),
    );
    for (const chunk of chunks) {
      expect(totalOf([chunk])).toBeLessThanOrEqual(
        GUEST_MERGE_BOUNDS.maxItemsPerChunk,
      );
      expect(chunk.attempts.length).toBeLessThanOrEqual(
        SYNC_BOUNDS.maxAttempts,
      );
      expect(chunk.events.length).toBeLessThanOrEqual(SYNC_BOUNDS.maxEvents);
      expect(chunk.bookmarks.length).toBeLessThanOrEqual(
        SYNC_BOUNDS.maxBookmarks,
      );
      expect(chunk.lists.length).toBeLessThanOrEqual(SYNC_BOUNDS.maxLists);
      expect(chunk.settings.length).toBeLessThanOrEqual(
        SYNC_BOUNDS.maxSettings,
      );
    }
  });

  it("loses nothing and duplicates nothing", () => {
    const source = snapshot({
      pairs: 1200,
      looseAttempts: 40,
      bookmarks: 700,
      lists: 60,
      settings: 5,
    });
    const chunks = planGuestMergeChunks(source);
    expect(totalOf(chunks)).toBe(1200 * 2 + 40 + 700 + 60 + 5);
    const attemptIds = chunks.flatMap((c) => c.attempts.map((a) => a.id));
    expect(new Set(attemptIds).size).toBe(1240);
    const eventIds = chunks.flatMap((c) => c.events.map((e) => e.eventId));
    expect(new Set(eventIds).size).toBe(1200);
  });

  it("keeps two events sharing one attempt together with it", () => {
    // A component answered twice against one attempt is unusual but legal, and
    // the attempt cannot be in two chunks without being counted twice.
    const source = snapshot({ pairs: 1 });
    source.events.push({ eventId: "e-extra", attemptId: "a0" } as WireEvent);
    const chunks = planGuestMergeChunks(source);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.events.map((e) => e.eventId)).toEqual(["e0", "e-extra"]);
    expect(chunks[0]?.attempts).toHaveLength(1);
  });

  it("sends an event whose attempt is missing rather than dropping it", () => {
    // Collection already drops these, so this is unreachable in practice. If one
    // ever does arrive, being refused and COUNTED as refused is more honest than
    // vanishing between the snapshot the learner was shown and the upload.
    const source = snapshot({});
    source.events.push({ eventId: "orphan", attemptId: "gone" } as WireEvent);
    const chunks = planGuestMergeChunks(source);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.events).toHaveLength(1);
    expect(chunks[0]?.attempts).toHaveLength(0);
  });

  it("is deterministic, which is what makes resume safe", () => {
    // A resumed upload skips to chunk n and must send exactly the bytes the
    // first attempt would have. Two plans of the same snapshot being equal is
    // that guarantee.
    const source = snapshot({ pairs: 2500, bookmarks: 40 });
    expect(planGuestMergeChunks(source)).toEqual(planGuestMergeChunks(source));
  });

  it("fits a maximal legal snapshot inside the chunk ceiling", () => {
    // The client's own snapshot bound allows 20,000 events, 20,000 attempts,
    // 10,000 bookmarks, 500 lists and 50 settings. Packing across kinds (500
    // attempts + 500 events fills one 1,000-item chunk exactly) fits it in ~60
    // chunks; draining each kind before starting the next needs over 100 and
    // would refuse a history the bounds explicitly allow.
    const chunks = planGuestMergeChunks(
      snapshot({ pairs: 20_000, bookmarks: 10_000, lists: 500, settings: 50 }),
    );
    expect(chunks.length).toBeLessThanOrEqual(GUEST_MERGE_BOUNDS.maxChunks);
    expect(totalOf(chunks)).toBe(50_550);
  });

  it("refuses loudly rather than truncating when the chunk ceiling is passed", () => {
    // Reaching this means the snapshot ceiling and the chunk ceiling moved out
    // of step. Silently sending the first hundred chunks would present a partial
    // history as a whole one.
    expect(() =>
      planGuestMergeChunks(
        snapshot({
          bookmarks:
            GUEST_MERGE_BOUNDS.maxChunks * GUEST_MERGE_BOUNDS.maxItemsPerChunk +
            1,
        }),
      ),
    ).toThrow(GuestMergeChunkOverflowError);
  });
});
