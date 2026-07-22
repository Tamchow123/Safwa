import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/db/client";
import { registerContent } from "@/db/register-content";
import {
  bookmarks,
  customListEntries,
  customLists,
  syncAuditLog,
  syncTombstones,
  userSettings,
} from "@/db/schema";
import { getActiveRelease } from "@/modules/content/server-release-registry";
import { syncCollectionsBatch } from "@/modules/sync/server/collections";
import { syncSettingsBatch } from "@/modules/sync/server/settings";
import type {
  WireBookmark,
  WireList,
  WireSetting,
} from "@/modules/sync/protocol";
import { createTestUser } from "@/tests/integration/helpers/users";

let entryA: number;
let entryB: number;

beforeAll(async () => {
  await registerContent(getDb());
  const release = await getActiveRelease();
  const ids = release.learner.entries.map((e) => e.id).sort((a, b) => a - b);
  if (ids.length < 2) throw new Error("need two entries");
  [entryA, entryB] = ids as [number, number];
});

function bookmark(overrides: Partial<WireBookmark> = {}): WireBookmark {
  return {
    entryId: entryA,
    createdAt: 1_700_000_000_000,
    deleted: false,
    ...overrides,
  };
}
function list(overrides: Partial<WireList> = {}): WireList {
  return {
    id: randomUUID(),
    name: "My List",
    entryIds: [entryA],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    deleted: false,
    ...overrides,
  };
}
function setting(overrides: Partial<WireSetting> = {}): WireSetting {
  return {
    key: "theme",
    value: "dark",
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("syncCollectionsBatch — bookmarks", () => {
  it("adds a bookmark idempotently and stamps the cursor", async () => {
    const userId = await createTestUser();
    const first = await syncCollectionsBatch(userId, [bookmark()], []);
    expect(first.results[0]).toMatchObject({ status: "accepted" });
    expect(first.serverCursor).toBe(1);
    const second = await syncCollectionsBatch(userId, [bookmark()], []);
    expect(second.results[0]?.status).toBe("accepted");

    const db = getDb();
    const rows = await db
      .select()
      .from(bookmarks)
      .where(eq(bookmarks.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entryId).toBe(entryA);
    expect(rows[0]?.lastSyncSeq).toBeGreaterThan(0);
  });

  it("rejects an unknown entry id on upsert", async () => {
    const userId = await createTestUser();
    const { results } = await syncCollectionsBatch(
      userId,
      [bookmark({ entryId: 99_999_999 })],
      [],
    );
    expect(results[0]).toMatchObject({
      status: "rejected",
      reasonCode: "unknown_entry",
    });
  });

  it("deletes a bookmark and writes a tombstone", async () => {
    const userId = await createTestUser();
    await syncCollectionsBatch(userId, [bookmark()], []);
    const { results } = await syncCollectionsBatch(
      userId,
      [bookmark({ deleted: true })],
      [],
    );
    expect(results[0]?.status).toBe("accepted");
    const db = getDb();
    const rows = await db
      .select()
      .from(bookmarks)
      .where(eq(bookmarks.userId, userId));
    expect(rows).toHaveLength(0);
    const tombs = await db
      .select()
      .from(syncTombstones)
      .where(
        and(
          eq(syncTombstones.userId, userId),
          eq(syncTombstones.kind, "bookmark"),
        ),
      );
    expect(tombs).toHaveLength(1);
    expect(tombs[0]?.ref).toBe(String(entryA));
  });

  it("re-adding a deleted bookmark clears its tombstone", async () => {
    const userId = await createTestUser();
    await syncCollectionsBatch(userId, [bookmark({ deleted: true })], []);
    await syncCollectionsBatch(userId, [bookmark()], []);
    const db = getDb();
    const tombs = await db
      .select()
      .from(syncTombstones)
      .where(eq(syncTombstones.userId, userId));
    expect(tombs).toHaveLength(0);
  });
});

describe("syncCollectionsBatch — custom lists", () => {
  it("creates a list with canonical (deduped, sorted, resolvable) membership", async () => {
    const userId = await createTestUser();
    const l = list({ entryIds: [entryB, entryA, entryA, 99_999_999] });
    const { results } = await syncCollectionsBatch(userId, [], [l]);
    expect(results[0]?.status).toBe("accepted");
    const db = getDb();
    const members = await db
      .select()
      .from(customListEntries)
      .where(eq(customListEntries.listId, l.id));
    const ids = members.map((m) => m.entryId).sort((a, b) => a - b);
    expect(ids).toEqual([entryA, entryB]); // deduped, sorted, unknown dropped
  });

  it("rejects a duplicate normalised name, audits it, and does not bump the cursor", async () => {
    const userId = await createTestUser();
    const before = await syncCollectionsBatch(
      userId,
      [],
      [list({ name: "Verbs" })],
    );
    const { results, serverCursor } = await syncCollectionsBatch(
      userId,
      [],
      [list({ name: "  verbs  " })], // normalises to the same key
    );
    expect(results[0]).toMatchObject({
      status: "rejected",
      reasonCode: "invalid_list",
    });
    // A rejected list must NOT consume a cursor value (validation before bump).
    expect(serverCursor).toBe(before.serverCursor);
    const db = getDb();
    const audits = await db
      .select()
      .from(syncAuditLog)
      .where(
        and(
          eq(syncAuditLog.userId, userId),
          eq(syncAuditLog.reasonCode, "invalid_list"),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1); // name-clash audited
  });

  it("commits valid items and rejects invalid ones in a single mixed batch", async () => {
    const userId = await createTestUser();
    const good = list({ name: "Good List" });
    const bad = list({ name: "   " }); // empty after cleaning → invalid_list
    const { results } = await syncCollectionsBatch(userId, [], [good, bad]);
    const byId = new Map(results.map((r) => [r.itemId, r]));
    expect(byId.get(good.id)?.status).toBe("accepted");
    expect(byId.get(bad.id)).toMatchObject({
      status: "rejected",
      reasonCode: "invalid_list",
    });
    const db = getDb();
    const rows = await db
      .select()
      .from(customLists)
      .where(eq(customLists.userId, userId));
    expect(rows).toHaveLength(1); // only the good one persisted
    expect(rows[0]?.id).toBe(good.id);
  });

  it("rejects touching another account's list (no cross-user access)", async () => {
    const owner = await createTestUser();
    const attacker = await createTestUser();
    const l = list();
    await syncCollectionsBatch(owner, [], [l]);
    const { results } = await syncCollectionsBatch(
      attacker,
      [],
      [list({ id: l.id, name: "Hijack" })],
    );
    expect(results[0]).toMatchObject({
      status: "rejected",
      reasonCode: "invalid_list",
    });
    const db = getDb();
    const [row] = await db
      .select()
      .from(customLists)
      .where(eq(customLists.id, l.id));
    expect(row?.userId).toBe(owner); // untouched
    expect(row?.name).toBe("My List");
  });

  it("keeps the account cursor consistent when one item's write fails mid-batch (REL-003)", async () => {
    const userId = await createTestUser();
    // Two NEW lists with the same normalised name but different ids: phase-1's
    // name-clash check reads the DB (neither exists yet) so both plan an upsert;
    // in phase 2 the first commits the name and the second hits the unique
    // (user_id, normalised_name) constraint, rolling back ONLY its savepoint —
    // while the cursor was already bumped ONCE in the outer transaction. The
    // committed row's last_sync_seq must still equal the persisted account
    // cursor (a savepoint rollback must never orphan the cursor).
    const a = list({ name: "Same Name" });
    const b = list({ name: "same name" }); // normalises identically
    const { results, serverCursor } = await syncCollectionsBatch(
      userId,
      [],
      [a, b],
    );
    const byId = new Map(results.map((r) => [r.itemId, r]));
    expect(byId.get(a.id)?.status).toBe("accepted");
    expect(byId.get(b.id)).toMatchObject({
      status: "rejected",
      reasonCode: "internal_error",
    });
    const db = getDb();
    const rows = await db
      .select()
      .from(customLists)
      .where(eq(customLists.userId, userId));
    expect(rows).toHaveLength(1); // only the first persisted
    expect(rows[0]?.lastSyncSeq).toBe(serverCursor); // cursor == committed stamp
  });

  it("deletes a list (cascading its entries) and writes a tombstone", async () => {
    const userId = await createTestUser();
    const l = list();
    await syncCollectionsBatch(userId, [], [l]);
    await syncCollectionsBatch(userId, [], [list({ id: l.id, deleted: true })]);
    const db = getDb();
    const rows = await db
      .select()
      .from(customLists)
      .where(eq(customLists.id, l.id));
    expect(rows).toHaveLength(0);
    const members = await db
      .select()
      .from(customListEntries)
      .where(eq(customListEntries.listId, l.id));
    expect(members).toHaveLength(0);
    const tombs = await db
      .select()
      .from(syncTombstones)
      .where(
        and(eq(syncTombstones.userId, userId), eq(syncTombstones.kind, "list")),
      );
    expect(tombs).toHaveLength(1);
    expect(tombs[0]?.ref).toBe(l.id);
  });
});

describe("syncSettingsBatch", () => {
  it("applies valid account settings and bumps the cursor once", async () => {
    const userId = await createTestUser();
    const { results, serverCursor } = await syncSettingsBatch(userId, [
      setting({ key: "theme", value: "dark" }),
      setting({ key: "questionCount", value: 30 }),
      setting({
        key: "timezone",
        value: { mode: "iana", name: "Europe/London" },
      }),
    ]);
    expect(results.every((r) => r.status === "accepted")).toBe(true);
    expect(serverCursor).toBe(1); // single upsert → one cursor bump
    const db = getDb();
    const [row] = await db
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, userId));
    expect(row?.theme).toBe("dark");
    expect(row?.questionCount).toBe(30);
    expect(row?.timezoneMode).toBe("iana");
    expect(row?.timezoneName).toBe("Europe/London");
    expect(row?.lastSyncSeq).toBe(1);
  });

  it("rejects an unknown setting key", async () => {
    const userId = await createTestUser();
    const { results } = await syncSettingsBatch(userId, [
      setting({ key: "adminOverride", value: true }),
    ]);
    expect(results[0]).toMatchObject({
      status: "rejected",
      reasonCode: "invalid_setting_key",
    });
    const db = getDb();
    const rows = await db
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, userId));
    expect(rows).toHaveLength(0); // nothing persisted
  });

  it("rejects an out-of-bounds value", async () => {
    const userId = await createTestUser();
    const { results } = await syncSettingsBatch(userId, [
      setting({ key: "optionCount", value: 99 }),
    ]);
    expect(results[0]).toMatchObject({
      status: "rejected",
      reasonCode: "invalid_setting_key",
    });
  });

  it("resolves a repeated key by latest updatedAt (account-wins)", async () => {
    const userId = await createTestUser();
    const { results } = await syncSettingsBatch(userId, [
      setting({ key: "theme", value: "light", updatedAt: 1_700_000_000_000 }),
      setting({ key: "theme", value: "dark", updatedAt: 1_700_000_100_000 }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual(["accepted", "duplicate"]);
    const db = getDb();
    const [row] = await db
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, userId));
    expect(row?.theme).toBe("dark"); // the later update wins
  });
});
