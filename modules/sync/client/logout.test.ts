import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  accountScopedTables,
  deviceAndContentTables,
  SafwaDb,
} from "@/modules/content/db";

import { clearAccountLocalState } from "./logout";
import { readSyncState, recordSyncProgress } from "./sync-state";

let db: SafwaDb;
let counter = 0;

beforeEach(async () => {
  db = new SafwaDb(`safwa-logout-test-${counter++}`);
  await db.open();
});

afterEach(() => db.close());

async function seedAccountState(): Promise<void> {
  await db.studyComponents.add({ componentKey: "c1", entryId: 1, revision: 3 });
  await db.studyAttempts.add({
    id: "a1",
    componentKey: "c1",
    sessionId: "s1",
    attemptedAt: 1,
  });
  await db.reviewEvents.add({
    eventId: "e1",
    componentKey: "c1",
    parentEventId: null,
    clientComponentRevision: 1,
    syncStatus: "accepted",
    createdAt: 1,
  });
  await db.dailyActivity.add({
    localDate: "2026-07-20",
    attempts: 1,
    reviews: 1,
    newItems: 1,
    studyMs: 100,
    derivedAt: 1,
  });
  await db.sessions.add({ id: "s1", startedAt: 1 });
  await db.bookmarks.add({ entryId: 5, createdAt: 1 });
  await db.lists.add({
    id: "l1",
    name: "Verbs",
    entryIds: [1, 2],
    createdAt: 1,
    updatedAt: 1,
  });
  await db.settings.add({ key: "theme", value: "dark", updatedAt: 1 });
  await db.mutationQueue.add({
    idempotencyKey: "m1",
    type: "x",
    payload: {},
    createdAt: 1,
  });
  await recordSyncProgress(db, "user-1", 7, 1000);
}

describe("clearAccountLocalState", () => {
  it("wipes every account-synced store and the sync cursor", async () => {
    await seedAccountState();
    await clearAccountLocalState(db);

    for (const table of [
      db.studyComponents,
      db.studyAttempts,
      db.reviewEvents,
      db.dailyActivity,
      db.sessions,
      db.bookmarks,
      db.lists,
      db.settings,
      db.mutationQueue,
    ]) {
      expect(await table.count()).toBe(0);
    }
    // The sync cursor is reset (no account, cursor 0).
    expect(await readSyncState(db)).toMatchObject({
      userId: null,
      serverCursor: 0,
    });
  });

  it("does NOT touch the device profile or the content cache", async () => {
    await db.profile.add({
      key: "device",
      deviceId: "dev-1",
      createdAt: 1,
      persistenceRequestedAt: null,
      persistenceGranted: null,
    });
    await db.contentMetadata.add({ key: "active", value: "rel-1" } as never);
    await seedAccountState();

    await clearAccountLocalState(db);

    // Device identity + content cache survive a logout.
    expect((await db.profile.get("device"))?.deviceId).toBe("dev-1");
    expect(await db.contentMetadata.count()).toBe(1);
  });

  it("is safe to call on an already-empty database (idempotent)", async () => {
    await clearAccountLocalState(db);
    await clearAccountLocalState(db);
    expect(await db.studyComponents.count()).toBe(0);
  });

  it("classifies EVERY store as account-scoped or device/content (no drift)", () => {
    // A new SafwaDb store must be classified into exactly one group; if a future
    // account-owned store isn't added to accountScopedTables it would silently
    // leak across accounts on logout — this test turns that into a failure.
    const account = accountScopedTables(db).map((t) => t.name);
    const preserved = deviceAndContentTables(db).map((t) => t.name);
    const grouped = [...account, ...preserved].sort();
    const all = db.tables.map((t) => t.name).sort();
    expect(grouped).toEqual(all);
    // The two groups are disjoint (a store is either wiped or preserved).
    expect(new Set(account).size + new Set(preserved).size).toBe(all.length);
  });
});
