/**
 * Dexie persistence adapter for bookmarks and custom lists (Phase 14,
 * docs/phases/phases-14.md sections 9/28) — fake-indexeddb backed.
 */
import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SafwaDb } from "@/modules/content/db";
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
    expect(await readCollections(db)).toEqual({ bookmarks: [], lists: [] });
    expect(await isBookmarked(db, 1)).toBe(false);
  });

  it("reads a consistent snapshot of both stores", async () => {
    await db.bookmarks.add({ entryId: 7, createdAt: 1 });
    await db.lists.add({
      id: "list-1",
      name: "Verbs",
      entryIds: [7],
      createdAt: 1,
      updatedAt: 1,
    });
    const snapshot = await readCollections(db);
    expect(snapshot.bookmarks).toEqual([{ entryId: 7, createdAt: 1 }]);
    expect(snapshot.lists).toHaveLength(1);
  });

  it("a passive read never mints a device profile", async () => {
    await readCollections(db);
    await isBookmarked(db, 7);
    expect(await peekDeviceProfile(db)).toBeNull();
    expect(ensureDurableGuestStateSpy).not.toHaveBeenCalled();
  });
});

describe("setBookmarked / toggleBookmark", () => {
  it("adds and removes a bookmark", async () => {
    await setBookmarked(db, 7, true, KNOWN, 100);
    expect(await isBookmarked(db, 7)).toBe(true);
    await setBookmarked(db, 7, false, KNOWN, 200);
    expect(await isBookmarked(db, 7)).toBe(false);
  });

  it("adding is idempotent", async () => {
    await setBookmarked(db, 7, true, KNOWN, 100);
    await setBookmarked(db, 7, true, KNOWN, 200);
    const rows = await db.bookmarks.toArray();
    expect(rows).toEqual([{ entryId: 7, createdAt: 100 }]);
  });

  it("toggle flips state and returns the new state", async () => {
    expect(await toggleBookmark(db, 7, KNOWN, 100)).toBe(true);
    expect(await toggleBookmark(db, 7, KNOWN, 200)).toBe(false);
  });

  it("rapid double-toggle from empty nets back to not-bookmarked (no lost update)", async () => {
    const [first, second] = await Promise.all([
      toggleBookmark(db, 7, KNOWN, 100),
      toggleBookmark(db, 7, KNOWN, 101),
    ]);
    // IndexedDB serialises overlapping rw transactions on the same store,
    // and each toggle re-reads inside its own transaction, so two toggles
    // from an empty start always net back to "not bookmarked" regardless
    // of submission order — never a lost update leaving it bookmarked.
    expect(first).not.toBe(second);
    expect(await isBookmarked(db, 7)).toBe(false);
  });

  it("rejects an entry id outside the active release", async () => {
    await expect(setBookmarked(db, 999, true, KNOWN, 1)).rejects.toThrow(
      UnknownEntryIdError,
    );
    expect(await db.bookmarks.count()).toBe(0);
  });

  it("removing an unknown entry id is allowed (never blocks cleanup)", async () => {
    await expect(
      setBookmarked(db, 999, false, KNOWN, 1),
    ).resolves.toBeUndefined();
  });

  it("keeps protected duplicate entries as independent bookmarks", async () => {
    await setBookmarked(db, 262, true, KNOWN, 1);
    await setBookmarked(db, 275, true, KNOWN, 2);
    expect(await isBookmarked(db, 262)).toBe(true);
    expect(await isBookmarked(db, 275)).toBe(true);
    await setBookmarked(db, 262, false, KNOWN, 3);
    expect(await isBookmarked(db, 262)).toBe(false);
    expect(await isBookmarked(db, 275)).toBe(true);
  });

  it("calls the durable guest-state boundary at the user action", async () => {
    await setBookmarked(db, 7, true, KNOWN, 1);
    expect(ensureDurableGuestStateSpy).toHaveBeenCalledTimes(1);
  });

  it("a rejected bookmark write persists no row (the single write never lands)", async () => {
    const spy = vi
      .spyOn(db.bookmarks, "put")
      .mockRejectedValueOnce(new Error("simulated write failure"));
    await expect(setBookmarked(db, 7, true, KNOWN, 1)).rejects.toThrow();
    expect(await db.bookmarks.count()).toBe(0);
    spy.mockRestore();
  });
});

describe("createList / createListWithEntry", () => {
  it("creates an empty list", async () => {
    const list = await createList(db, { name: "Difficult Verbs", now: 1 });
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
      }),
    ).rejects.toThrow(UnknownEntryIdError);
    expect(await db.lists.count()).toBe(0);
  });

  it("rejects a duplicate normalised name", async () => {
    await createList(db, { name: "Difficult Verbs", now: 1 });
    await expect(
      createList(db, { name: "difficult   verbs", now: 2 }),
    ).rejects.toThrow(DuplicateListNameError);
    expect(await db.lists.count()).toBe(1);
  });

  it("rejects an invalid name", async () => {
    await expect(createList(db, { name: "   ", now: 1 })).rejects.toThrow(
      InvalidListNameError,
    );
  });

  it("enforces the max-lists policy", async () => {
    for (let i = 0; i < 50; i += 1) {
      await createList(db, { name: `List ${i}`, now: i });
    }
    await expect(
      createList(db, { name: "One too many", now: 1000 }),
    ).rejects.toThrow(MaxListsExceededError);
    expect(await db.lists.count()).toBe(50);
  });

  it("a rejected create-list-with-entry write persists no row and leaves other lists untouched", async () => {
    const other = await createList(db, { name: "Other", now: 0 });
    const spy = vi
      .spyOn(db.lists, "add")
      .mockRejectedValueOnce(new Error("simulated write failure"));
    await expect(
      createListWithEntry(db, {
        name: "Verbs",
        entryId: 7,
        knownEntryIds: KNOWN,
        now: 1,
      }),
    ).rejects.toThrow();
    // No half-created row (the single add() never landed) and the
    // pre-existing, unrelated list survives the failed attempt untouched.
    expect(await db.lists.count()).toBe(1);
    expect(await db.lists.get(other.id)).toEqual(other);
    spy.mockRestore();
  });

  it("calls the durable guest-state boundary", async () => {
    await createList(db, { name: "Verbs", now: 1 });
    expect(ensureDurableGuestStateSpy).toHaveBeenCalledTimes(1);
  });
});

describe("renameList", () => {
  it("renames and bumps updatedAt, preserving createdAt", async () => {
    const list = await createList(db, { name: "Old name", now: 1 });
    const renamed = await renameList(db, list.id, "New name", 2);
    expect(renamed.name).toBe("New name");
    expect(renamed.createdAt).toBe(1);
    expect(renamed.updatedAt).toBe(2);
  });

  it("rejects a collision with another list's normalised name", async () => {
    await createList(db, { name: "Taken", now: 1 });
    const other = await createList(db, { name: "Other", now: 2 });
    await expect(renameList(db, other.id, "taken", 3)).rejects.toThrow(
      DuplicateListNameError,
    );
  });

  it("allows renaming to its own equivalent normalised name", async () => {
    const list = await createList(db, { name: "Difficult Verbs", now: 1 });
    await expect(
      renameList(db, list.id, "difficult   verbs", 2),
    ).resolves.toMatchObject({ name: "difficult verbs" });
  });

  it("throws for an unknown list id", async () => {
    await expect(renameList(db, "missing", "New name", 1)).rejects.toThrow(
      ListNotFoundError,
    );
  });

  it("rename followed immediately by another rename settles on the later intent", async () => {
    const list = await createList(db, { name: "Original", now: 1 });
    await Promise.all([
      renameList(db, list.id, "First rename", 2),
      renameList(db, list.id, "Second rename", 3),
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
    const a = await createList(db, { name: "A", now: 1 });
    const b = await createList(db, { name: "B", now: 2 });
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
    });
    await setBookmarked(db, 7, true, KNOWN, 2);
    await deleteList(db, list.id);
    expect(await isBookmarked(db, 7)).toBe(true);
  });

  it("throws for an unknown list id", async () => {
    await expect(deleteList(db, "missing")).rejects.toThrow(ListNotFoundError);
  });
});

describe("addEntryToList / removeEntryFromList", () => {
  it("adds and removes an entry", async () => {
    const list = await createList(db, { name: "Verbs", now: 1 });
    const withEntry = await addEntryToList(db, list.id, 7, KNOWN, 2);
    expect(withEntry.entryIds).toEqual([7]);
    const withoutEntry = await removeEntryFromList(db, list.id, 7, 3);
    expect(withoutEntry.entryIds).toEqual([]);
  });

  it("adding a duplicate entry is idempotent", async () => {
    const list = await createList(db, { name: "Verbs", now: 1 });
    await addEntryToList(db, list.id, 7, KNOWN, 2);
    const again = await addEntryToList(db, list.id, 7, KNOWN, 3);
    expect(again.entryIds).toEqual([7]);
  });

  it("removing a missing entry is idempotent", async () => {
    const list = await createList(db, { name: "Verbs", now: 1 });
    const result = await removeEntryFromList(db, list.id, 999, 2);
    expect(result.entryIds).toEqual([]);
  });

  it("membership stays sorted and unique after every write", async () => {
    const list = await createList(db, { name: "Verbs", now: 1 });
    await addEntryToList(db, list.id, 9, KNOWN, 2);
    await addEntryToList(db, list.id, 2, KNOWN, 3);
    const final = await addEntryToList(db, list.id, 7, KNOWN, 4);
    expect(final.entryIds).toEqual([2, 7, 9]);
  });

  it("rejects an unknown entry id", async () => {
    const list = await createList(db, { name: "Verbs", now: 1 });
    await expect(addEntryToList(db, list.id, 999, KNOWN, 2)).rejects.toThrow(
      UnknownEntryIdError,
    );
  });

  it("throws for an unknown list id", async () => {
    await expect(addEntryToList(db, "missing", 7, KNOWN, 1)).rejects.toThrow(
      ListNotFoundError,
    );
    await expect(removeEntryFromList(db, "missing", 7, 1)).rejects.toThrow(
      ListNotFoundError,
    );
  });

  it("two rapid membership changes both land (no lost update)", async () => {
    const list = await createList(db, { name: "Verbs", now: 1 });
    await Promise.all([
      addEntryToList(db, list.id, 2, KNOWN, 2),
      addEntryToList(db, list.id, 7, KNOWN, 3),
    ]);
    const stored = await db.lists.get(list.id);
    expect(stored?.entryIds).toEqual([2, 7]);
  });

  it("a list can hold both members of a protected duplicate group; removing one preserves the other", async () => {
    const list = await createList(db, { name: "Verbs", now: 1 });
    await addEntryToList(db, list.id, 262, KNOWN, 2);
    await addEntryToList(db, list.id, 275, KNOWN, 3);
    const afterRemove = await removeEntryFromList(db, list.id, 262, 4);
    expect(afterRemove.entryIds).toEqual([275]);
  });

  it("unrelated lists and bookmarks are preserved by a membership write", async () => {
    const target = await createList(db, { name: "Target", now: 1 });
    const other = await createList(db, { name: "Other", now: 2 });
    await setBookmarked(db, 9, true, KNOWN, 3);
    await addEntryToList(db, target.id, 7, KNOWN, 4);
    expect((await db.lists.get(other.id))?.entryIds).toEqual([]);
    expect(await isBookmarked(db, 9)).toBe(true);
  });
});

describe("no unintended side effects on other stores", () => {
  it("collection writes never touch study state, mutation queue or db version", async () => {
    await createListWithEntry(db, {
      name: "Verbs",
      entryId: 7,
      knownEntryIds: KNOWN,
      now: 1,
    });
    await setBookmarked(db, 9, true, KNOWN, 2);
    expect(await db.studyComponents.count()).toBe(0);
    expect(await db.studyAttempts.count()).toBe(0);
    expect(await db.reviewEvents.count()).toBe(0);
    expect(await db.mutationQueue.count()).toBe(0);
    expect(await db.dailyActivity.count()).toBe(0);
    expect(db.verno).toBe(3);
  });
});
