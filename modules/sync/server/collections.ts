/**
 * Phase 16 — bookmarks + custom-list sync (§21, §22). Authenticated, idempotent
 * upserts/deletes with server-derived ownership (userId from the session only),
 * canonical list membership, per-user normalised-name uniqueness, entry-id
 * validation against the active release, and tombstones for deletions so a pull
 * can propagate them to a second browser context.
 *
 * ACCOUNT precedence: for a signed-in user the server state is authoritative
 * after reconciliation (§21). Guest-local collections are NOT merged on login
 * in Phase 16 (that is Phase 17).
 *
 * Each KIND (bookmarks, lists) is processed in ONE transaction under a single
 * per-account advisory lock, in two phases:
 *   1. VALIDATE every item with reads only (no writes, no cursor). List
 *      ownership is a plain SELECT — never `FOR UPDATE` on a possibly-foreign
 *      row (that lock would be held for the whole batch, since Postgres releases
 *      row locks only at the top-level transaction boundary, not at a savepoint).
 *   2. Bump the account cursor ONCE in the OUTER transaction (only if ≥1 item
 *      will be written), then apply each accepted item in its own SAVEPOINT so a
 *      single failing write is isolated to a recoverable `internal_error`. The
 *      cursor bump lives in the outer tx, so a per-item savepoint rollback can
 *      NEVER undo it (which would otherwise orphan a committed row's
 *      `last_sync_seq` above the persisted account cursor).
 *
 * The account's own same-kind writes are mutually excluded by the per-account
 * advisory lock, so a plain read + a `userId`-scoped upsert are race-safe
 * without per-row `FOR UPDATE`.
 *
 * `server-only`.
 */
import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { getDb, type Database } from "@/db/client";
import {
  bookmarks,
  customListEntries,
  customLists,
  syncTombstones,
} from "@/db/schema";
import {
  canonicaliseMembership,
  isValidEntryId,
  resolvableMembership,
  validateListName,
} from "@/modules/collections/validation";
import { getActiveRelease } from "@/modules/content/server-release-registry";
import {
  isRecoverableReason,
  type SyncItemResult,
  type SyncReasonCode,
  type WireBookmark,
  type WireList,
} from "@/modules/sync/protocol";

import { writeSyncAudit, type SyncAuditEntry } from "./audit";
import { currentAccountCursor, nextAccountCursor, type SyncTx } from "./cursor";

export type CollectionsSyncOptions = {
  correlationId?: string;
  /** Test-only override forwarded to getActiveRelease (never in production). */
  registryDir?: string;
};

export type CollectionsSyncResult = {
  results: SyncItemResult[];
  serverCursor: number;
};

type ItemKind = "bookmark" | "list";

/** The set of entry ids the active release can resolve (for validation). */
async function activeEntryIds(
  options: CollectionsSyncOptions,
): Promise<ReadonlySet<number>> {
  const release = await getActiveRelease(
    options.registryDir ? { registryDir: options.registryDir } : {},
  );
  return new Set(release.learner.entries.map((entry) => entry.id));
}

function reject(
  itemId: string,
  itemKind: ItemKind,
  reasonCode: SyncReasonCode,
): SyncItemResult {
  return {
    itemId,
    itemKind,
    status: "rejected",
    reasonCode,
    duplicate: false,
    recoverable: isRecoverableReason(reasonCode),
  };
}

function accepted(itemId: string, itemKind: ItemKind): SyncItemResult {
  return {
    itemId,
    itemKind,
    status: "accepted",
    reasonCode: "accepted",
    duplicate: false,
    recoverable: false,
  };
}

/** Audit a rejection/anomaly, then return the rejection result (paired so a
 *  branch can never reject without leaving the monitoring signal §17). */
async function rejectAndAudit(
  db: Database | SyncTx,
  entry: Omit<SyncAuditEntry, "severity"> & {
    severity?: SyncAuditEntry["severity"];
  },
  itemKind: ItemKind,
  reasonCode: SyncReasonCode,
): Promise<SyncItemResult> {
  await writeSyncAudit(db, { severity: "warning", ...entry });
  return reject(entry.itemId, itemKind, reasonCode);
}

/** Delete any tombstone shadowing a re-created collection item. */
async function clearTombstone(
  tx: SyncTx,
  userId: string,
  kind: ItemKind,
  ref: string,
): Promise<void> {
  await tx
    .delete(syncTombstones)
    .where(
      and(
        eq(syncTombstones.userId, userId),
        eq(syncTombstones.kind, kind),
        eq(syncTombstones.ref, ref),
      ),
    );
}

/** Upsert a tombstone (idempotent) and stamp it with the cursor. */
async function writeTombstone(
  tx: SyncTx,
  userId: string,
  kind: ItemKind,
  ref: string,
  cursor: number,
): Promise<void> {
  await tx
    .insert(syncTombstones)
    .values({ userId, kind, ref, lastSyncSeq: cursor })
    .onConflictDoUpdate({
      target: [syncTombstones.userId, syncTombstones.kind, syncTombstones.ref],
      set: { lastSyncSeq: cursor },
    });
}

/** Write one out-of-band `internal_error` audit for an aborted item (never
 *  masks the original error). */
async function auditInternalError(
  db: Database,
  userId: string,
  itemKind: ItemKind,
  itemId: string,
  options: CollectionsSyncOptions,
): Promise<void> {
  try {
    await writeSyncAudit(db, {
      userId,
      itemKind,
      itemId,
      reasonCode: "internal_error",
      severity: "critical",
      correlationId: options.correlationId,
    });
  } catch {
    // Never let audit failure mask the original error handling.
  }
}

/** Process all bookmarks in ONE advisory-locked transaction (validate → bump
 *  cursor once in the outer tx → savepoint-per-write). */
async function processBookmarks(
  db: Database,
  userId: string,
  items: WireBookmark[],
  knownEntryIds: ReadonlySet<number>,
  options: CollectionsSyncOptions,
): Promise<SyncItemResult[]> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${userId}:bookmarks`}), 0)`,
    );
    const results = new Array<SyncItemResult | null>(items.length).fill(null);

    // Phase 1: validate (reads only) — an upsert must reference a resolvable
    // entry; a delete may target any positive-integer id.
    const toWrite: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const ref = String(item.entryId);
      const invalid =
        !isValidEntryId(item.entryId) ||
        (!item.deleted && !knownEntryIds.has(item.entryId));
      if (invalid) {
        results[i] = await rejectAndAudit(
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
        );
        continue;
      }
      toWrite.push(i);
    }

    // Phase 2: one cursor bump in the OUTER tx (safe from savepoint rollback).
    const cursor = toWrite.length > 0 ? await nextAccountCursor(tx, userId) : 0;
    for (const i of toWrite) {
      const item = items[i]!;
      const ref = String(item.entryId);
      try {
        await tx.transaction(async (sp) => {
          if (item.deleted) {
            await sp
              .delete(bookmarks)
              .where(
                and(
                  eq(bookmarks.userId, userId),
                  eq(bookmarks.entryId, item.entryId),
                ),
              );
            await writeTombstone(sp, userId, "bookmark", ref, cursor);
          } else {
            await sp
              .insert(bookmarks)
              .values({
                userId,
                entryId: item.entryId,
                createdAt: new Date(item.createdAt),
                lastSyncSeq: cursor,
              })
              .onConflictDoUpdate({
                target: [bookmarks.userId, bookmarks.entryId],
                set: { lastSyncSeq: cursor },
              });
            await clearTombstone(sp, userId, "bookmark", ref);
          }
        });
        results[i] = accepted(ref, "bookmark");
      } catch (error) {
        console.error(`[sync] collections: bookmark ${ref} aborted`, error);
        await auditInternalError(db, userId, "bookmark", ref, options);
        results[i] = reject(ref, "bookmark", "internal_error");
      }
    }
    return results as SyncItemResult[];
  });
}

/** A validated list operation ready to apply in phase 2. */
type ListPlan =
  | { index: number; list: WireList; action: "delete" }
  | {
      index: number;
      list: WireList;
      action: "upsert";
      displayName: string;
      normalisedName: string;
      canonical: number[];
    };

/** Process all lists in ONE advisory-locked transaction (validate → bump cursor
 *  once in the outer tx → savepoint-per-write). */
async function processLists(
  db: Database,
  userId: string,
  items: WireList[],
  knownEntryIds: ReadonlySet<number>,
  options: CollectionsSyncOptions,
): Promise<SyncItemResult[]> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${userId}:lists`}), 0)`,
    );
    const results = new Array<SyncItemResult | null>(items.length).fill(null);
    const plans: ListPlan[] = [];

    // Phase 1: validate (reads only, no FOR UPDATE — the advisory lock already
    // serialises this account's own list writes, so a plain read is race-safe
    // and never locks a possibly-foreign row for the batch's duration).
    for (let i = 0; i < items.length; i++) {
      const list = items[i]!;
      const [existing] = await tx
        .select({ userId: customLists.userId })
        .from(customLists)
        .where(eq(customLists.id, list.id));
      if (existing && existing.userId !== userId) {
        // Cross-account id: enumeration-safe generic invalid_list.
        results[i] = await rejectAndAudit(
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
        );
        continue;
      }
      if (list.deleted) {
        plans.push({ index: i, list, action: "delete" });
        continue;
      }
      const nameCheck = validateListName(list.name);
      if (!nameCheck.valid) {
        results[i] = await rejectAndAudit(
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
        );
        continue;
      }
      const [nameClash] = await tx
        .select({ id: customLists.id })
        .from(customLists)
        .where(
          and(
            eq(customLists.userId, userId),
            eq(customLists.normalisedName, nameCheck.normalisedName),
            sql`${customLists.id} <> ${list.id}`,
          ),
        );
      if (nameClash) {
        results[i] = await rejectAndAudit(
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
        );
        continue;
      }
      plans.push({
        index: i,
        list,
        action: "upsert",
        displayName: nameCheck.displayName,
        normalisedName: nameCheck.normalisedName,
        // Canonical membership: valid ids only, deduped, sorted, narrowed to the
        // ids the active release can resolve (shared with the guest client).
        canonical: resolvableMembership(
          canonicaliseMembership(list.entryIds),
          knownEntryIds,
        ),
      });
    }

    // Phase 2: one cursor bump in the OUTER tx, then a savepoint per write.
    const cursor = plans.length > 0 ? await nextAccountCursor(tx, userId) : 0;
    for (const plan of plans) {
      try {
        results[plan.index] = await tx.transaction((sp) =>
          applyListPlan(sp, userId, plan, cursor, options),
        );
      } catch (error) {
        console.error(
          `[sync] collections: list ${plan.list.id} aborted`,
          error,
        );
        await auditInternalError(db, userId, "list", plan.list.id, options);
        results[plan.index] = reject(plan.list.id, "list", "internal_error");
      }
    }
    return results as SyncItemResult[];
  });
}

/**
 * Apply one validated list op inside its SAVEPOINT (stamped with `cursor`),
 * returning its result. The `customLists` upsert is the OWNERSHIP GATE: its
 * `ON CONFLICT DO UPDATE ... WHERE user_id = caller` only affects a row the
 * caller owns, and `.returning()` tells us whether it did. If it affected no
 * row, the id collided with another account's list (a raced, uuidv7-impossible
 * case that phase-1 could not see because the other row was not yet committed)
 * — we STOP before touching membership and reject, so we never overwrite
 * another account's list contents nor falsely report `accepted`.
 */
async function applyListPlan(
  sp: SyncTx,
  userId: string,
  plan: ListPlan,
  cursor: number,
  options: CollectionsSyncOptions,
): Promise<SyncItemResult> {
  const { list } = plan;
  if (plan.action === "delete") {
    await sp
      .delete(customLists)
      .where(and(eq(customLists.id, list.id), eq(customLists.userId, userId)));
    await writeTombstone(sp, userId, "list", list.id, cursor);
    return accepted(list.id, "list");
  }

  const upserted = await sp
    .insert(customLists)
    .values({
      id: list.id,
      userId,
      name: plan.displayName,
      normalisedName: plan.normalisedName,
      createdAt: new Date(list.createdAt),
      updatedAt: new Date(list.updatedAt),
      lastSyncSeq: cursor,
    })
    .onConflictDoUpdate({
      target: customLists.id,
      set: {
        name: plan.displayName,
        normalisedName: plan.normalisedName,
        updatedAt: new Date(list.updatedAt),
        lastSyncSeq: cursor,
      },
      // Only ever update a row that belongs to the caller.
      setWhere: eq(customLists.userId, userId),
    })
    .returning({ id: customLists.id });

  if (upserted.length === 0) {
    // The id belongs to another account (setWhere no-op'd) — reject, and touch
    // NO membership rows. Enumeration-safe generic invalid_list.
    return rejectAndAudit(
      sp,
      {
        userId,
        itemKind: "list",
        itemId: list.id,
        reasonCode: "invalid_list",
        correlationId: options.correlationId,
      },
      "list",
      "invalid_list",
    );
  }

  // Replace membership with the canonical set (deterministic snapshot). Only
  // reached once the row is confirmed to belong to the caller.
  await sp
    .delete(customListEntries)
    .where(eq(customListEntries.listId, list.id));
  if (plan.canonical.length > 0) {
    await sp
      .insert(customListEntries)
      .values(plan.canonical.map((entryId) => ({ listId: list.id, entryId })));
  }
  await clearTombstone(sp, userId, "list", list.id);
  return accepted(list.id, "list");
}

/**
 * Sync a batch of bookmarks and custom lists. Each KIND is one advisory-locked
 * transaction (validate → single cursor bump → savepoint-per-write); a
 * whole-kind transaction abort is isolated to recoverable `internal_error`
 * results for that kind's items (with an out-of-band audit) so the other kind
 * still commits. Returns one result per item and the resulting account cursor.
 */
export async function syncCollectionsBatch(
  userId: string,
  bookmarkItems: WireBookmark[],
  listItems: WireList[],
  options: CollectionsSyncOptions = {},
): Promise<CollectionsSyncResult> {
  const db = getDb();
  const results: SyncItemResult[] = [];

  const knownEntryIds =
    bookmarkItems.length > 0 || listItems.length > 0
      ? await activeEntryIds(options)
      : new Set<number>();

  if (bookmarkItems.length > 0) {
    try {
      results.push(
        ...(await processBookmarks(
          db,
          userId,
          bookmarkItems,
          knownEntryIds,
          options,
        )),
      );
    } catch (error) {
      console.error(`[sync] collections: bookmarks transaction aborted`, error);
      for (const bookmark of bookmarkItems) {
        const ref = String(bookmark.entryId);
        await auditInternalError(db, userId, "bookmark", ref, options);
        results.push(reject(ref, "bookmark", "internal_error"));
      }
    }
  }

  if (listItems.length > 0) {
    try {
      results.push(
        ...(await processLists(db, userId, listItems, knownEntryIds, options)),
      );
    } catch (error) {
      console.error(`[sync] collections: lists transaction aborted`, error);
      for (const list of listItems) {
        await auditInternalError(db, userId, "list", list.id, options);
        results.push(reject(list.id, "list", "internal_error"));
      }
    }
  }

  const serverCursor = await currentAccountCursor(db, userId);
  return { results, serverCursor };
}
