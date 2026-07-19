/**
 * Analytics persistence adapter (Phase 12 §14–15): one consistent snapshot
 * read, atomic daily_activity rebuild, cache-corruption recovery, and the
 * authority model (raw attempts/events stay untouched; the cache is never
 * the only copy of activity).
 */
import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SafwaDb } from "@/modules/content/db";
import {
  readAnalyticsSnapshot,
  rebuildDailyActivity,
} from "@/modules/analytics/persistence";

let dbCounter = 0;
let db: SafwaDb;

beforeEach(() => {
  dbCounter += 1;
  db = new SafwaDb(`safwa-analytics-persistence-test-${dbCounter}`);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete();
});

const NOW = 1_784_000_000_000;
const KEY = "entry:1:skill:bab_identification";

let rowCounter = 0;

/** Seed one full attempt row (embedded payload fields analytics consumes). */
async function seedAttempt(
  overrides: {
    id?: string;
    localDateAtEvent?: string;
    responseTimeMs?: number;
    omitPayload?: boolean;
  } = {},
): Promise<string> {
  rowCounter += 1;
  const id = overrides.id ?? `attempt-${rowCounter}`;
  await db.studyAttempts.put({
    id,
    componentKey: KEY,
    sessionId: "session-1",
    attemptedAt: NOW,
    ...(overrides.omitPayload
      ? {}
      : {
          attempt: {
            localDateAtEvent: overrides.localDateAtEvent ?? "2026-07-17",
            responseTimeMs: overrides.responseTimeMs ?? 1500,
            // Only the fields the analytics slice reads are relevant here;
            // the cast keeps the fixture honest about being a partial row.
          } as never,
        }),
  });
  return id;
}

/** Seed one review-event row (scheduling lineage fields analytics consumes). */
async function seedEvent(
  overrides: {
    eventId?: string;
    attemptId?: string;
    parentEventId?: string | null;
    status?: string;
    syncStatus?: "local" | "pushed" | "accepted" | "demoted" | "rejected";
    localDateAtEvent?: string;
  } = {},
): Promise<string> {
  rowCounter += 1;
  const eventId = overrides.eventId ?? `event-${rowCounter}`;
  await db.reviewEvents.put({
    eventId,
    componentKey: KEY,
    parentEventId:
      overrides.parentEventId === undefined ? null : overrides.parentEventId,
    clientComponentRevision: 1,
    syncStatus: overrides.syncStatus ?? "local",
    createdAt: NOW,
    attemptId: overrides.attemptId,
    status: (overrides.status ?? "scheduling") as never,
    localDateAtEvent: overrides.localDateAtEvent ?? "2026-07-17",
  });
  return eventId;
}

describe("rebuildDailyActivity (§14.3, §14.5)", () => {
  it("derives rows from the raw stores and stamps derivedAt", async () => {
    await seedAttempt({ responseTimeMs: 1000 });
    await seedAttempt({ responseTimeMs: 500 });
    await seedEvent({ parentEventId: null });

    const derived = await rebuildDailyActivity(db, NOW);
    expect(derived).toEqual([
      {
        localDate: "2026-07-17",
        attempts: 2,
        reviews: 0,
        newItems: 1,
        studyMs: 1500,
      },
    ]);
    expect(await db.dailyActivity.toArray()).toEqual([
      { ...derived[0], derivedAt: NOW },
    ]);
  });

  it("replaces incorrect counts and removes extra/stale rows", async () => {
    await seedAttempt();
    // A corrupted cache row for the real date and a fabricated extra date.
    await db.dailyActivity.put({
      localDate: "2026-07-17",
      attempts: 999,
      reviews: 999,
      newItems: 999,
      studyMs: 999_999,
      derivedAt: 1,
    });
    await db.dailyActivity.put({
      localDate: "2001-01-01",
      attempts: 5,
      reviews: 5,
      newItems: 5,
      studyMs: 5,
      derivedAt: 1,
    });

    await rebuildDailyActivity(db, NOW);
    const rows = await db.dailyActivity.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      localDate: "2026-07-17",
      attempts: 1,
      studyMs: 1500,
    });
  });

  it("reconstructs an empty or deleted cache from the raw truth", async () => {
    await seedAttempt();
    await rebuildDailyActivity(db, NOW);
    await db.dailyActivity.clear(); // "delete the cache"
    const derived = await rebuildDailyActivity(db, NOW + 1);
    expect(derived).toHaveLength(1);
    expect(await db.dailyActivity.count()).toBe(1);
  });

  it("reflects an undo (deleted attempt + event) after rebuild", async () => {
    const keptAttempt = await seedAttempt();
    const undoneAttempt = await seedAttempt();
    await seedEvent({ attemptId: keptAttempt, parentEventId: null });
    const undoneEvent = await seedEvent({
      attemptId: undoneAttempt,
      parentEventId: "root",
    });
    const before = await rebuildDailyActivity(db, NOW);
    expect(before[0]).toMatchObject({ attempts: 2, newItems: 1, reviews: 1 });

    // The undo path deletes the event and the attempt from the raw stores.
    await db.reviewEvents.delete(undoneEvent);
    await db.studyAttempts.delete(undoneAttempt);
    const after = await rebuildDailyActivity(db, NOW + 1);
    expect(after[0]).toMatchObject({ attempts: 1, newItems: 1, reviews: 0 });
  });

  it("never modifies the raw attempt/event rows", async () => {
    await seedAttempt();
    await seedEvent({ parentEventId: null });
    const attemptsBefore = await db.studyAttempts.toArray();
    const eventsBefore = await db.reviewEvents.toArray();
    await rebuildDailyActivity(db, NOW);
    expect(await db.studyAttempts.toArray()).toEqual(attemptsBefore);
    expect(await db.reviewEvents.toArray()).toEqual(eventsBefore);
  });

  it("a failed rebuild rolls back atomically to the previous cache", async () => {
    await seedAttempt();
    await rebuildDailyActivity(db, NOW);
    const before = await db.dailyActivity.toArray();
    expect(before).toHaveLength(1);

    await seedAttempt(); // raw truth changes…
    // …but the rewrite fails mid-transaction: the clear must roll back too.
    vi.spyOn(db.dailyActivity, "bulkPut").mockRejectedValueOnce(
      new Error("simulated write failure"),
    );
    await expect(rebuildDailyActivity(db, NOW + 1)).rejects.toThrow(
      "simulated write failure",
    );
    expect(await db.dailyActivity.toArray()).toEqual(before);
  });
});

describe("readAnalyticsSnapshot (§15)", () => {
  it("returns components, attempts, events and REBUILT daily activity", async () => {
    await db.studyComponents.put({
      componentKey: KEY,
      entryId: 1,
      learnerState: "learning",
    });
    const attemptId = await seedAttempt();
    await seedEvent({ attemptId, parentEventId: null });

    const snapshot = await readAnalyticsSnapshot(db, NOW);
    expect(snapshot.components).toEqual([
      { componentKey: KEY, fsrs: undefined, learnerState: "learning" },
    ]);
    expect(snapshot.attempts).toEqual([
      {
        id: attemptId,
        componentKey: KEY,
        localDateAtEvent: "2026-07-17",
        responseTimeMs: 1500,
      },
    ]);
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]).toMatchObject({
      attemptId,
      parentEventId: null,
      status: "scheduling",
      syncStatus: "local",
      localDateAtEvent: "2026-07-17",
    });
    expect(snapshot.dailyActivity).toEqual([
      {
        localDate: "2026-07-17",
        attempts: 1,
        reviews: 0,
        newItems: 1,
        studyMs: 1500,
      },
    ]);
    // The cache store now matches the snapshot (rebuilt in the same txn).
    expect(await db.dailyActivity.count()).toBe(1);
  });

  it("a payload-less legacy attempt row maps to an invalid slice and no activity", async () => {
    await seedAttempt({ omitPayload: true });
    const snapshot = await readAnalyticsSnapshot(db, NOW);
    expect(snapshot.attempts[0].localDateAtEvent).toBeNull();
    expect(Number.isNaN(snapshot.attempts[0].responseTimeMs)).toBe(true);
    expect(snapshot.dailyActivity).toEqual([]);
  });

  it("a failed snapshot cache-write also rolls back atomically", async () => {
    // The dashboard's read path shares the ONE cache writer with
    // rebuildDailyActivity — a failure there must leave the previous cache
    // intact for the snapshot path too.
    await seedAttempt();
    await rebuildDailyActivity(db, NOW);
    const before = await db.dailyActivity.toArray();

    await seedAttempt();
    vi.spyOn(db.dailyActivity, "bulkPut").mockRejectedValueOnce(
      new Error("simulated snapshot write failure"),
    );
    await expect(readAnalyticsSnapshot(db, NOW + 1)).rejects.toThrow(
      "simulated snapshot write failure",
    );
    expect(await db.dailyActivity.toArray()).toEqual(before);
  });

  it("never trusts a corrupted cache row over the raw truth (§14.2)", async () => {
    await seedAttempt();
    await db.dailyActivity.put({
      localDate: "2026-07-17",
      attempts: 42,
      reviews: 42,
      newItems: 42,
      studyMs: 42,
      derivedAt: 1,
    });
    const snapshot = await readAnalyticsSnapshot(db, NOW);
    expect(snapshot.dailyActivity[0]).toMatchObject({
      attempts: 1,
      studyMs: 1500,
    });
    expect(await db.dailyActivity.get("2026-07-17")).toMatchObject({
      attempts: 1,
    });
  });
});
