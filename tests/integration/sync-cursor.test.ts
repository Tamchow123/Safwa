import { describe, expect, it } from "vitest";

import { getDb } from "@/db/client";
import {
  currentAccountCursor,
  nextAccountCursor,
} from "@/modules/sync/server/cursor";
import { createTestUser } from "@/tests/integration/helpers/users";

/**
 * Phase 16 account-wide sync-cursor integration suite. Proves the monotonic
 * per-account cursor upserts from 0, increments deterministically, and is
 * readable independently.
 */
describe("account sync cursor", () => {
  it("reads 0 for an account that has never synced", async () => {
    const db = getDb();
    const userId = await createTestUser();
    expect(await currentAccountCursor(db, userId)).toBe(0);
  });

  it("increments monotonically from 1 on each bump and is durably readable", async () => {
    const db = getDb();
    const userId = await createTestUser();

    const first = await db.transaction((tx) => nextAccountCursor(tx, userId));
    const second = await db.transaction((tx) => nextAccountCursor(tx, userId));
    const third = await db.transaction((tx) => nextAccountCursor(tx, userId));

    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(third).toBe(3);
    expect(await currentAccountCursor(db, userId)).toBe(3);
  });

  it("serialises concurrent bumps for the same account into distinct values", async () => {
    const db = getDb();
    const userId = await createTestUser();
    // Two overlapping transactions race on the same account; the ON CONFLICT
    // row lock must serialise them into {1, 2}, never two 1s.
    const [a, b] = await Promise.all([
      db.transaction((tx) => nextAccountCursor(tx, userId)),
      db.transaction((tx) => nextAccountCursor(tx, userId)),
    ]);
    expect(new Set([a, b])).toEqual(new Set([1, 2]));
    expect(await currentAccountCursor(db, userId)).toBe(2);
  });

  it("keeps cursors independent per account", async () => {
    const db = getDb();
    const userA = await createTestUser();
    const userB = await createTestUser();

    await db.transaction((tx) => nextAccountCursor(tx, userA));
    await db.transaction((tx) => nextAccountCursor(tx, userA));
    await db.transaction((tx) => nextAccountCursor(tx, userB));

    expect(await currentAccountCursor(db, userA)).toBe(2);
    expect(await currentAccountCursor(db, userB)).toBe(1);
  });
});
