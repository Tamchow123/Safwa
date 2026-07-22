/**
 * Phase 16 — local reconciliation of a pulled page (§19). Applies the server's
 * authoritative changes into Dexie so a second browser context bootstraps and a
 * synced device rebases onto canonical state:
 *
 *   - upsert authoritative component states (the full FSRS card + effective
 *     learner state + revision are server-derived — the client trusts them);
 *   - mark KNOWN local events by their canonical server status, WITHOUT
 *     clobbering a not-yet-pushed local event (`syncStatus === "local"`);
 *   - upsert pulled bookmarks / lists / settings;
 *   - apply tombstones (delete the local bookmark/list they name);
 *   - advance the account pull cursor.
 *
 * Local study attempts are never deleted (history is retained). The whole page
 * applies in ONE Dexie transaction so a partial apply can't leave a torn cursor.
 * Browser-only (Dexie).
 */
import {
  applyAuthoritativeBookmark,
  applyAuthoritativeList,
  applyBookmarkTombstone,
  applyListTombstone,
} from "@/modules/collections/persistence";
import type { SafwaDb } from "@/modules/content/db";
import type { PullResponse } from "@/modules/sync/protocol";

import { recordSyncProgress } from "./sync-state";

/** Map a pulled event status to the local ReviewEventRecord.status vocabulary. */
type LocalEventStatus =
  | "scheduling"
  | "reinforcement"
  | "conflict_demoted"
  | "revoked"
  | "pending_parent";

/**
 * Apply one pulled page for `userId` and advance the cursor to
 * `pull.serverCursor`. Idempotent: re-applying the same page is a no-op (puts
 * are upserts, deletes/status-marks converge). Returns nothing; throws only on a
 * genuine Dexie failure (the caller treats that as a recoverable sync failure).
 */
export async function applyPullResponse(
  db: SafwaDb,
  userId: string,
  pull: PullResponse,
  now: number,
): Promise<void> {
  await db.transaction(
    "rw",
    [
      db.studyComponents,
      db.reviewEvents,
      db.bookmarks,
      db.lists,
      db.settings,
      db.syncState,
    ],
    async () => {
      // 1. Authoritative component states (card fields === WireCard === fsrs).
      //    `masteryDates` is intentionally NOT persisted client-side in Stage A:
      //    the local mastery view is projected from review_events; only the FSRS
      //    card + effective learner state are stored authoritatively here.
      for (const component of pull.components) {
        await db.studyComponents.put({
          componentKey: component.componentKey,
          entryId: component.entryId,
          fsrs: component.card ?? undefined,
          learnerState: component.learnerState,
          revision: component.revision,
        });
      }

      // 2. Mark KNOWN local events by canonical server status. A not-yet-pushed
      //    local event (syncStatus === "local") is never overwritten — the
      //    server can't yet know about it, so preserve the local optimistic row.
      for (const event of pull.events) {
        const existing = await db.reviewEvents.get(event.eventId);
        if (!existing || existing.syncStatus === "local") continue;
        await db.reviewEvents.update(event.eventId, {
          status: event.status as LocalEventStatus,
          syncStatus: event.status === "revoked" ? "rejected" : "accepted",
        });
      }

      // 3. Bookmarks / lists / settings. Bookmarks/lists go through the
      //    collections persistence adapter (the single writer of those stores),
      //    which canonicalises membership/name so the local invariants hold; it
      //    runs inside THIS transaction. Settings are a plain key/value upsert.
      for (const bookmark of pull.bookmarks) {
        await applyAuthoritativeBookmark(
          db,
          bookmark.entryId,
          bookmark.createdAt,
        );
      }
      for (const list of pull.lists) {
        await applyAuthoritativeList(db, list);
      }
      for (const setting of pull.settings) {
        await db.settings.put({
          key: setting.key,
          value: setting.value,
          updatedAt: setting.updatedAt,
        });
      }

      // 4. Tombstones — propagate deletions from another context. Applied after
      //    upserts so a (never-coexisting) same-page add+delete resolves deleted.
      for (const tombstone of pull.tombstones) {
        if (tombstone.kind === "bookmark") {
          const entryId = Number(tombstone.ref);
          if (Number.isInteger(entryId)) {
            await applyBookmarkTombstone(db, entryId);
          }
        } else {
          await applyListTombstone(db, tombstone.ref);
        }
      }

      // 5. Advance the account cursor (scoped to userId — the account-switch
      //    guard lives in sync-state).
      await recordSyncProgress(db, userId, pull.serverCursor, now);
    },
  );
}
