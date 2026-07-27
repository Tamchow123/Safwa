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
 * BLAST RADIUS — this is a WHOLESALE clear, not an owner-filtered delete
 * (SEC-003). Since schema v6 a guest's rows (`userId` null) share these physical
 * tables with an account's, so a guest's own local bookmarks/lists/settings and
 * study history on this device are destroyed too, not just the departing
 * account's. That is DELIBERATE and human-approved: the shared-device
 * confidentiality guarantee is the whole point of the wipe, a partial wipe would
 * leave rows whose owner cannot be re-verified after the session is gone, and
 * the E2E contract was updated to assert it (e2e/auth.spec.ts §60.9, commit
 * 30fa7ee, superseding the earlier Phase-15 "guest data survives login/logout"
 * expectation). It is a data-loss trade-off on shared devices, never a
 * confidentiality leak. `clearAccountLocalState wipes a coexisting GUEST's rows
 * too` in logout.test.ts pins the behaviour so it can only change deliberately.
 * Per-identity coexistence across a sign-out needs composite `[userId+key]`
 * primary keys and belongs with the Phase-17 guest-merge work.
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
