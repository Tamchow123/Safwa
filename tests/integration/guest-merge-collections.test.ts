/**
 * Phase 17 §16–§18 — the merge-specific collection and settings semantics.
 *
 * Every test here is written against the difference from ordinary sync, because
 * that difference is the whole slice: ordinary sync refuses a colliding list
 * name and honours a deletion, and a merge must do neither.
 */
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
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
import { currentAccountCursor } from "@/modules/sync/server/cursor";
import {
  mergeGuestBookmarks,
  mergeGuestLists,
} from "@/modules/sync/server/guest-merge-collections";
import { mergeGuestSettings } from "@/modules/sync/server/guest-merge-settings";
import { syncSettingsBatch } from "@/modules/sync/server/settings";
import type {
  WireBookmark,
  WireList,
  WireSetting,
} from "@/modules/sync/protocol";
import { createTestUser } from "@/tests/integration/helpers/users";

let entryA: number;
let entryB: number;
let entryC: number;

beforeAll(async () => {
  await registerContent(getDb());
  const release = await getActiveRelease();
  const ids = release.learner.entries.map((e) => e.id).sort((a, b) => a - b);
  if (ids.length < 3) throw new Error("need three entries");
  [entryA, entryB, entryC] = ids as [number, number, number];
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
    name: "Weak verbs",
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

/** The account's bookmarked entry ids, sorted. */
async function accountBookmarks(userId: string): Promise<number[]> {
  const rows = await getDb()
    .select({ entryId: bookmarks.entryId })
    .from(bookmarks)
    .where(eq(bookmarks.userId, userId));
  return rows.map((r) => r.entryId).sort((a, b) => a - b);
}

/** One list's membership, sorted. */
async function listMembership(listId: string): Promise<number[]> {
  const rows = await getDb()
    .select({ entryId: customListEntries.entryId })
    .from(customListEntries)
    .where(eq(customListEntries.listId, listId));
  return rows.map((r) => r.entryId).sort((a, b) => a - b);
}

async function accountLists(userId: string) {
  return getDb()
    .select({
      id: customLists.id,
      name: customLists.name,
      normalisedName: customLists.normalisedName,
    })
    .from(customLists)
    .where(eq(customLists.userId, userId));
}

describe("§16 — bookmarks merge by set union", () => {
  it("adds what the guest had and keeps what the account had", async () => {
    const userId = await createTestUser();
    // The account already bookmarked A. The guest bookmarked A and B.
    await syncCollectionsBatch(userId, [bookmark({ entryId: entryA })], []);

    const result = await mergeGuestBookmarks(userId, [
      bookmark({ entryId: entryA }),
      bookmark({ entryId: entryB }),
    ]);

    expect(result.added).toBe(1);
    expect(result.alreadyPresent).toBe(1);
    expect(result.rejected).toBe(0);
    expect(await accountBookmarks(userId)).toEqual(
      [entryA, entryB].sort((a, b) => a - b),
    );
  });

  it("never removes an account bookmark the guest lacks", async () => {
    // The single sentence §16 is most emphatic about. The guest's snapshot is
    // not a statement about what the account should stop having.
    const userId = await createTestUser();
    await syncCollectionsBatch(
      userId,
      [bookmark({ entryId: entryA }), bookmark({ entryId: entryB })],
      [],
    );

    await mergeGuestBookmarks(userId, [bookmark({ entryId: entryC })]);

    expect(await accountBookmarks(userId)).toEqual(
      [entryA, entryB, entryC].sort((a, b) => a - b),
    );
  });

  it("refuses a deletion outright rather than honouring it", async () => {
    const userId = await createTestUser();
    await syncCollectionsBatch(userId, [bookmark({ entryId: entryA })], []);

    const result = await mergeGuestBookmarks(userId, [
      bookmark({ entryId: entryA, deleted: true }),
    ]);

    expect(result.rejected).toBe(1);
    expect(result.results[0]).toMatchObject({
      status: "rejected",
      reasonCode: "malformed_item",
    });
    // And the account's bookmark is still there.
    expect(await accountBookmarks(userId)).toEqual([entryA]);
  });

  it("is a no-op on repeat: nothing added, no cursor bump", async () => {
    const userId = await createTestUser();
    const items = [
      bookmark({ entryId: entryA }),
      bookmark({ entryId: entryB }),
    ];

    const first = await mergeGuestBookmarks(userId, items);
    expect(first.added).toBe(2);
    const cursorAfterFirst = await currentAccountCursor(getDb(), userId);

    const second = await mergeGuestBookmarks(userId, items);
    expect(second.added).toBe(0);
    expect(second.alreadyPresent).toBe(2);
    expect(second.serverCursor).toBe(0); // nothing written → nothing bumped
    expect(await currentAccountCursor(getDb(), userId)).toBe(cursorAfterFirst);
  });

  it("counts a repeated entry id within one batch once (REL-001)", async () => {
    // `wireBookmarkSchema` bounds the array's length but not its uniqueness, so
    // a duplicated chunk or a corrupted local export can deliver the same entry
    // id twice. Both occurrences must not be reported as added — the summary a
    // learner is shown would then describe a write that never happened.
    const userId = await createTestUser();

    const result = await mergeGuestBookmarks(userId, [
      bookmark({ entryId: entryA }),
      bookmark({ entryId: entryA }),
      bookmark({ entryId: entryB }),
    ]);

    expect(result.added).toBe(2);
    expect(result.alreadyPresent).toBe(1);
    expect(result.results.filter((r) => r.status === "accepted")).toHaveLength(
      2,
    );
    expect(await accountBookmarks(userId)).toEqual(
      [entryA, entryB].sort((a, b) => a - b),
    );
  });

  it("rejects an entry id the active release cannot resolve", async () => {
    const userId = await createTestUser();
    const result = await mergeGuestBookmarks(userId, [
      bookmark({ entryId: 999_999 }),
    ]);
    expect(result.rejected).toBe(1);
    expect(result.results[0]).toMatchObject({ reasonCode: "unknown_entry" });
    expect(await accountBookmarks(userId)).toEqual([]);
  });

  it("clears a stale tombstone so the merged bookmark survives a pull", async () => {
    // Without this the deletion would still be in flight to a second device,
    // which would then remove the row the merge had just added.
    const userId = await createTestUser();
    await syncCollectionsBatch(userId, [bookmark({ entryId: entryA })], []);
    await syncCollectionsBatch(
      userId,
      [bookmark({ entryId: entryA, deleted: true })],
      [],
    );
    const tombstonesBefore = await getDb()
      .select({ ref: syncTombstones.ref })
      .from(syncTombstones)
      .where(
        and(
          eq(syncTombstones.userId, userId),
          eq(syncTombstones.kind, "bookmark"),
        ),
      );
    expect(tombstonesBefore).toHaveLength(1);

    await mergeGuestBookmarks(userId, [bookmark({ entryId: entryA })]);

    const tombstonesAfter = await getDb()
      .select({ ref: syncTombstones.ref })
      .from(syncTombstones)
      .where(
        and(
          eq(syncTombstones.userId, userId),
          eq(syncTombstones.kind, "bookmark"),
        ),
      );
    expect(tombstonesAfter).toEqual([]);
    expect(await accountBookmarks(userId)).toEqual([entryA]);
  });
});

describe("§17 — custom lists merge by normalised name", () => {
  it("folds a colliding name into the ACCOUNT's list and unions membership", async () => {
    const userId = await createTestUser();
    const accountList = list({ name: "Weak Verbs", entryIds: [entryA] });
    await syncCollectionsBatch(userId, [], [accountList]);

    // Same name to a normaliser, different id, different membership.
    const guestList = list({ name: "  weak verbs ", entryIds: [entryB] });
    const result = await mergeGuestLists(userId, [guestList]);

    expect(result.merged).toBe(1);
    expect(result.created).toBe(0);
    // The mapping is what lets the client re-key the guest id it still holds.
    expect(result.mappings).toEqual([
      { guestListId: guestList.id, accountListId: accountList.id },
    ]);

    const lists = await accountLists(userId);
    expect(lists).toHaveLength(1); // folded, not duplicated
    // The account's own display name survives — a merge does not rename a list
    // the learner named while signed in.
    expect(lists[0]?.name).toBe("Weak Verbs");
    expect(await listMembership(accountList.id)).toEqual(
      [entryA, entryB].sort((a, b) => a - b),
    );
  });

  it("creates a new list and keeps the guest uuid when it is free", async () => {
    const userId = await createTestUser();
    const guestList = list({ name: "Hollow verbs", entryIds: [entryA] });

    const result = await mergeGuestLists(userId, [guestList]);

    expect(result.created).toBe(1);
    // Identity mapping: the client needs no re-keying at all in this case.
    expect(result.mappings).toEqual([
      { guestListId: guestList.id, accountListId: guestList.id },
    ]);
    expect(await listMembership(guestList.id)).toEqual([entryA]);
  });

  it("mints a server id when the guest uuid belongs to another account", async () => {
    // §17: "if the UUID collides with an inaccessible or different list, create
    // a new server UUID without revealing another account's ownership."
    const other = await createTestUser();
    const contested = list({ name: "Someone else's list", entryIds: [entryA] });
    await syncCollectionsBatch(other, [], [contested]);

    const userId = await createTestUser();
    const guestList = list({
      id: contested.id,
      name: "My own list",
      entryIds: [entryB],
    });
    const result = await mergeGuestLists(userId, [guestList]);

    expect(result.created).toBe(1);
    const mapping = result.mappings[0];
    expect(mapping?.guestListId).toBe(guestList.id);
    expect(mapping?.accountListId).not.toBe(guestList.id);

    // The other account's list is untouched — same name, same membership.
    const otherLists = await accountLists(other);
    expect(otherLists).toHaveLength(1);
    expect(otherLists[0]?.name).toBe("Someone else's list");
    expect(await listMembership(contested.id)).toEqual([entryA]);
  });

  it("produces no duplicate list or membership on a repeated import", async () => {
    const userId = await createTestUser();
    const guestList = list({
      name: "Doubled verbs",
      entryIds: [entryA, entryB],
    });

    const first = await mergeGuestLists(userId, [guestList]);
    expect(first.created).toBe(1);
    const cursorAfterFirst = await currentAccountCursor(getDb(), userId);

    const second = await mergeGuestLists(userId, [guestList]);
    // The second time the name already exists, so it folds — and finds nothing
    // missing, so it writes nothing.
    expect(second.merged).toBe(1);
    expect(second.created).toBe(0);
    expect(second.results[0]).toMatchObject({ status: "duplicate" });

    expect(await accountLists(userId)).toHaveLength(1);
    expect(await listMembership(guestList.id)).toEqual(
      [entryA, entryB].sort((a, b) => a - b),
    );
    // Membership unchanged means the list row was not restamped either.
    expect(await currentAccountCursor(getDb(), userId)).toBe(cursorAfterFirst);
  });

  it("folds two guest lists whose names normalise identically into one", async () => {
    // The decisions are not independent, which is why the batch shares one
    // transaction and one in-memory name index.
    const userId = await createTestUser();
    const result = await mergeGuestLists(userId, [
      list({ name: "Sound verbs", entryIds: [entryA] }),
      list({ name: "SOUND VERBS", entryIds: [entryB] }),
    ]);

    expect(result.created).toBe(1);
    expect(result.merged).toBe(1);
    const lists = await accountLists(userId);
    expect(lists).toHaveLength(1);
    expect(await listMembership(lists[0]!.id)).toEqual(
      [entryA, entryB].sort((a, b) => a - b),
    );
    // Both guest ids map to the one surviving list, so neither is orphaned.
    expect(result.mappings.map((m) => m.accountListId)).toEqual([
      lists[0]!.id,
      lists[0]!.id,
    ]);
  });

  it("rejects an invalid list name instead of inventing one", async () => {
    const userId = await createTestUser();
    const result = await mergeGuestLists(userId, [list({ name: "   " })]);
    expect(result.rejected).toBe(1);
    expect(result.results[0]).toMatchObject({ reasonCode: "invalid_list" });
    expect(await accountLists(userId)).toEqual([]);
  });

  it("refuses a deletion, as bookmarks do", async () => {
    const userId = await createTestUser();
    const accountList = list({ name: "Keep me" });
    await syncCollectionsBatch(userId, [], [accountList]);

    const result = await mergeGuestLists(userId, [
      { ...accountList, deleted: true },
    ]);

    expect(result.rejected).toBe(1);
    expect(await accountLists(userId)).toHaveLength(1);
  });

  it("respects the per-account list cap, counting this batch's own creations", async () => {
    // MAX_LISTS is 50. Fill the account to the cap through ordinary sync, then
    // try to merge one more.
    const userId = await createTestUser();
    const existing = Array.from({ length: 50 }, (_, i) =>
      list({ name: `Account list ${i}`, entryIds: [entryA] }),
    );
    await syncCollectionsBatch(userId, [], existing);
    expect(await accountLists(userId)).toHaveLength(50);

    const result = await mergeGuestLists(userId, [
      list({ name: "One list too many", entryIds: [entryB] }),
    ]);

    expect(result.created).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.results[0]).toMatchObject({ reasonCode: "invalid_list" });
    // Refused, and reported — never silently discarded (§17).
    expect(await accountLists(userId)).toHaveLength(50);
  });

  it("narrows membership to entry ids the active release can resolve", async () => {
    const userId = await createTestUser();
    const guestList = list({
      name: "Partly stale",
      entryIds: [entryA, 999_999],
    });
    const result = await mergeGuestLists(userId, [guestList]);
    expect(result.created).toBe(1);
    expect(await listMembership(guestList.id)).toEqual([entryA]);
  });
});

describe("§18 — settings merge, account wins", () => {
  it("adopts guest settings when the account has no settings row at all", async () => {
    const userId = await createTestUser();
    // No user_settings row: nothing has ever written a preference here.
    const before = await getDb()
      .select({ userId: userSettings.userId })
      .from(userSettings)
      .where(eq(userSettings.userId, userId));
    expect(before).toEqual([]);

    const result = await mergeGuestSettings(userId, [
      setting({ key: "theme", value: "dark" }),
      setting({ key: "questionCount", value: 30 }),
    ]);

    expect(result.adopted).toBe(2);
    expect(result.keptFromAccount).toBe(0);
    const [row] = await getDb()
      .select({
        theme: userSettings.theme,
        questionCount: userSettings.questionCount,
      })
      .from(userSettings)
      .where(eq(userSettings.userId, userId));
    expect(row).toMatchObject({ theme: "dark", questionCount: 30 });
  });

  it("keeps every account value once a settings row exists", async () => {
    const userId = await createTestUser();
    // The account expressed ONE preference. That is enough to make the row
    // exist, and the row is the gap boundary — see the module note.
    await syncSettingsBatch(userId, [
      setting({ key: "theme", value: "light" }),
    ]);
    const cursorBefore = await currentAccountCursor(getDb(), userId);

    const result = await mergeGuestSettings(userId, [
      setting({ key: "theme", value: "dark" }),
      setting({ key: "questionCount", value: 30 }),
    ]);

    expect(result.adopted).toBe(0);
    expect(result.keptFromAccount).toBe(2);
    expect(result.serverCursor).toBe(0);

    const [row] = await getDb()
      .select({
        theme: userSettings.theme,
        questionCount: userSettings.questionCount,
      })
      .from(userSettings)
      .where(eq(userSettings.userId, userId));
    // The explicit account preference survives, and so does the default the
    // account never changed — guest values overwrite neither.
    expect(row).toMatchObject({ theme: "light", questionCount: 20 });
    expect(await currentAccountCursor(getDb(), userId)).toBe(cursorBefore);
  });

  it("rejects and audits a key outside the server allow-list", async () => {
    const userId = await createTestUser();
    const result = await mergeGuestSettings(userId, [
      setting({ key: "adminMode", value: true }),
    ]);

    expect(result.rejected).toBe(1);
    expect(result.adopted).toBe(0);
    expect(result.results[0]).toMatchObject({
      reasonCode: "invalid_setting_key",
    });
    const audits = await getDb()
      .select({ itemId: syncAuditLog.itemId })
      .from(syncAuditLog)
      .where(eq(syncAuditLog.userId, userId));
    expect(audits.map((a) => a.itemId)).toContain("adminMode");
    // A rejected key must not have brought a settings row into existence.
    const rows = await getDb()
      .select({ userId: userSettings.userId })
      .from(userSettings)
      .where(eq(userSettings.userId, userId));
    expect(rows).toEqual([]);
  });

  it("rejects an out-of-bounds value through the same validator as ordinary sync", async () => {
    const userId = await createTestUser();
    const result = await mergeGuestSettings(userId, [
      setting({ key: "questionCount", value: 5000 }),
    ]);
    expect(result.rejected).toBe(1);
    expect(result.adopted).toBe(0);
  });

  // ARCH-001. `user_settings` has TWO writers on two different advisory-lock
  // keys — the profile page (`hashtext(userId)`, modules/auth/account-settings.ts)
  // and ordinary sync (`hashtext(userId:settings)`, modules/sync/server/settings.ts)
  // — and `mergeGuestSettings` is the only caller whose decision depends on the
  // row NOT existing. Holding just one key would let the other writer create the
  // row between the existence check and the insert.
  //
  // Tested by HOLDING each key from another transaction and showing the merge
  // blocks on it, rather than by racing two calls: a race asserts nothing, since
  // "the account value is there afterwards" is equally consistent with the merge
  // having won and the account write having legitimately superseded it.
  for (const [label, key] of [
    ["the profile-page key", (id: string) => id],
    ["the ordinary-sync key", (id: string) => `${id}:settings`],
  ] as const) {
    it(`waits for ${label} before deciding whether a settings row exists`, async () => {
      const userId = await createTestUser();

      let releaseHolder!: () => void;
      const held = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      const holder = getDb().transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${key(userId)}), 0)`,
        );
        await held;
      });
      // Let the holder actually acquire before the merge attempts it.
      await new Promise((resolve) => setTimeout(resolve, 150));

      let settled = false;
      const merge = mergeGuestSettings(userId, [
        setting({ key: "theme", value: "dark" }),
      ]).then((value) => {
        settled = true;
        return value;
      });

      await new Promise((resolve) => setTimeout(resolve, 300));
      // Still waiting — which is only true if the merge takes THIS key.
      expect(settled).toBe(false);

      releaseHolder();
      await holder;
      const result = await merge;
      expect(result.adopted).toBe(1);
    });
  }

  it("is a no-op on repeat once the row it created exists", async () => {
    const userId = await createTestUser();
    const items = [setting({ key: "theme", value: "dark" })];

    const first = await mergeGuestSettings(userId, items);
    expect(first.adopted).toBe(1);
    const cursorAfterFirst = await currentAccountCursor(getDb(), userId);

    const second = await mergeGuestSettings(userId, items);
    expect(second.adopted).toBe(0);
    expect(second.keptFromAccount).toBe(1);
    expect(await currentAccountCursor(getDb(), userId)).toBe(cursorAfterFirst);
  });
});
