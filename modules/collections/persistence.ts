/**
 * Dexie persistence adapter for bookmarks and custom lists (Phase 14,
 * docs/phases/phases-14.md §9). The impure boundary for this module: it is
 * the only place that reads/writes `db.bookmarks`/`db.lists`, mints list ids
 * (`uuidv7`) and calls the durable guest-state boundary. Every function here
 * composes the pure builders/validators from `modules/collections/{bookmarks,
 * lists,validation}.ts` with a Dexie transaction.
 *
 * DURABLE GUEST STATE (§9): every write below fires `ensureDurableGuestState`
 * BEFORE the Dexie transaction runs — deliberately at the user action,
 * per §9 ("start the durability request rather than waiting until after
 * all other work finishes"). This differs from the older after-a-successful-
 * write timing used by `components/study/{quiz-runner,flashcard-session}.tsx`
 * (fired once grading has already been recorded); the call itself is the
 * same fire-and-forget shape (`void ensureDurableGuestState(db).catch(() =>
 * {})`), just triggered earlier, including ahead of an in-transaction
 * validation failure (duplicate name, unknown list, etc.). Reads never call
 * it (a passive Saved-Vocabulary view must not mint a device profile).
 *
 * RACE SAFETY (§11): every mutating list operation re-reads the current row
 * INSIDE the same Dexie "rw" transaction and writes back a canonical
 * result — it never trusts a caller-supplied stale copy. IndexedDB
 * serialises overlapping readwrite transactions on the same store in
 * submission order, so a delayed earlier write can never silently overwrite
 * a later one: each transaction always computes its result from the
 * genuinely current row. Idempotent no-op writes (adding an already-present
 * entry, removing an absent one) skip the `put` entirely so `updatedAt`
 * only advances on a real change.
 *
 * ENTRY VALIDATION (§8.1/§8.4): every write that introduces an entry id
 * (`setBookmarked(true)`, `toggleBookmark`, `createListWithEntry`,
 * `addEntryToList`) requires the caller-supplied `knownEntryIds` — the
 * active verified learner release's entry ids — and rejects anything not in
 * it. This module never imports the content-release layer itself, so the
 * caller (a React hook backed by `useActiveContent`) always supplies the
 * current set.
 */
import { uuidv7 } from "@/lib/uuid";
import type {
  BookmarkRecord,
  CustomListRecord,
  SafwaDb,
} from "@/modules/content/db";
import { ensureDurableGuestState } from "@/modules/profile/persistence";

import { buildBookmarkRecord } from "@/modules/collections/bookmarks";
import type { CollectionMembership } from "@/modules/collections/filters";
import {
  buildListRecord,
  withEntryAdded,
  withEntryRemoved,
  withRenamedList,
} from "@/modules/collections/lists";
import {
  canCreateAnotherList,
  canonicaliseMembership,
  cleanListNameInput,
  isDuplicateListName,
  isValidEntryId,
  validateListName,
} from "@/modules/collections/validation";

/** Thrown when a write references an entry id outside the active release. */
export class UnknownEntryIdError extends Error {
  constructor(public readonly entryId: number) {
    super("unknown entry id");
    this.name = "UnknownEntryIdError";
  }
}

/** Thrown when a write targets a list id that does not exist. */
export class ListNotFoundError extends Error {
  constructor(public readonly listId: string) {
    super("list not found");
    this.name = "ListNotFoundError";
  }
}

/** Thrown when a list name fails the §8.3 length policy. */
export class InvalidListNameError extends Error {
  constructor(public readonly reason: "empty" | "too_long") {
    super("invalid list name");
    this.name = "InvalidListNameError";
  }
}

/** Thrown when a list name collides (case-insensitively) with an existing list. */
export class DuplicateListNameError extends Error {
  constructor() {
    super("duplicate list name");
    this.name = "DuplicateListNameError";
  }
}

/** Thrown when creating a list would exceed the §8.3 max-lists policy. */
export class MaxListsExceededError extends Error {
  constructor() {
    super("maximum number of lists reached");
    this.name = "MaxListsExceededError";
  }
}

function requireKnownEntry(
  entryId: number,
  knownEntryIds: ReadonlySet<number>,
): void {
  if (!isValidEntryId(entryId) || !knownEntryIds.has(entryId)) {
    throw new UnknownEntryIdError(entryId);
  }
}

function requireValidName(name: string): void {
  const validated = validateListName(name);
  if (!validated.valid) {
    throw new InvalidListNameError(validated.reason);
  }
}

function requireNoDuplicate(
  existing: readonly CustomListRecord[],
  name: string,
  excludeListId?: string,
): void {
  if (isDuplicateListName(name, existing, excludeListId)) {
    throw new DuplicateListNameError();
  }
}

/** Fire the durable-guest-state boundary at the user action; never awaited into the write. */
function kickOffDurableGuestState(db: SafwaDb): void {
  void ensureDurableGuestState(db).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Reads — never mint a device profile.                                */
/* ------------------------------------------------------------------ */

export type CollectionsRaw = {
  bookmarks: BookmarkRecord[];
  lists: CustomListRecord[];
};

/** One consistent read of every bookmark and list row (§10). */
export async function readCollections(db: SafwaDb): Promise<CollectionsRaw> {
  return db.transaction("r", [db.bookmarks, db.lists], async () => {
    const [bookmarks, lists] = await Promise.all([
      db.bookmarks.toArray(),
      db.lists.toArray(),
    ]);
    return { bookmarks, lists };
  });
}

/**
 * `readCollections`, reshaped into the pure `CollectionMembership` lookup
 * shape `modules/study-session/custom.ts`'s collection axis (§19) consumes
 * directly — the one conversion point between the Dexie rows and the pure
 * filter engine, so every caller (Custom Session setup + Study Again) builds
 * membership identically. Stale entry ids from a prior content release are
 * carried through unfiltered — they simply never match any entry in the
 * active release's component universe, so no explicit pruning is needed here
 * (§19 "current-release validation").
 */
export async function readCollectionMembership(
  db: SafwaDb,
): Promise<CollectionMembership> {
  const { bookmarks, lists } = await readCollections(db);
  return {
    bookmarkedEntryIds: new Set(bookmarks.map((b) => b.entryId)),
    listEntryIdsById: new Map(
      lists.map((list) => [list.id, new Set(list.entryIds)]),
    ),
  };
}

/** Whether `entryId` currently has a bookmark row. */
export async function isBookmarked(
  db: SafwaDb,
  entryId: number,
): Promise<boolean> {
  return (await db.bookmarks.get(entryId)) !== undefined;
}

/* ------------------------------------------------------------------ */
/* Bookmark writes                                                     */
/* ------------------------------------------------------------------ */

/**
 * Set the bookmark state for `entryId` explicitly (idempotent either way).
 * Re-setting an already-matching state is a true no-op: it neither rewrites
 * the row nor disturbs its original `createdAt` (and therefore the newest-
 * first ordering other views rely on).
 */
export async function setBookmarked(
  db: SafwaDb,
  entryId: number,
  bookmarked: boolean,
  knownEntryIds: ReadonlySet<number>,
  now: number,
): Promise<void> {
  if (bookmarked) requireKnownEntry(entryId, knownEntryIds);
  kickOffDurableGuestState(db);
  await db.transaction("rw", [db.bookmarks], async () => {
    const existing = await db.bookmarks.get(entryId);
    if (bookmarked) {
      if (existing) return;
      await db.bookmarks.put(buildBookmarkRecord(entryId, now));
    } else {
      if (!existing) return;
      await db.bookmarks.delete(entryId);
    }
  });
}

/** Toggle the bookmark for `entryId`; returns the NEW bookmarked state. */
export async function toggleBookmark(
  db: SafwaDb,
  entryId: number,
  knownEntryIds: ReadonlySet<number>,
  now: number,
): Promise<boolean> {
  requireKnownEntry(entryId, knownEntryIds);
  kickOffDurableGuestState(db);
  return db.transaction("rw", [db.bookmarks], async () => {
    const existing = await db.bookmarks.get(entryId);
    if (existing) {
      await db.bookmarks.delete(entryId);
      return false;
    }
    await db.bookmarks.put(buildBookmarkRecord(entryId, now));
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* List writes                                                         */
/* ------------------------------------------------------------------ */

/**
 * Validate against the current rows (inside the caller's transaction) and
 * insert a new canonical list record. Shared by `createList` and
 * `createListWithEntry`, which differ only in the initial `entryIds`.
 */
async function insertNewList(
  db: SafwaDb,
  name: string,
  entryIds: readonly number[],
  now: number,
): Promise<CustomListRecord> {
  const existing = await db.lists.toArray();
  requireNoDuplicate(existing, name);
  if (!canCreateAnotherList(existing.length)) {
    throw new MaxListsExceededError();
  }
  const record = buildListRecord({ id: uuidv7(now), name, entryIds, now });
  await db.lists.add(record);
  return record;
}

/** Create an empty list. */
export async function createList(
  db: SafwaDb,
  params: { name: string; now: number },
): Promise<CustomListRecord> {
  requireValidName(params.name);
  kickOffDurableGuestState(db);
  return db.transaction("rw", [db.lists], () =>
    insertNewList(db, params.name, [], params.now),
  );
}

/** Create a list and add its first entry atomically (§9, §31.4). */
export async function createListWithEntry(
  db: SafwaDb,
  params: {
    name: string;
    entryId: number;
    knownEntryIds: ReadonlySet<number>;
    now: number;
  },
): Promise<CustomListRecord> {
  requireValidName(params.name);
  requireKnownEntry(params.entryId, params.knownEntryIds);
  kickOffDurableGuestState(db);
  return db.transaction("rw", [db.lists], () =>
    insertNewList(db, params.name, [params.entryId], params.now),
  );
}

/** Rename a list, validating uniqueness and writing atomically. */
export async function renameList(
  db: SafwaDb,
  listId: string,
  name: string,
  now: number,
): Promise<CustomListRecord> {
  requireValidName(name);
  kickOffDurableGuestState(db);
  return db.transaction("rw", [db.lists], async () => {
    const current = await db.lists.get(listId);
    if (!current) throw new ListNotFoundError(listId);
    const existing = await db.lists.toArray();
    requireNoDuplicate(existing, name, listId);
    const updated = withRenamedList(current, name, now);
    await db.lists.put(updated);
    return updated;
  });
}

/** Delete exactly the selected list. Bookmarks and other lists are untouched. */
export async function deleteList(db: SafwaDb, listId: string): Promise<void> {
  kickOffDurableGuestState(db);
  await db.transaction("rw", [db.lists], async () => {
    const current = await db.lists.get(listId);
    if (!current) throw new ListNotFoundError(listId);
    await db.lists.delete(listId);
  });
}

/** Add an entry to a list (idempotent). */
export async function addEntryToList(
  db: SafwaDb,
  listId: string,
  entryId: number,
  knownEntryIds: ReadonlySet<number>,
  now: number,
): Promise<CustomListRecord> {
  requireKnownEntry(entryId, knownEntryIds);
  kickOffDurableGuestState(db);
  return db.transaction("rw", [db.lists], async () => {
    const current = await db.lists.get(listId);
    if (!current) throw new ListNotFoundError(listId);
    if (current.entryIds.includes(entryId)) return current;
    const updated = withEntryAdded(current, entryId, now);
    await db.lists.put(updated);
    return updated;
  });
}

/** Remove an entry from a list (idempotent). */
export async function removeEntryFromList(
  db: SafwaDb,
  listId: string,
  entryId: number,
  now: number,
): Promise<CustomListRecord> {
  kickOffDurableGuestState(db);
  return db.transaction("rw", [db.lists], async () => {
    const current = await db.lists.get(listId);
    if (!current) throw new ListNotFoundError(listId);
    if (!current.entryIds.includes(entryId)) return current;
    const updated = withEntryRemoved(current, entryId, now);
    await db.lists.put(updated);
    return updated;
  });
}

/* ---------------------------------------------------------------------- */
/* Phase 16 — server-authoritative sync apply.                            */
/*                                                                        */
/* Online-sync reconciliation (§19) applies the server's authoritative    */
/* bookmark/list state pulled from another context. These are the ONLY    */
/* sync-side writers of db.bookmarks/db.lists, keeping this module the     */
/* single writer of those stores. They run WITHIN the caller's Dexie      */
/* transaction (reconcile opens one over all synced stores), take NO new  */
/* transaction, and DON'T fire the guest-durability boundary — this is an */
/* account (signed-in) write, not a guest UI action. Membership + name    */
/* are canonicalised (dedupe/sort, NFC/trim) so the local invariants hold */
/* identically to the guest mutators; SERVER timestamps are preserved.    */
/* ---------------------------------------------------------------------- */

/** Upsert a server-authoritative bookmark (within the caller's transaction). */
export async function applyAuthoritativeBookmark(
  db: SafwaDb,
  entryId: number,
  createdAt: number,
): Promise<void> {
  await db.bookmarks.put(buildBookmarkRecord(entryId, createdAt));
}

/** Delete a bookmark row propagated by a tombstone (within the caller's tx). */
export async function applyBookmarkTombstone(
  db: SafwaDb,
  entryId: number,
): Promise<void> {
  await db.bookmarks.delete(entryId);
}

/** Upsert a server-authoritative list with canonical name + membership. */
export async function applyAuthoritativeList(
  db: SafwaDb,
  list: {
    id: string;
    name: string;
    entryIds: readonly number[];
    createdAt: number;
    updatedAt: number;
  },
): Promise<void> {
  await db.lists.put({
    id: list.id,
    name: cleanListNameInput(list.name),
    entryIds: canonicaliseMembership(list.entryIds),
    createdAt: list.createdAt,
    updatedAt: list.updatedAt,
  });
}

/** Delete a list row propagated by a tombstone (within the caller's tx). */
export async function applyListTombstone(
  db: SafwaDb,
  listId: string,
): Promise<void> {
  await db.lists.delete(listId);
}
