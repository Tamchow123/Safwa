/**
 * Phase 17 §16–§17 — collection semantics that are SPECIFIC TO A MERGE.
 *
 * Ordinary sync (`./collections.ts`) treats the client's batch as a statement
 * about what the account's collections should now be: a list whose normalised
 * name collides with an existing one is `invalid_list`, and a `deleted` item
 * removes an account row. Both are right for a device reconciling with its own
 * account, and both are wrong for a merge.
 *
 * A merge is a UNION of two histories that were never the same account's. The
 * guest did not know what the account had, so a name collision is not a client
 * error to refuse — it is the ordinary case, and refusing it would silently
 * drop the guest's membership. And a guest never had the standing to delete an
 * account row at all, so no incoming item may remove one (§16 "never delete an
 * account bookmark because the guest lacks it").
 *
 * WHAT IS REUSED, NOT REIMPLEMENTED (§13 "reuse current Phase 16 modules, do
 * not duplicate"): entry-id resolution against the active release, list-name
 * validation and normalisation, membership canonicalisation, the per-account
 * list cap, the tombstone helpers and the audit-paired rejection helper — all
 * imported from `./collections.ts` and `@/modules/collections/validation`. A
 * second copy of any of them could drift into accepting something ordinary sync
 * refuses, which is precisely the trust-boundary hole §30 asks about.
 *
 * WHAT IS DIFFERENT, AND ONLY THIS:
 *   - bookmarks union instead of overwrite, and never delete;
 *   - a colliding list name folds into the ACCOUNT's list instead of being
 *     refused, and the caller is told the id it folded into;
 *   - a new list keeps the guest's uuid when that uuid is free, so the client
 *     usually needs no re-keying at all.
 *
 * `server-only`.
 */
import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { bookmarks, customListEntries, customLists } from "@/db/schema";
import {
  canCreateAnotherList,
  canonicaliseMembership,
  isValidEntryId,
  resolvableMembership,
  validateListName,
} from "@/modules/collections/validation";
import {
  type GuestListMapping,
  type SyncItemResult,
  type WireBookmark,
  type WireList,
} from "@/modules/sync/protocol";

import {
  accepted,
  activeEntryIds,
  clearTombstone,
  type CollectionsSyncOptions,
  rejectAndAudit,
} from "./collections";
import { nextAccountCursor, type SyncTx } from "./cursor";

export type GuestMergeCollectionsOptions = CollectionsSyncOptions;

/**
 * What a bookmark merge did, in the terms §21's summary reports. `added` and
 * `alreadyPresent` are counted separately because a learner told "12 bookmarks
 * merged" when 11 were already on the account has been given a number that is
 * not true of anything.
 */
export type GuestBookmarkMergeResult = {
  results: SyncItemResult[];
  added: number;
  alreadyPresent: number;
  rejected: number;
  /** The account cursor after the merge; unchanged when nothing was written. */
  serverCursor: number;
};

export type GuestListMergeResult = {
  results: SyncItemResult[];
  created: number;
  merged: number;
  rejected: number;
  /** Guest-list-id → account-list-id, for every list this call resolved (§17). */
  mappings: GuestListMapping[];
  serverCursor: number;
};

/**
 * An item the account already had: reported as a DUPLICATE, and nothing was
 * written for it. Distinct from `accepted()` — a merge that reported an
 * already-present bookmark as accepted would inflate the summary a learner is
 * shown into a count that is not true of anything.
 */
function unchanged(
  itemId: string,
  itemKind: "bookmark" | "list",
): SyncItemResult {
  return {
    itemId,
    itemKind,
    status: "duplicate",
    reasonCode: "duplicate",
    duplicate: true,
    recoverable: false,
  };
}

/**
 * Merge guest bookmarks into the account by SET UNION (§16).
 *
 * Idempotent by construction: the union of a set with itself is that set, so a
 * repeated import adds nothing and reports every bookmark as already present.
 * Only genuinely new rows take a cursor stamp, so a repeat does not bump the
 * account cursor and does not wake another device for a change that is not
 * there (§15 "no unnecessary revision or cursor bumps").
 */
export async function mergeGuestBookmarks(
  userId: string,
  items: readonly WireBookmark[],
  options: GuestMergeCollectionsOptions = {},
): Promise<GuestBookmarkMergeResult> {
  const db = getDb();
  if (items.length === 0) {
    return {
      results: [],
      added: 0,
      alreadyPresent: 0,
      rejected: 0,
      serverCursor: 0,
    };
  }
  const knownEntryIds = await activeEntryIds(options);

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${userId}:bookmarks`}), 0)`,
    );

    const results: SyncItemResult[] = [];
    let added = 0;
    let alreadyPresent = 0;
    let rejected = 0;

    // Validate first, so the cursor is bumped only if something will be written.
    const candidates: WireBookmark[] = [];
    for (const item of items) {
      const ref = String(item.entryId);
      if (item.deleted) {
        // A guest never had the standing to delete an account bookmark, and the
        // snapshot never produces one (guest-snapshot.ts writes `deleted:false`
        // unconditionally). Refusing it here means the union stays a union even
        // if some future caller hands this function a deletion by mistake —
        // "never delete an account bookmark" is enforced, not merely intended.
        results.push(
          await rejectAndAudit(
            tx,
            {
              userId,
              itemKind: "bookmark",
              itemId: ref,
              reasonCode: "malformed_item",
              correlationId: options.correlationId,
            },
            "bookmark",
            "malformed_item",
          ),
        );
        rejected += 1;
        continue;
      }
      if (!isValidEntryId(item.entryId) || !knownEntryIds.has(item.entryId)) {
        // The same entry-id gate ordinary sync applies (§16 "validate entry
        // ids"). A guest bookmark of an entry the active release dropped is
        // refused and reported, never merged silently.
        results.push(
          await rejectAndAudit(
            tx,
            {
              userId,
              itemKind: "bookmark",
              itemId: ref,
              reasonCode: "unknown_entry",
              correlationId: options.correlationId,
            },
            "bookmark",
            "unknown_entry",
          ),
        );
        rejected += 1;
        continue;
      }
      candidates.push(item);
    }

    if (candidates.length === 0) {
      return { results, added, alreadyPresent, rejected, serverCursor: 0 };
    }

    // Which of them the account already has — one query, not one per bookmark.
    const existing = await tx
      .select({ entryId: bookmarks.entryId })
      .from(bookmarks)
      .where(
        and(
          eq(bookmarks.userId, userId),
          inArray(
            bookmarks.entryId,
            candidates.map((item) => item.entryId),
          ),
        ),
      );
    // `present` GROWS as this loop inserts. It starts as what the account had
    // and gains each entry id this batch writes, because a batch may contain
    // the same entry id twice — `wireBookmarkSchema` bounds the array's length
    // but says nothing about uniqueness within it, so a duplicated chunk or a
    // corrupted local export can deliver one. Left as a static snapshot, both
    // occurrences would take the insert branch, the second would silently do
    // nothing, and both would still be counted as added: the inflated summary
    // this module's own doc comment says must never be produced.
    //
    // `mergeGuestLists` below already grows its `byNormalisedName` index inside
    // its loop for exactly this reason; this is the same rule for bookmarks.
    const present = new Set(existing.map((row) => row.entryId));
    const distinctToAdd = new Set(
      candidates
        .map((item) => item.entryId)
        .filter((entryId) => !present.has(entryId)),
    );

    // Bump ONCE, and only when a row will genuinely change (§18's "repeating
    // the merge does not bump cursors unnecessarily", applied to §16 too).
    const cursor =
      distinctToAdd.size > 0 ? await nextAccountCursor(tx, userId) : 0;

    for (const item of candidates) {
      const entryId = item.entryId;
      const ref = String(entryId);
      if (present.has(entryId)) {
        alreadyPresent += 1;
        results.push(unchanged(ref, "bookmark"));
        continue;
      }
      const inserted = await tx
        .insert(bookmarks)
        .values({
          userId,
          entryId,
          // The guest's own timestamp, not the merge's: §9.4 keeps original
          // historical identity, and "bookmarked in March" stays true.
          createdAt: new Date(item.createdAt),
          lastSyncSeq: cursor,
        })
        // A concurrent writer could have inserted it between the read above and
        // here; treat that as already-present rather than failing the merge.
        .onConflictDoNothing({ target: [bookmarks.userId, bookmarks.entryId] })
        .returning({ entryId: bookmarks.entryId });

      present.add(entryId);
      if (inserted.length === 0) {
        // Someone else's row, not ours. Report what happened, not what was
        // planned — the same rule `mergeGuestSettings` applies to its insert.
        alreadyPresent += 1;
        results.push(unchanged(ref, "bookmark"));
        continue;
      }
      // §16 "clear stale tombstones for reintroduced bookmarks": without this a
      // pull would carry the deletion to a second device and remove the row the
      // merge just added.
      await clearTombstone(tx, userId, "bookmark", ref);
      added += 1;
      results.push(accepted(ref, "bookmark"));
    }

    return { results, added, alreadyPresent, rejected, serverCursor: cursor };
  });
}

/** A guest list that passed validation, ready to resolve against the account. */
type ListCandidate = {
  list: WireList;
  displayName: string;
  normalisedName: string;
  membership: number[];
};

/**
 * Merge guest custom lists into the account by NORMALISED NAME (§17).
 *
 * The whole batch runs in one advisory-locked transaction, because the decisions
 * are not independent: two guest lists whose names normalise identically must
 * fold into the same account list, and the per-account list cap has to be
 * counted against what this batch has already created, not only against what was
 * there when it started.
 */
export async function mergeGuestLists(
  userId: string,
  items: readonly WireList[],
  options: GuestMergeCollectionsOptions = {},
): Promise<GuestListMergeResult> {
  const db = getDb();
  if (items.length === 0) {
    return {
      results: [],
      created: 0,
      merged: 0,
      rejected: 0,
      mappings: [],
      serverCursor: 0,
    };
  }
  const knownEntryIds = await activeEntryIds(options);

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${userId}:lists`}), 0)`,
    );

    const results: SyncItemResult[] = [];
    const mappings: GuestListMapping[] = [];
    let created = 0;
    let merged = 0;
    let rejected = 0;

    const candidates: ListCandidate[] = [];
    for (const list of items) {
      if (list.deleted) {
        // As with bookmarks: a merge adds, it never removes.
        results.push(
          await rejectAndAudit(
            tx,
            {
              userId,
              itemKind: "list",
              itemId: list.id,
              reasonCode: "invalid_list",
              correlationId: options.correlationId,
            },
            "list",
            "invalid_list",
          ),
        );
        rejected += 1;
        continue;
      }
      const nameCheck = validateListName(list.name);
      if (!nameCheck.valid) {
        results.push(
          await rejectAndAudit(
            tx,
            {
              userId,
              itemKind: "list",
              itemId: list.id,
              reasonCode: "invalid_list",
              correlationId: options.correlationId,
            },
            "list",
            "invalid_list",
          ),
        );
        rejected += 1;
        continue;
      }
      candidates.push({
        list,
        displayName: nameCheck.displayName,
        normalisedName: nameCheck.normalisedName,
        membership: resolvableMembership(
          canonicaliseMembership(list.entryIds),
          knownEntryIds,
        ),
      });
    }

    if (candidates.length === 0) {
      return { results, created, merged, rejected, mappings, serverCursor: 0 };
    }

    // The account's lists as they stand, by normalised name — the fold target.
    const accountLists = await tx
      .select({
        id: customLists.id,
        normalisedName: customLists.normalisedName,
      })
      .from(customLists)
      .where(eq(customLists.userId, userId));
    const byNormalisedName = new Map(
      accountLists.map((row) => [row.normalisedName, row.id]),
    );
    let listCount = accountLists.length;

    // One bump for the batch, taken LAZILY — on the first write that actually
    // needs a stamp, and never at all if nothing does.
    //
    // The ordinary path can decide up front because it knows from validation
    // alone whether an item will be written. A fold cannot: whether it changes
    // anything depends on which members the account list is already missing,
    // which is only known while applying it. Bumping unconditionally instead
    // would make every repeated import advance the account cursor and wake
    // every other device to pull a change that is not there — §15's "no
    // unnecessary revision or cursor bumps", and the reason the repeat-import
    // test asserts the cursor rather than only the row count.
    //
    // Safe here in a way it would not be in `./collections.ts`: this batch uses
    // no savepoints, so there is no inner rollback that could undo the bump and
    // strand a committed row's `last_sync_seq` above the account cursor. Taking
    // it late also matches ingest's lock ordering (cursor after the row locks).
    let cursor = 0;
    const stampCursor = async (): Promise<number> => {
      if (cursor === 0) cursor = await nextAccountCursor(tx, userId);
      return cursor;
    };

    for (const candidate of candidates) {
      const { list } = candidate;
      const existingId = byNormalisedName.get(candidate.normalisedName);

      if (existingId !== undefined) {
        // FOLD (§17). The account list stays canonical: its id, its display
        // name and its metadata are untouched — only membership grows. The
        // guest's display name is deliberately discarded rather than applied,
        // because the account's name is the one the learner chose while signed
        // in, and a merge is not the moment to rename their list under them.
        const unionAdded = await addMissingMembers(
          tx,
          existingId,
          candidate.membership,
        );
        if (unionAdded > 0) {
          await tx
            .update(customLists)
            .set({ lastSyncSeq: await stampCursor(), updatedAt: new Date() })
            .where(
              and(
                eq(customLists.id, existingId),
                eq(customLists.userId, userId),
              ),
            );
        }
        await clearTombstone(tx, userId, "list", existingId);
        mappings.push({ guestListId: list.id, accountListId: existingId });
        merged += 1;
        results.push(
          unionAdded > 0
            ? accepted(list.id, "list")
            : unchanged(list.id, "list"),
        );
        continue;
      }

      // CREATE. Respect the per-account cap, counting what this batch has
      // already created — otherwise a single import could take an account well
      // past a limit ordinary sync enforces item by item.
      if (!canCreateAnotherList(listCount)) {
        results.push(
          await rejectAndAudit(
            tx,
            {
              userId,
              itemKind: "list",
              itemId: list.id,
              reasonCode: "invalid_list",
              correlationId: options.correlationId,
            },
            "list",
            "invalid_list",
          ),
        );
        rejected += 1;
        continue;
      }

      // Keep the guest's uuid when it is free, so the client needs no re-keying
      // for the common case. `onConflictDoNothing` on the primary key is what
      // makes "free" a decision the DATABASE makes: a taken id inserts nothing
      // and returns nothing, and we never learn whose it was — which is exactly
      // the enumeration-safety §17 asks for ("without revealing another
      // account's ownership").
      const claimed = await tx
        .insert(customLists)
        .values({
          id: list.id,
          userId,
          name: candidate.displayName,
          normalisedName: candidate.normalisedName,
          createdAt: new Date(list.createdAt),
          updatedAt: new Date(list.updatedAt),
          lastSyncSeq: await stampCursor(),
        })
        .onConflictDoNothing({ target: customLists.id })
        .returning({ id: customLists.id });

      let accountListId = claimed[0]?.id;
      if (accountListId === undefined) {
        // The guest uuid is taken — by another account, or by a list of this
        // account under a DIFFERENT name (the name lookup above already ruled
        // out the same name). Mint a server id rather than touching that row.
        const [fresh] = await tx
          .insert(customLists)
          .values({
            userId,
            name: candidate.displayName,
            normalisedName: candidate.normalisedName,
            createdAt: new Date(list.createdAt),
            updatedAt: new Date(list.updatedAt),
            lastSyncSeq: await stampCursor(),
          })
          .returning({ id: customLists.id });
        if (!fresh) {
          throw new Error("guest-merge: custom_lists insert returned no row");
        }
        accountListId = fresh.id;
      }

      await addMissingMembers(tx, accountListId, candidate.membership);
      await clearTombstone(tx, userId, "list", accountListId);
      byNormalisedName.set(candidate.normalisedName, accountListId);
      listCount += 1;
      mappings.push({ guestListId: list.id, accountListId });
      created += 1;
      results.push(accepted(list.id, "list"));
    }

    return {
      results,
      created,
      merged,
      rejected,
      mappings,
      serverCursor: cursor,
    };
  });
}

/**
 * Add the membership this list does not already have, and report how many rows
 * that was. UNION, never replace: the ordinary path replaces membership with the
 * client's canonical snapshot, which for a merge would delete the account's own
 * entries in favour of the guest's (§17 "union its entry membership").
 *
 * Returns 0 when nothing was missing, which is what lets the caller leave the
 * cursor and `updated_at` alone on a repeated import.
 */
async function addMissingMembers(
  tx: SyncTx,
  listId: string,
  membership: readonly number[],
): Promise<number> {
  if (membership.length === 0) return 0;
  const inserted = await tx
    .insert(customListEntries)
    .values(membership.map((entryId) => ({ listId, entryId })))
    .onConflictDoNothing()
    .returning({ entryId: customListEntries.entryId });
  return inserted.length;
}
