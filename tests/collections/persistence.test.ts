/**
 * Dexie persistence adapter for bookmarks and custom lists (Phase 14,
 * docs/phases/phases-14.md sections 9/28) — fake-indexeddb backed.
 */
import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SAFWA_DB_VERSION, SafwaDb } from "@/modules/content/db";
import {
  addEntryToList,
  createList,
  createListWithEntry,
  DuplicateListNameError,
  deleteList,
  InvalidListNameError,
  isBookmarked,
  ListNotFoundError,
  MaxListsExceededError,
  readCollections,
  removeEntryFromList,
  renameList,
  setBookmarked,
  toggleBookmark,
  UnknownEntryIdError,
} from "@/modules/collections/persistence";
import { peekDeviceProfile } from "@/modules/profile/device";
import { accountOwnerKey, GUEST_OWNER_KEY } from "@/modules/content/owner-key";

const ensureDurableGuestStateSpy = vi.fn(async () => ({ deviceId: "dev-1" }));

vi.mock("@/modules/profile/persistence", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/profile/persistence")>();
  return {
    ...original,
    ensureDurableGuestState: (
      ...args: Parameters<typeof ensureDurableGuestStateSpy>
    ) => ensureDurableGuestStateSpy(...args),
  };
});

const KNOWN = new Set([1, 2, 7, 9, 262, 275]);

let dbCounter = 0;
let db: SafwaDb;

beforeEach(() => {
  dbCounter += 1;
  db = new SafwaDb(`safwa-collections-test-${dbCounter}`);
  ensureDurableGuestStateSpy.mockClear();
});

afterEach(async () => {
  await db.delete();
});

describe("readCollections / isBookmarked", () => {
  it("returns an empty snapshot when nothing is stored", async () => {
    expect(await readCollections(db, null)).toEqual({
      bookmarks: [],
      lists: [],
    });
    expect(await isBookmarked(db, 1, null)).toBe(false);
  });

  it("reads a consistent snapshot of both stores", async () => {
    await db.bookmarks.add({
      ownerKey: GUEST_OWNER_KEY,
      entryId: 7,
      createdAt: 1,
    });
    await db.lists.add({
      ownerKey: GUEST_OWNER_KEY,
      id: "list-1",
      name: "Verbs",
      entryIds: [7],
      createdAt: 1,
      updatedAt: 1,
    });
    const snapshot = await readCollections(db, null);
    expect(snapshot.bookmarks).toEqual([
      { ownerKey: GUEST_OWNER_KEY, entryId: 7, createdAt: 1 },
    ]);
    expect(snapshot.lists).toHaveLength(1);
  });

  it("a passive read never mints a device profile", async () => {
    await readCollections(db, null);
    await isBookmarked(db, 7, null);
    expect(await peekDeviceProfile(db)).toBeNull();
    expect(ensureDurableGuestStateSpy).not.toHaveBeenCalled();
  });
});

describe("owner scoping (R2-F3)", () => {
  const ACCOUNT = "user-1";

  it("a signed-in account never sees a pre-login guest's bookmarks or lists", async () => {
    // Guest state created before login (owner null).
    await setBookmarked(db, 7, true, KNOWN, 1, null);
    await createList(db, { name: "Guest list", now: 1, owner: null });
    // Account state (owner ACCOUNT), e.g. from a pull or a signed-in write.
    await setBookmarked(db, 9, true, KNOWN, 2, ACCOUNT);
    await createList(db, { name: "Account list", now: 2, owner: ACCOUNT });

    const asAccount = await readCollections(db, ACCOUNT);
    expect(asAccount.bookmarks.map((b) => b.entryId)).toEqual([9]);
    expect(asAccount.lists.map((l) => l.name)).toEqual(["Account list"]);
    expect(await isBookmarked(db, 7, ACCOUNT)).toBe(false); // guest's, hidden
    expect(await isBookmarked(db, 9, ACCOUNT)).toBe(true);

    const asGuest = await readCollections(db, null);
    expect(asGuest.bookmarks.map((b) => b.entryId)).toEqual([7]);
    expect(asGuest.lists.map((l) => l.name)).toEqual(["Guest list"]);
    expect(await isBookmarked(db, 9, null)).toBe(false); // account's, hidden
  });

  it("a guest list name never blocks the account creating the same name", async () => {
    await createList(db, { name: "Verbs", now: 1, owner: null });
    // Same name, different owner — must not collide (owner-scoped uniqueness).
    await expect(
      createList(db, { name: "Verbs", now: 2, owner: ACCOUNT }),
    ).resolves.toMatchObject({
      name: "Verbs",
      ownerKey: accountOwnerKey(ACCOUNT),
    });
  });

  it("the max-lists cap counts only the owner's own lists", async () => {
    for (let i = 0; i < 50; i += 1) {
      await createList(db, { name: `Guest ${i}`, now: i, owner: null });
    }
    // The guest is at the cap, but the account's own count is 0.
    await expect(
      createList(db, { name: "Account first", now: 100, owner: ACCOUNT }),
    ).resolves.toMatchObject({ ownerKey: accountOwnerKey(ACCOUNT) });
  });

  it("an account cannot rename or delete a guest-owned list (not-found from its view)", async () => {
    const guestList = await createList(db, {
      name: "Guest only",
      now: 1,
      owner: null,
    });
    await expect(
      renameList(db, guestList.id, "Hijacked", 2, ACCOUNT),
    ).rejects.toThrow(ListNotFoundError);
    await expect(deleteList(db, guestList.id, 3, ACCOUNT)).rejects.toThrow(
      ListNotFoundError,
    );
    // The guest's list is untouched.
    expect((await db.lists.get(guestList.id))?.name).toBe("Guest only");
  });

  it("a signed-in bookmark write is keyed to the account (so it syncs as theirs)", async () => {
    await setBookmarked(db, 7, true, KNOWN, 1, ACCOUNT);
    expect(
      (await db.bookmarks.get([accountOwnerKey(ACCOUNT), 7]))?.ownerKey,
    ).toBe(accountOwnerKey(ACCOUNT));
  });

  it("a guest bookmark and an account bookmark for the SAME entry coexist (§10)", async () => {
    // The Phase 16 limitation this phase removes: an account write could
    // physically replace the guest's row for the same natural key.
    await setBookmarked(db, 7, true, KNOWN, 1, null);
    await setBookmarked(db, 7, true, KNOWN, 2, ACCOUNT);
    expect(await isBookmarked(db, 7, null)).toBe(true);
    expect(await isBookmarked(db, 7, ACCOUNT)).toBe(true);
    expect(await db.bookmarks.count()).toBe(2);
    // Each keeps its OWN createdAt — neither overwrote the other.
    expect((await db.bookmarks.get([GUEST_OWNER_KEY, 7]))?.createdAt).toBe(1);
    expect(
      (await db.bookmarks.get([accountOwnerKey(ACCOUNT), 7]))?.createdAt,
    ).toBe(2);
    // Removing the account's leaves the guest's intact.
    await setBookmarked(db, 7, false, KNOWN, 3, ACCOUNT);
    expect(await isBookmarked(db, 7, null)).toBe(true);
    expect(await isBookmarked(db, 7, ACCOUNT)).toBe(false);
  });
});

describe("setBookmarked / toggleBookmark", () => {
  it("adds and removes a bookmark", async () => {
    await setBookmarked(db, 7, true, KNOWN, 100, null);
    expect(await isBookmarked(db, 7, null)).toBe(true);
    await setBookmarked(db, 7, false, KNOWN, 200, null);
    expect(await isBookmarked(db, 7, null)).toBe(false);
  });

  it("adding is idempotent", async () => {
    await setBookmarked(db, 7, true, KNOWN, 100, null);
    await setBookmarked(db, 7, true, KNOWN, 200, null);
    const rows = await db.bookmarks.toArray();
    expect(rows).toEqual([
      { ownerKey: GUEST_OWNER_KEY, entryId: 7, createdAt: 100 },
    ]);
  });

  it("toggle flips state and returns the new state", async () => {
    expect(await toggleBookmark(db, 7, KNOWN, 100, null)).toBe(true);
    expect(await toggleBookmark(db, 7, KNOWN, 200, null)).toBe(false);
  });

  it("rapid double-toggle from empty nets back to not-bookmarked (no lost update)", async () => {
    const [first, second] = await Promise.all([
      toggleBookmark(db, 7, KNOWN, 100, null),
      toggleBookmark(db, 7, KNOWN, 101, null),
    ]);
    // IndexedDB serialises overlapping rw transactions on the same store,
    // and each toggle re-reads inside its own transaction, so two toggles
    // from an empty start always net back to "not bookmarked" regardless
    // of submission order — never a lost update leaving it bookmarked.
    expect(first).not.toBe(second);
    expect(await isBookmarked(db, 7, null)).toBe(false);
  });

  it("rejects an entry id outside the active release", async () => {
    await expect(setBookmarked(db, 999, true, KNOWN, 1, null)).rejects.toThrow(
      UnknownEntryIdError,
    );
    expect(await db.bookmarks.count()).toBe(0);
  });

  it("removing an unknown entry id is allowed (never blocks cleanup)", async () => {
    await expect(
      setBookmarked(db, 999, false, KNOWN, 1, null),
    ).resolves.toBeUndefined();
  });

  it("keeps protected duplicate entries as independent bookmarks", async () => {
    await setBookmarked(db, 262, true, KNOWN, 1, null);
    await setBookmarked(db, 275, true, KNOWN, 2, null);
    expect(await isBookmarked(db, 262, null)).toBe(true);
    expect(await isBookmarked(db, 275, null)).toBe(true);
    await setBookmarked(db, 262, false, KNOWN, 3, null);
    expect(await isBookmarked(db, 262, null)).toBe(false);
    expect(await isBookmarked(db, 275, null)).toBe(true);
  });

  it("calls the durable guest-state boundary at the user action", async () => {
    await setBookmarked(db, 7, true, KNOWN, 1, null);
    expect(ensureDurableGuestStateSpy).toHaveBeenCalledTimes(1);
  });

  it("a rejected bookmark write persists no row (the single write never lands)", async () => {
    const spy = vi
      .spyOn(db.bookmarks, "put")
      .mockRejectedValueOnce(new Error("simulated write failure"));
    await expect(setBookmarked(db, 7, true, KNOWN, 1, null)).rejects.toThrow();
    expect(await db.bookmarks.count()).toBe(0);
    spy.mockRestore();
  });
});

describe("createList / createListWithEntry", () => {
  it("creates an empty list", async () => {
    const list = await createList(db, {
      name: "Difficult Verbs",
      now: 1,
      owner: null,
    });
    expect(list.entryIds).toEqual([]);
    expect(list.createdAt).toBe(1);
    expect(list.updatedAt).toBe(1);
    expect(typeof list.id).toBe("string");
  });

  it("creates a list and adds its first entry atomically", async () => {
    const list = await createListWithEntry(db, {
      name: "Verbs",
      entryId: 7,
      knownEntryIds: KNOWN,
      now: 1,
      owner: null,
    });
    expect(list.entryIds).toEqual([7]);
    const stored = await db.lists.get(list.id);
    expect(stored?.entryIds).toEqual([7]);
  });

  it("rejects an unknown entry id for createListWithEntry, writing nothing", async () => {
    await expect(
      createListWithEntry(db, {
        name: "Verbs",
        entryId: 999,
        knownEntryIds: KNOWN,
        now: 1,
        owner: null,
      }),
    ).rejects.toThrow(UnknownEntryIdError);
    expect(await db.lists.count()).toBe(0);
  });

  it("rejects a duplicate normalised name", async () => {
    await createList(db, { name: "Difficult Verbs", now: 1, owner: null });
    await expect(
      createList(db, { name: "difficult   verbs", now: 2, owner: null }),
    ).rejects.toThrow(DuplicateListNameError);
    expect(await db.lists.count()).toBe(1);
  });

  it("rejects an invalid name", async () => {
    await expect(
      createList(db, { name: "   ", now: 1, owner: null }),
    ).rejects.toThrow(InvalidListNameError);
  });

  it("enforces the max-lists policy", async () => {
    for (let i = 0; i < 50; i += 1) {
      await createList(db, { name: `List ${i}`, now: i, owner: null });
    }
    await expect(
      createList(db, { name: "One too many", now: 1000, owner: null }),
    ).rejects.toThrow(MaxListsExceededError);
    expect(await db.lists.count()).toBe(50);
  });

  it("a rejected create-list-with-entry write persists no row and leaves other lists untouched", async () => {
    const other = await createList(db, { name: "Other", now: 0, owner: null });
    const spy = vi
      .spyOn(db.lists, "add")
      .mockRejectedValueOnce(new Error("simulated write failure"));
    await expect(
      createListWithEntry(db, {
        name: "Verbs",
        entryId: 7,
        knownEntryIds: KNOWN,
        now: 1,
        owner: null,
      }),
    ).rejects.toThrow();
    // No half-created row (the single add() never landed) and the
    // pre-existing, unrelated list survives the failed attempt untouched.
    expect(await db.lists.count()).toBe(1);
    expect(await db.lists.get(other.id)).toEqual(other);
    spy.mockRestore();
  });

  it("calls the durable guest-state boundary", async () => {
    await createList(db, { name: "Verbs", now: 1, owner: null });
    expect(ensureDurableGuestStateSpy).toHaveBeenCalledTimes(1);
  });
});

describe("renameList", () => {
  it("renames and bumps updatedAt, preserving createdAt", async () => {
    const list = await createList(db, {
      name: "Old name",
      now: 1,
      owner: null,
    });
    const renamed = await renameList(db, list.id, "New name", 2, null);
    expect(renamed.name).toBe("New name");
    expect(renamed.createdAt).toBe(1);
    expect(renamed.updatedAt).toBe(2);
  });

  it("rejects a collision with another list's normalised name", async () => {
    await createList(db, { name: "Taken", now: 1, owner: null });
    const other = await createList(db, { name: "Other", now: 2, owner: null });
    await expect(renameList(db, other.id, "taken", 3, null)).rejects.toThrow(
      DuplicateListNameError,
    );
  });

  it("allows renaming to its own equivalent normalised name", async () => {
    const list = await createList(db, {
      name: "Difficult Verbs",
      now: 1,
      owner: null,
    });
    await expect(
      renameList(db, list.id, "difficult   verbs", 2, null),
    ).resolves.toMatchObject({ name: "difficult verbs" });
  });

  it("throws for an unknown list id", async () => {
    await expect(
      renameList(db, "missing", "New name", 1, null),
    ).rejects.toThrow(ListNotFoundError);
  });

  it("rename followed immediately by another rename settles on the later intent", async () => {
    const list = await createList(db, {
      name: "Original",
      now: 1,
      owner: null,
    });
    await Promise.all([
      renameList(db, list.id, "First rename", 2, null),
      renameList(db, list.id, "Second rename", 3, null),
    ]);
    const stored = await db.lists.get(list.id);
    // IndexedDB serialises overlapping rw transactions in submission order;
    // each rename re-reads inside its own transaction, so the later
    // submitted rename's name is the one that survives.
    expect(stored?.name).toBe("Second rename");
  });
});

describe("deleteList", () => {
  it("removes exactly the selected list", async () => {
    const a = await createList(db, { name: "A", now: 1, owner: null });
    const b = await createList(db, { name: "B", now: 2, owner: null });
    await deleteList(db, a.id);
    expect(await db.lists.get(a.id)).toBeUndefined();
    expect(await db.lists.get(b.id)).toBeDefined();
  });

  it("does not affect bookmarks", async () => {
    const list = await createListWithEntry(db, {
      name: "Verbs",
      entryId: 7,
      knownEntryIds: KNOWN,
      now: 1,
      owner: null,
    });
    await setBookmarked(db, 7, true, KNOWN, 2, null);
    await deleteList(db, list.id);
    expect(await isBookmarked(db, 7, null)).toBe(true);
  });

  it("throws for an unknown list id", async () => {
    await expect(deleteList(db, "missing")).rejects.toThrow(ListNotFoundError);
  });
});

describe("addEntryToList / removeEntryFromList", () => {
  it("adds and removes an entry", async () => {
    const list = await createList(db, { name: "Verbs", now: 1, owner: null });
    const withEntry = await addEntryToList(db, list.id, 7, KNOWN, 2, null);
    expect(withEntry.entryIds).toEqual([7]);
    const withoutEntry = await removeEntryFromList(db, list.id, 7, 3, null);
    expect(withoutEntry.entryIds).toEqual([]);
  });

  it("adding a duplicate entry is idempotent", async () => {
    const list = await createList(db, { name: "Verbs", now: 1, owner: null });
    await addEntryToList(db, list.id, 7, KNOWN, 2, null);
    const again = await addEntryToList(db, list.id, 7, KNOWN, 3, null);
    expect(again.entryIds).toEqual([7]);
  });

  it("removing a missing entry is idempotent", async () => {
    const list = await createList(db, { name: "Verbs", now: 1, owner: null });
    const result = await removeEntryFromList(db, list.id, 999, 2, null);
    expect(result.entryIds).toEqual([]);
  });

  it("membership stays sorted and unique after every write", async () => {
    const list = await createList(db, { name: "Verbs", now: 1, owner: null });
    await addEntryToList(db, list.id, 9, KNOWN, 2, null);
    await addEntryToList(db, list.id, 2, KNOWN, 3, null);
    const final = await addEntryToList(db, list.id, 7, KNOWN, 4, null);
    expect(final.entryIds).toEqual([2, 7, 9]);
  });

  it("rejects an unknown entry id", async () => {
    const list = await createList(db, { name: "Verbs", now: 1, owner: null });
    await expect(
      addEntryToList(db, list.id, 999, KNOWN, 2, null),
    ).rejects.toThrow(UnknownEntryIdError);
  });

  it("throws for an unknown list id", async () => {
    await expect(
      addEntryToList(db, "missing", 7, KNOWN, 1, null),
    ).rejects.toThrow(ListNotFoundError);
    await expect(
      removeEntryFromList(db, "missing", 7, 1, null),
    ).rejects.toThrow(ListNotFoundError);
  });

  it("two rapid membership changes both land (no lost update)", async () => {
    const list = await createList(db, { name: "Verbs", now: 1, owner: null });
    await Promise.all([
      addEntryToList(db, list.id, 2, KNOWN, 2, null),
      addEntryToList(db, list.id, 7, KNOWN, 3, null),
    ]);
    const stored = await db.lists.get(list.id);
    expect(stored?.entryIds).toEqual([2, 7]);
  });

  it("a list can hold both members of a protected duplicate group; removing one preserves the other", async () => {
    const list = await createList(db, { name: "Verbs", now: 1, owner: null });
    await addEntryToList(db, list.id, 262, KNOWN, 2, null);
    await addEntryToList(db, list.id, 275, KNOWN, 3, null);
    const afterRemove = await removeEntryFromList(db, list.id, 262, 4, null);
    expect(afterRemove.entryIds).toEqual([275]);
  });

  it("unrelated lists and bookmarks are preserved by a membership write", async () => {
    const target = await createList(db, {
      name: "Target",
      now: 1,
      owner: null,
    });
    const other = await createList(db, { name: "Other", now: 2, owner: null });
    await setBookmarked(db, 9, true, KNOWN, 3, null);
    await addEntryToList(db, target.id, 7, KNOWN, 4, null);
    expect((await db.lists.get(other.id))?.entryIds).toEqual([]);
    expect(await isBookmarked(db, 9, null)).toBe(true);
  });
});

describe("no unintended side effects on other stores", () => {
  it("collection writes never touch study state, mutation queue or db version", async () => {
    await createListWithEntry(db, {
      name: "Verbs",
      entryId: 7,
      knownEntryIds: KNOWN,
      now: 1,
      owner: null,
    });
    await setBookmarked(db, 9, true, KNOWN, 2, null);
    expect(await db.studyComponents.count()).toBe(0);
    expect(await db.studyAttempts.count()).toBe(0);
    expect(await db.reviewEvents.count()).toBe(0);
    expect(await db.mutationQueue.count()).toBe(0);
    expect(await db.dailyActivity.count()).toBe(0);
    // The collection write must not bump the schema version past the current one.
    expect(db.verno).toBe(SAFWA_DB_VERSION);
  });
});
