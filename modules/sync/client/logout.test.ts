import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  accountScopedTables,
  deviceAndContentTables,
  ownerScopedTables,
  SafwaDb,
} from "@/modules/content/db";
import { accountOwnerKey, GUEST_OWNER_KEY } from "@/modules/content/owner-key";
import { readOwnedRows } from "@/modules/content/owner-scope";

import { clearAccountLocalState, hasGuestOwnedRows } from "./logout";
import { readSyncState, recordSyncProgress } from "./sync-state";

let db: SafwaDb;
let counter = 0;

beforeEach(async () => {
  db = new SafwaDb(`safwa-logout-test-${counter++}`);
  await db.open();
});

afterEach(() => db.close());

const ACCOUNT = "user-1";
const OTHER = "user-2";
const OTHER_KEY = accountOwnerKey(OTHER);

/** One row in every owner-scoped store, owned by `owner`, tagged with `tag`. */
async function seedOwned(owner: string | null, tag: string): Promise<void> {
  const ownerKey = owner === null ? GUEST_OWNER_KEY : accountOwnerKey(owner);
  await db.studyComponents.put({
    ownerKey,
    componentKey: `component-${tag}`,
    entryId: 1,
    revision: 3,
  });
  await db.studyAttempts.put({
    id: `attempt-${tag}`,
    ownerKey,
    componentKey: `component-${tag}`,
    sessionId: `session-${tag}`,
    attemptedAt: 1,
  });
  await db.reviewEvents.put({
    eventId: `event-${tag}`,
    ownerKey,
    componentKey: `component-${tag}`,
    parentEventId: null,
    clientComponentRevision: 1,
    syncStatus: "accepted",
    createdAt: 1,
  });
  await db.dailyActivity.put({
    ownerKey,
    localDate: "2026-07-20",
    attempts: 1,
    reviews: 1,
    newItems: 1,
    studyMs: 100,
    derivedAt: 1,
  });
  await db.sessions.put({ id: `session-${tag}`, ownerKey, startedAt: 1 });
  await db.bookmarks.put({ ownerKey, entryId: tag.length, createdAt: 1 });
  await db.lists.put({
    ownerKey,
    id: `list-${tag}`,
    name: `List ${tag}`,
    entryIds: [1, 2],
    createdAt: 1,
    updatedAt: 1,
  });
  await db.settings.put({
    ownerKey,
    key: "theme",
    value: `theme-${tag}`,
    updatedAt: 1,
  });
}

async function seedAccountState(): Promise<void> {
  await seedOwned(ACCOUNT, "acct");
  await db.mutationQueue.add({
    idempotencyKey: "m1",
    type: "x",
    payload: {},
    createdAt: 1,
    userId: ACCOUNT,
  });
  await recordSyncProgress(db, ACCOUNT, 7, 1000);
}

describe("clearAccountLocalState — scoped cleanup (phases-17.md §11)", () => {
  it("removes the departing account's rows from every owner-scoped store", async () => {
    await seedAccountState();
    await clearAccountLocalState(db, ACCOUNT);

    for (const table of ownerScopedTables(db)) {
      expect(await readOwnedRows(table, ACCOUNT)).toEqual([]);
    }
    // Its queued mutations and the sync cursor go with it.
    expect(await db.mutationQueue.count()).toBe(0);
    expect(await readSyncState(db)).toMatchObject({
      userId: null,
      serverCursor: 0,
    });
  });

  it("PRESERVES a coexisting guest's rows — the deferred merge survives sign-out", async () => {
    // This inverts the Phase-16 contract deliberately. Then, the cleanup cleared
    // whole stores and necessarily destroyed the guest's rows too — an accepted
    // data-loss trade-off, only because those stores could not tell the two
    // identities apart. Schema v7 can, and §9.1 requires that "Not now" be
    // non-destructive and that the merge stay available afterwards, so a guest
    // who defers, signs out and keeps studying must lose nothing.
    await seedOwned(null, "guest");
    await seedAccountState();

    await clearAccountLocalState(db, ACCOUNT);

    for (const table of ownerScopedTables(db)) {
      expect(await readOwnedRows(table, null)).toHaveLength(1);
    }
    expect(await hasGuestOwnedRows(db)).toBe(true);
    // The guest's own values are untouched, not merely present.
    expect((await db.settings.get([GUEST_OWNER_KEY, "theme"]))?.value).toBe(
      "theme-guest",
    );
    expect(await db.lists.get("list-guest")).toBeDefined();
    expect(await db.studyAttempts.get("attempt-guest")).toBeDefined();
  });

  it("never removes ANOTHER account's rows (no owner-filter bug)", async () => {
    await seedOwned(OTHER, "other");
    await seedAccountState();

    await clearAccountLocalState(db, ACCOUNT);

    for (const table of ownerScopedTables(db)) {
      expect(await readOwnedRows(table, OTHER)).toHaveLength(1);
    }
    expect((await db.settings.get([OTHER_KEY, "theme"]))?.value).toBe(
      "theme-other",
    );
  });

  it("removes only the departing account's queued mutations", async () => {
    await seedAccountState();
    await db.mutationQueue.add({
      idempotencyKey: "m2",
      type: "x",
      payload: {},
      createdAt: 2,
      userId: OTHER,
    });

    await clearAccountLocalState(db, ACCOUNT);

    const remaining = await db.mutationQueue.toArray();
    expect(remaining.map((row) => row.userId)).toEqual([OTHER]);
  });

  it("sweeps EVERY account owner when the departing account is unknown", async () => {
    // §11 "work when a prior write or session resolution is interrupted": if the
    // session is already gone we cannot name the departing account, so no
    // account's rows may survive — but the guest's still must.
    await seedOwned(null, "guest");
    await seedOwned(ACCOUNT, "acct");
    await seedOwned(OTHER, "other");
    await db.mutationQueue.add({
      idempotencyKey: "m1",
      type: "x",
      payload: {},
      createdAt: 1,
      userId: ACCOUNT,
    });

    await clearAccountLocalState(db);

    for (const table of ownerScopedTables(db)) {
      expect(await readOwnedRows(table, ACCOUNT)).toEqual([]);
      expect(await readOwnedRows(table, OTHER)).toEqual([]);
      expect(await readOwnedRows(table, null)).toHaveLength(1);
    }
    expect(await db.mutationQueue.count()).toBe(0);
    expect(await hasGuestOwnedRows(db)).toBe(true);
  });

  it("ABORTS the whole sweep when one store's delete fails (no silent partial clear)", async () => {
    // The sweep branch is the confidentiality backstop for an unresolvable
    // session, so a failing store must never be swallowed: catching it would
    // let Dexie treat the delete as recovered and commit the OTHER stores'
    // deletes, leaving that store's account rows behind while the caller was
    // told the cleanup succeeded.
    await seedOwned(null, "guest");
    await seedOwned(ACCOUNT, "acct");

    const failing = vi
      .spyOn(db.bookmarks, "filter")
      .mockImplementation((): never => {
        throw new Error("simulated store failure");
      });
    try {
      await expect(clearAccountLocalState(db)).rejects.toThrow();
    } finally {
      failing.mockRestore();
    }

    // Nothing was removed — the transaction rolled back as a unit.
    expect(await readOwnedRows(db.settings, ACCOUNT)).toHaveLength(1);
    expect(await readOwnedRows(db.reviewEvents, ACCOUNT)).toHaveLength(1);
    expect(await readOwnedRows(db.settings, null)).toHaveLength(1);
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

    await clearAccountLocalState(db, ACCOUNT);

    // Device identity + content cache survive a sign-out.
    expect((await db.profile.get("device"))?.deviceId).toBe("dev-1");
    expect(await db.contentMetadata.count()).toBe(1);
  });

  it("is safe to call on an already-empty database (idempotent)", async () => {
    await clearAccountLocalState(db, ACCOUNT);
    await clearAccountLocalState(db, ACCOUNT);
    await clearAccountLocalState(db);
    expect(await db.studyComponents.count()).toBe(0);
  });

  it("leaves nothing behind when a second account signs in afterwards", async () => {
    await seedAccountState();
    await clearAccountLocalState(db, ACCOUNT);
    // The next account writes its own rows and can read only those.
    await seedOwned(OTHER, "other");
    expect(await readOwnedRows(db.settings, OTHER)).toHaveLength(1);
    expect(await readOwnedRows(db.settings, ACCOUNT)).toEqual([]);
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
    // The two groups are disjoint (a store is either cleaned or preserved).
    expect(new Set(account).size + new Set(preserved).size).toBe(all.length);
  });

  it("owner-scoped tables are exactly the account-scoped ones minus queue/cursor", () => {
    // The two groupings must stay in lock-step: every private store is
    // owner-scoped, and the only account-owned stores that are NOT are the
    // outbound queue and the sync cursor (which carry an account userId).
    const owned = ownerScopedTables(db).map((t) => t.name);
    const account = accountScopedTables(db).map((t) => t.name);
    expect(account.filter((name) => !owned.includes(name)).sort()).toEqual([
      "mutation_queue",
      "sync_state",
    ]);
  });
});

describe("hasGuestOwnedRows", () => {
  it("is false on a device with no guest data and true once any exists", async () => {
    expect(await hasGuestOwnedRows(db)).toBe(false);
    await seedOwned(ACCOUNT, "acct");
    expect(await hasGuestOwnedRows(db)).toBe(false);
    await db.bookmarks.put({
      ownerKey: GUEST_OWNER_KEY,
      entryId: 42,
      createdAt: 1,
    });
    expect(await hasGuestOwnedRows(db)).toBe(true);
  });
});
