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
import {
  DEFAULT_SESSION_DEFAULTS,
  sanitizeSessionDefaults,
} from "@/modules/profile/session-defaults-core";
import { SETTING_KEYS } from "@/modules/profile/setting-keys";
import type { PullResponse } from "@/modules/sync/protocol";

import { foldPulledSettings } from "./settings-sync";
import { recordSyncProgress } from "./sync-state";

/** Map a pulled event status to the local ReviewEventRecord.status vocabulary. */
type LocalEventStatus =
  | "scheduling"
  | "reinforcement"
  | "conflict_demoted"
  | "revoked"
  | "pending_parent";

/**
 * The server-authoritative preference values (§23) a pulled page carried, if
 * any, for the caller to adopt into their localStorage MIRRORS (R2-F5). Kept as
 * raw values (validated at the mirror-adoption boundary); absent keys mean the
 * page changed no such setting. This module stays pure-Dexie — the mirror/DOM
 * side-effect is the browser caller's (orchestrator) job.
 */
export type PulledSettingMirrors = {
  theme?: unknown;
  arabicFontScale?: unknown;
};

/**
 * Apply one pulled page for `userId` and advance the cursor to
 * `pull.serverCursor`. Idempotent: re-applying the same page is a no-op (puts
 * are upserts, deletes/status-marks converge). Returns the pulled preference
 * mirror values (R2-F5) for the caller to adopt; throws only on a genuine Dexie
 * failure (the caller treats that as a recoverable sync failure).
 */
export async function applyPullResponse(
  db: SafwaDb,
  userId: string,
  pull: PullResponse,
  now: number,
): Promise<PulledSettingMirrors> {
  const mirrors: PulledSettingMirrors = {};
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
          // Stamp the account owner (R2-F3) so this authoritative card is scoped
          // to the account and never read as, or overwritten by, a guest's row
          // for the same natural key.
          userId,
          fsrs: component.card ?? undefined,
          learnerState: component.learnerState,
          revision: component.revision,
          // Store the lineage anchor (R2-F2) so a device with no local events
          // for this component extends the server chain on its next review
          // instead of rooting a rejected stale branch. `?? null` normalises an
          // older server that omits the field.
          syncedHeadEventId: component.headEventId ?? null,
          syncedHeadClientRevision: component.headClientRevision ?? null,
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
          userId,
        );
      }
      for (const list of pull.lists) {
        await applyAuthoritativeList(db, list, userId);
      }
      // Settings are mapped from the server's camelCase keys/values back to the
      // LOCAL kebab keys/shapes the app reads (§23, EXT-F2) — the inverse of the
      // push mapping. The four session-defaults keys merge into the one local
      // `session-defaults` blob, so we read its current value first.
      if (pull.settings.length > 0) {
        // Read the account's OWN current session-defaults blob to merge the
        // pulled per-key changes into (R2-F3): a row owned by a different
        // identity (a pre-login guest's) must not seed the account's merge.
        const currentDefaultsRow = await db.settings.get(
          SETTING_KEYS.sessionDefaults,
        );
        const currentDefaults = sanitizeSessionDefaults(
          currentDefaultsRow && (currentDefaultsRow.userId ?? null) === userId
            ? currentDefaultsRow.value
            : DEFAULT_SESSION_DEFAULTS,
        );
        const folded = foldPulledSettings(pull.settings, currentDefaults);
        for (const put of folded.directPuts) {
          // Stamp the account owner (R2-F3) so a pulled account setting is scoped
          // to the account, not read as a guest's value for the same key.
          await db.settings.put({ ...put, userId });
          // R2-F5: surface the theme / font-scale values so the caller can
          // force their localStorage mirrors — otherwise the stale mirror would
          // shadow this pulled value on the next reconcile and the second
          // context would never display the synced setting (§23).
          if (put.key === SETTING_KEYS.theme) mirrors.theme = put.value;
          else if (put.key === SETTING_KEYS.arabicFontScale) {
            mirrors.arabicFontScale = put.value;
          }
        }
        if (folded.sessionDefaults) {
          await db.settings.put({
            key: SETTING_KEYS.sessionDefaults,
            value: folded.sessionDefaults,
            updatedAt: folded.sessionDefaultsUpdatedAt,
            userId,
          });
        }
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
  return mirrors;
}
