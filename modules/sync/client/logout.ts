/**
 * Phase 16 — clear account-synced local state on logout / account switch
 * (§18; discharges SEC-002-T15d). The device runs ONE shared Dexie database
 * (not partitioned by account), so when a signed-in learner logs out or a
 * different account signs in on the same device, the previous account's synced
 * learner state must be wiped — otherwise account B could read account A's
 * bookmarks, lists, review history, FSRS cards or settings until (if ever) B's
 * own sync happens to overwrite the same rows.
 *
 * The set of account-owned stores is the SINGLE SOURCE OF TRUTH `accountScopedTables`
 * exported by the schema owner (modules/content/db.ts) — never hand-enumerated
 * here — so a future account-owned store can't be silently missed. The device
 * profile and the shared content cache are deliberately preserved. Because the
 * server is authoritative, the next sign-in re-pulls everything (§18).
 *
 * NOTE: non-Dexie UI-preference MIRRORS in `localStorage` (theme, arabic font
 * scale) are intentionally NOT cleared here — those are device-level cosmetic
 * preferences, not account-private learner data. The sign-out handler clears
 * them separately so a returning-to-defaults experience is a UI concern, not a
 * confidentiality one.
 *
 * Runs in ONE Dexie transaction so a partial clear can't leave a mixed-account
 * state. Browser-only.
 */
import { accountScopedTables, type SafwaDb } from "@/modules/content/db";

/**
 * Wipe every account-synced local store + the sync cursor. Call this on
 * sign-out and on an account switch BEFORE the next account's first sync, so no
 * prior account's private data can be read on a shared device. Clearing the
 * `sync_state` store is equivalent to `invalidateSyncState` — `readSyncState`
 * falls back to the initial (userId:null, cursor:0) state for an absent row.
 */
export async function clearAccountLocalState(db: SafwaDb): Promise<void> {
  const tables = accountScopedTables(db);
  await db.transaction("rw", tables, async () => {
    await Promise.all(tables.map((table) => table.clear()));
  });
}
