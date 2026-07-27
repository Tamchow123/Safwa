/**
 * Phase 16 — apply push results to local events (§19, push side). After a push,
 * the server returns one result per submitted item. This marks each local
 * scheduling event's `syncStatus` by its result so the next selection doesn't
 * re-send an accepted event, and a recoverably-rejected event stays sendable:
 *
 *   accepted / corrected / duplicate → "accepted" (server has it; corrections
 *       are applied by the subsequent pull's authoritative component state);
 *   pending                          → "pushed"   (held server-side, e.g. an
 *       out-of-order parent; resolved by a later push/pull);
 *   rejected + recoverable           → left "local" (retry after a pull/rebase,
 *       e.g. stale_branch_conflict);
 *   rejected + NOT recoverable       → "rejected" (a hard conflict, won't retry).
 *
 * Only `event` results touch local events; attempt/bookmark/list/setting/
 * revocation results are handled by their own reconcile paths. Unknown local
 * event ids are ignored. Browser-only (Dexie).
 */
import type { SafwaDb, ReviewEventRecord } from "@/modules/content/db";
import type { SyncItemResult } from "@/modules/sync/protocol";

type LocalSyncStatus = ReviewEventRecord["syncStatus"];

/** The local syncStatus a push result implies, or null to leave the row as-is. */
function statusForResult(result: SyncItemResult): LocalSyncStatus | null {
  switch (result.status) {
    case "accepted":
    case "corrected":
    case "duplicate":
      return "accepted";
    case "pending":
      return "pushed";
    case "rejected":
      // A recoverable rejection stays "local" so it is re-selected and retried
      // after the client pulls/rebases; a non-recoverable one is terminal.
      return result.recoverable ? "local" : "rejected";
    default:
      return null;
  }
}

/**
 * Mark local events by their push results. Runs in one Dexie transaction so the
 * marks apply atomically. Returns the number of events whose status changed.
 */
export async function applyPushResults(
  db: SafwaDb,
  results: readonly SyncItemResult[],
): Promise<number> {
  const eventResults = results.filter((result) => result.itemKind === "event");
  if (eventResults.length === 0) return 0;

  return db.transaction("rw", [db.reviewEvents], async () => {
    let changed = 0;
    for (const result of eventResults) {
      const next = statusForResult(result);
      if (next === null) continue;
      const existing = await db.reviewEvents.get(result.itemId);
      if (!existing || existing.syncStatus === next) continue;
      await db.reviewEvents.update(result.itemId, { syncStatus: next });
      changed++;
    }
    return changed;
  });
}
