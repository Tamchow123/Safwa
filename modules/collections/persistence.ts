/**
 * Dexie persistence adapter for bookmarks and custom lists (Phase 14,
 * docs/phases/phases-14.md §9). The impure boundary for this module: it is
 * the only place that reads/writes INDIVIDUAL `db.bookmarks`/`db.lists` rows,
 * mints list ids (`uuidv7`) and calls the durable guest-state boundary. Every
 * function here composes the pure builders/validators from
 * `modules/collections/{bookmarks,lists,validation}.ts` with a Dexie
 * transaction. The ONE sanctioned exception is the whole-store wipe in
 * `modules/sync/client/logout.ts` (`clearAccountLocalState`, via the schema
 * owner's `accountScopedTables`), which bulk-`.clear()`s these stores on
 * logout/account-switch — a full wipe has no per-row canonicalisation invariant
 * to preserve, so it does not route through this adapter.
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
 *
 * SYNC OUTBOX (Phase 16, EXT-F2): every mutating transaction below ALSO reads
 * `db.syncState` for the active account and, when signed in, enqueues the change
 * into `db.mutationQueue` (via `modules/sync/client/mutation-queue.ts`) in the
 * SAME transaction, so the local write and its outbound sync mutation commit
 * atomically. A guest (no active account) enqueues nothing — collection edits
 * sync on the Phase-17 merge, not on login (§18, EXT-F1). This is why each
 * transaction scope lists `db.mutationQueue` and `db.syncState` alongside the
 * collection store.
 */
import { uuidv7 } from "@/lib/uuid";
import type {
  BookmarkRecord,
  CustomListRecord,
  LocalOwnerId,
  SafwaDb,
} from "@/modules/content/db";
import { toOwnerKey } from "@/modules/content/owner-key";
import {
  ownedKey,
  readOwnedRows,
  sameOwnerKey,
} from "@/modules/content/owner-scope";
import { ensureDurableGuestState } from "@/modules/profile/persistence";
import {
  enqueueBookmarkMutation,
  enqueueListMutation,
} from "@/modules/sync/client/mutation-queue";

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

/**
 * Load a list by id, requiring it EXISTS and is OWNED BY `owner`. A list owned
 * by a different identity is reported as not-found from this owner's view
 * (defence in depth — the owner-scoped read hooks never surface a foreign list
 * id to mutate in the first place). Must run inside the caller's `rw` list
 * transaction so the ownership check and the write commit atomically.
 */
async function requireOwnedList(
  db: SafwaDb,
  listId: string,
  owner: LocalOwnerId,
): Promise<CustomListRecord> {
  const current = await db.lists.get(listId);
  if (!current || !sameOwnerKey(current.ownerKey, toOwnerKey(owner))) {
    throw new ListNotFoundError(listId);
  }
  return current;
}

/** Fire the durable-guest-state boundary at the user action; never awaited into the write. */
function kickOffDurableGuestState(db: SafwaDb): void {
  void ensureDurableGuestState(db).catch(() => {});
}

/**
 * Enqueue a list snapshot (upsert, or a delete carrying the last-known snapshot
 * so the wire shape is complete) for the OWNER, if signed in. A guest (null)
 * never enqueues — its collection edits stay local until the Phase-17 merge
 * (§18, EXT-F1). The owner is the AUTH account threaded in by the caller
 * (R2-F1), NEVER the `sync_state` row — whose `userId` is only set after the
 * first pull, so a just-signed-in user's edit would otherwise be mis-scoped as a
 * guest and never sync. Called inside the mutating transaction after the local
 * write.
 */
async function enqueueListChange(
  db: SafwaDb,
  owner: LocalOwnerId,
  list: CustomListRecord,
  deleted: boolean,
  now: number,
): Promise<void> {
  if (owner)
    await enqueueListMutation(db, { userId: owner, list, deleted, now });
}

/**
 * Enqueue a bookmark upsert/delete for the OWNER, if signed in (the bookmark
 * analogue of `enqueueListChange`). Called inside the mutating transaction after
 * the local write.
 */
async function enqueueBookmarkChange(
  db: SafwaDb,
  owner: LocalOwnerId,
  entryId: number,
  createdAt: number,
  deleted: boolean,
  now: number,
): Promise<void> {
  if (owner)
    await enqueueBookmarkMutation(db, {
      userId: owner,
      entryId,
      createdAt,
      deleted,
      now,
    });
}

/* ------------------------------------------------------------------ */
/* Reads — never mint a device profile.                                */
/* ------------------------------------------------------------------ */

export type CollectionsRaw = {
  bookmarks: BookmarkRecord[];
  lists: CustomListRecord[];
};

/**
 * One consistent read of every bookmark and list row OWNED BY `owner` (§10,
 * R2-F3). A signed-in account reads only its own rows and a guest reads only
 * un-owned rows, so a pre-login guest bookmark/list never visually merges into a
 * signed-in account's Saved Vocabulary (and vice versa) even while both
 * coexist in the store before the logout wipe.
 */
export async function readCollections(
  db: SafwaDb,
  owner: LocalOwnerId,
): Promise<CollectionsRaw> {
  return db.transaction("r", [db.bookmarks, db.lists], async () => {
    const [bookmarks, lists] = await Promise.all([
      readOwnedRows(db.bookmarks, owner),
      readOwnedRows(db.lists, owner),
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
  owner: LocalOwnerId,
): Promise<CollectionMembership> {
  const { bookmarks, lists } = await readCollections(db, owner);
  return {
    bookmarkedEntryIds: new Set(bookmarks.map((b) => b.entryId)),
    listEntryIdsById: new Map(
      lists.map((list) => [list.id, new Set(list.entryIds)]),
    ),
  };
}

/**
 * Whether `entryId` currently has a bookmark row OWNED BY `owner`. Since schema
 * v7 the owner is half of the primary key, so this is a direct keyed lookup: a
 * guest's and an account's bookmark for the same entry are different rows and
 * neither can hide or replace the other.
 */
export async function isBookmarked(
  db: SafwaDb,
  entryId: number,
  owner: LocalOwnerId,
): Promise<boolean> {
  return (await db.bookmarks.get(ownedKey(owner, entryId))) !== undefined;
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
  owner: LocalOwnerId,
): Promise<void> {
  if (bookmarked) requireKnownEntry(entryId, knownEntryIds);
  kickOffDurableGuestState(db);
  await db.transaction("rw", [db.bookmarks, db.mutationQueue], async () => {
    // Owner-keyed identity (schema v7): this reads and writes THIS identity's
    // row for the entry; another identity's row for the same entry is a
    // different row entirely and is never seen or replaced here.
    const existing = await db.bookmarks.get(ownedKey(owner, entryId));
    let createdAt: number;
    if (bookmarked) {
      if (existing) return; // no-op: neither rewrite nor enqueue
      const record = buildBookmarkRecord(entryId, now, toOwnerKey(owner));
      await db.bookmarks.put(record);
      createdAt = record.createdAt;
    } else {
      if (!existing) return; // no-op — nothing owned by `owner` to remove
      createdAt = existing.createdAt;
      await db.bookmarks.delete(ownedKey(owner, entryId));
    }
    await enqueueBookmarkChange(
      db,
      owner,
      entryId,
      createdAt,
      !bookmarked,
      now,
    );
  });
}

/** Toggle the bookmark for `entryId`; returns the NEW bookmarked state. */
export async function toggleBookmark(
  db: SafwaDb,
  entryId: number,
  knownEntryIds: ReadonlySet<number>,
  now: number,
  owner: LocalOwnerId,
): Promise<boolean> {
  requireKnownEntry(entryId, knownEntryIds);
  kickOffDurableGuestState(db);
  return db.transaction("rw", [db.bookmarks, db.mutationQueue], async () => {
    const existing = await db.bookmarks.get(ownedKey(owner, entryId));
    if (existing) {
      await db.bookmarks.delete(ownedKey(owner, entryId));
      await enqueueBookmarkChange(
        db,
        owner,
        entryId,
        existing.createdAt,
        true,
        now,
      );
      return false;
    }
    const record = buildBookmarkRecord(entryId, now, toOwnerKey(owner));
    await db.bookmarks.put(record);
    await enqueueBookmarkChange(
      db,
      owner,
      entryId,
      record.createdAt,
      false,
      now,
    );
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
  owner: LocalOwnerId,
  name: string,
  entryIds: readonly number[],
  now: number,
): Promise<CustomListRecord> {
  // Uniqueness and the max-lists cap are scoped to THIS owner's lists, so a
  // guest list named "Verbs" never blocks a signed-in account from creating its
  // own "Verbs", and neither identity's cap counts the other's.
  const existing = await readOwnedRows(db.lists, owner);
  requireNoDuplicate(existing, name);
  if (!canCreateAnotherList(existing.length)) {
    throw new MaxListsExceededError();
  }
  const record = buildListRecord({
    id: uuidv7(now),
    name,
    entryIds,
    now,
    ownerKey: toOwnerKey(owner),
  });
  await db.lists.add(record);
  await enqueueListChange(db, owner, record, false, now);
  return record;
}

/** Create an empty list. */
export async function createList(
  db: SafwaDb,
  params: { name: string; now: number; owner: LocalOwnerId },
): Promise<CustomListRecord> {
  requireValidName(params.name);
  kickOffDurableGuestState(db);
  return db.transaction("rw", [db.lists, db.mutationQueue], () =>
    insertNewList(db, params.owner, params.name, [], params.now),
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
    owner: LocalOwnerId;
  },
): Promise<CustomListRecord> {
  requireValidName(params.name);
  requireKnownEntry(params.entryId, params.knownEntryIds);
  kickOffDurableGuestState(db);
  return db.transaction("rw", [db.lists, db.mutationQueue], () =>
    insertNewList(db, params.owner, params.name, [params.entryId], params.now),
  );
}

/** Rename a list, validating uniqueness and writing atomically. */
export async function renameList(
  db: SafwaDb,
  listId: string,
  name: string,
  now: number,
  owner: LocalOwnerId,
): Promise<CustomListRecord> {
  requireValidName(name);
  kickOffDurableGuestState(db);
  return db.transaction("rw", [db.lists, db.mutationQueue], async () => {
    const current = await requireOwnedList(db, listId, owner);
    // Uniqueness is scoped to this owner's lists (R2-F3).
    const existing = await readOwnedRows(db.lists, owner);
    requireNoDuplicate(existing, name, listId);
    const updated = withRenamedList(current, name, now);
    await db.lists.put(updated);
    await enqueueListChange(db, owner, updated, false, now);
    return updated;
  });
}

/** Delete exactly the selected list. Bookmarks and other lists are untouched. */
export async function deleteList(
  db: SafwaDb,
  listId: string,
  now: number = Date.now(),
  owner: LocalOwnerId = null,
): Promise<void> {
  kickOffDurableGuestState(db);
  await db.transaction("rw", [db.lists, db.mutationQueue], async () => {
    const current = await requireOwnedList(db, listId, owner);
    await db.lists.delete(listId);
    // Send the last-known snapshot with deleted=true so the wire shape is
    // complete and the server tombstones the list by id.
    await enqueueListChange(db, owner, current, true, now);
  });
}

/** Add an entry to a list (idempotent). */
export async function addEntryToList(
  db: SafwaDb,
  listId: string,
  entryId: number,
  knownEntryIds: ReadonlySet<number>,
  now: number,
  owner: LocalOwnerId,
): Promise<CustomListRecord> {
  requireKnownEntry(entryId, knownEntryIds);
  kickOffDurableGuestState(db);
  return db.transaction("rw", [db.lists, db.mutationQueue], async () => {
    const current = await requireOwnedList(db, listId, owner);
    if (current.entryIds.includes(entryId)) return current; // no-op
    const updated = withEntryAdded(current, entryId, now);
    await db.lists.put(updated);
    await enqueueListChange(db, owner, updated, false, now);
    return updated;
  });
}

/** Remove an entry from a list (idempotent). */
export async function removeEntryFromList(
  db: SafwaDb,
  listId: string,
  entryId: number,
  now: number,
  owner: LocalOwnerId,
): Promise<CustomListRecord> {
  kickOffDurableGuestState(db);
  return db.transaction("rw", [db.lists, db.mutationQueue], async () => {
    const current = await requireOwnedList(db, listId, owner);
    if (!current.entryIds.includes(entryId)) return current; // no-op
    const updated = withEntryRemoved(current, entryId, now);
    await db.lists.put(updated);
    await enqueueListChange(db, owner, updated, false, now);
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

/**
 * Upsert a server-authoritative bookmark (within the caller's transaction),
 * keyed to the account `owner` so the pulled bookmark is the account's own row —
 * a guest's bookmark for the same entry is a different row and is untouched.
 */
export async function applyAuthoritativeBookmark(
  db: SafwaDb,
  entryId: number,
  createdAt: number,
  owner: LocalOwnerId,
): Promise<void> {
  await db.bookmarks.put(
    buildBookmarkRecord(entryId, createdAt, toOwnerKey(owner)),
  );
}

/**
 * Delete the bookmark row a tombstone names, FOR THIS OWNER only (within the
 * caller's tx). A tombstone pulled for an account can never delete a guest's
 * bookmark for the same entry.
 */
export async function applyBookmarkTombstone(
  db: SafwaDb,
  entryId: number,
  owner: LocalOwnerId,
): Promise<void> {
  await db.bookmarks.delete(ownedKey(owner, entryId));
}

/**
 * Upsert a server-authoritative list with canonical name + membership, owned by
 * the account `owner`.
 */
export async function applyAuthoritativeList(
  db: SafwaDb,
  list: {
    id: string;
    name: string;
    entryIds: readonly number[];
    createdAt: number;
    updatedAt: number;
  },
  owner: LocalOwnerId,
): Promise<void> {
  await db.lists.put({
    ownerKey: toOwnerKey(owner),
    id: list.id,
    name: cleanListNameInput(list.name),
    entryIds: canonicaliseMembership(list.entryIds),
    createdAt: list.createdAt,
    updatedAt: list.updatedAt,
  });
}

/**
 * Delete the list row a tombstone names, FOR THIS OWNER only (within the
 * caller's tx). List ids are globally unique, so the owner check is defence in
 * depth: a tombstone can only ever remove a row this account owns.
 */
export async function applyListTombstone(
  db: SafwaDb,
  listId: string,
  owner: LocalOwnerId,
): Promise<void> {
  const existing = await db.lists.get(listId);
  if (existing && sameOwnerKey(existing.ownerKey, toOwnerKey(owner))) {
    await db.lists.delete(listId);
  }
}
