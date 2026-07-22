import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SafwaDb } from "@/modules/content/db";

import {
  INITIAL_SYNC_STATE,
  invalidateSyncState,
  readCursorForAccount,
  readSyncState,
  recordSyncProgress,
} from "./sync-state";

let db: SafwaDb;
let counter = 0;

beforeEach(async () => {
  db = new SafwaDb(`safwa-syncstate-test-${counter++}`);
  await db.open();
});

afterEach(async () => {
  db.close();
});

describe("client sync-state", () => {
  it("returns the initial state when nothing is stored", async () => {
    expect(await readSyncState(db)).toEqual(INITIAL_SYNC_STATE);
  });

  it("records progress and reads back the cursor for the same account", async () => {
    await recordSyncProgress(db, "user-1", 7, 1234);
    const state = await readSyncState(db);
    expect(state).toMatchObject({
      userId: "user-1",
      serverCursor: 7,
      lastSyncAt: 1234,
    });
    expect(await readCursorForAccount(db, "user-1")).toBe(7);
  });

  it("returns cursor 0 for a DIFFERENT account (account-switch guard)", async () => {
    await recordSyncProgress(db, "user-1", 7, 1234);
    // A different user must never reuse user-1's cursor.
    expect(await readCursorForAccount(db, "user-2")).toBe(0);
  });

  it("overwrites the prior account's cursor on account switch", async () => {
    await recordSyncProgress(db, "user-1", 7, 1234);
    await recordSyncProgress(db, "user-2", 3, 5678);
    expect(await readCursorForAccount(db, "user-1")).toBe(0); // no longer ours
    expect(await readCursorForAccount(db, "user-2")).toBe(3);
  });

  it("invalidateSyncState clears the context (logout)", async () => {
    await recordSyncProgress(db, "user-1", 7, 1234);
    await invalidateSyncState(db);
    expect(await readSyncState(db)).toEqual(INITIAL_SYNC_STATE);
    expect(await readCursorForAccount(db, "user-1")).toBe(0);
  });
});
