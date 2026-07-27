/**
 * Phase 17 §11 — SCOPED sign-out / account-switch cleanup.
 *
 * The device runs ONE shared Dexie database, so when a signed-in learner signs
 * out (or a different account signs in on the same device) the departing
 * account's private rows must go: otherwise account B could read account A's
 * bookmarks, lists, review history, FSRS cards or settings.
 *
 * Phase 16 achieved that by clearing every account-scoped STORE wholesale, which
 * necessarily destroyed a coexisting guest's rows too — a documented, deliberate
 * data-loss trade-off, only acceptable because those stores could not tell the
 * two identities apart. Schema v7 can: the owner is part of each private row's
 * identity. So the cleanup is now owner-SCOPED, which is what makes §9.1's
 * promise keepable — "Not now" must leave the guest's progress intact, and the
 * merge must still be available later:
 *
 *   - the departing account's rows are deleted from every owner-scoped store;
 *   - its queued mutations and the sync cursor go with them;
 *   - GUEST rows are preserved, so a deferred merge is still possible;
 *   - the anonymous device profile and the hash-verified content cache are
 *     preserved, exactly as before.
 *
 * WHEN THE DEPARTING ACCOUNT CANNOT BE RESOLVED (the session was already gone,
 * or a write/session resolution was interrupted — §11 requires this to work),
 * the cleanup falls back to removing EVERY non-guest owner's rows. That keeps
 * the confidentiality guarantee absolute: no account data may survive a sign-out
 * whose identity we could not establish, while the guest's rows still survive.
 *
 * Runs in ONE Dexie transaction so a partial clear can't leave a mixed-account
 * state. Browser-only.
 */
import {
  ownerScopedTables,
  type LocalOwnerId,
  type SafwaDb,
} from "@/modules/content/db";
import { GUEST_OWNER_KEY, isGuestOwnerKey } from "@/modules/content/owner-key";
import { deleteOwnedRows } from "@/modules/content/owner-scope";

/**
 * Remove the departing account's local rows, its queued mutations and the sync
 * cursor, preserving guest-owned rows, the device profile and the content cache.
 *
 * `departing` is the account signing out. Pass it whenever it is known — the
 * caller must capture it BEFORE ending the session. When it is `null`/omitted
 * the sweep removes every non-guest owner's rows instead (see the module note).
 */
export async function clearAccountLocalState(
  db: SafwaDb,
  departing: LocalOwnerId = null,
): Promise<void> {
  const tables = ownerScopedTables(db);
  await db.transaction(
    "rw",
    [...tables, db.mutationQueue, db.syncState, db.guestImports],
    async () => {
      if (departing === null) {
        // Unknown departing account: remove every row that is not the guest's.
        // A row can only be the guest's or an account's, so this is exhaustive
        // without needing to know which account it was.
        //
        // A failure here is NOT swallowed. Catching it would let Dexie treat the
        // failed delete as recovered and commit the other tables' deletes, so a
        // single failing store could silently strand a departing account's rows
        // while this function reported success — in the very branch whose job is
        // to keep the guarantee absolute when the identity could not be
        // resolved. Letting it reject rolls the whole cleanup back; the caller
        // already treats the call as best-effort, so sign-out is never blocked.
        await Promise.all(
          tables.map((table) =>
            table.filter((row) => !isGuestOwnerKey(row.ownerKey)).delete(),
          ),
        );
        // Every queued mutation belongs to an account (a guest never enqueues),
        // and every import row names the account it targets.
        await db.mutationQueue.clear();
        await db.guestImports.clear();
      } else {
        await Promise.all(
          tables.map((table) => deleteOwnedRows(table, departing)),
        );
        await db.mutationQueue.where("userId").equals(departing).delete();
        await db.guestImports.delete(departing);
      }
      // The cursor belongs to whichever account last synced on this device;
      // clearing it is equivalent to `invalidateSyncState` (`readSyncState`
      // falls back to the initial userId:null / cursor:0 state for an absent
      // row), so the next account bootstraps from scratch.
      await db.syncState.clear();
    },
  );
}

/**
 * Whether any GUEST-owned private row is still on this device. The deferred
 * merge (§9.1 "the option to merge later must remain available while guest data
 * still exists") is only offered while this is true, and it must stay true
 * across a sign-out — which is precisely what the scoped cleanup above
 * guarantees.
 */
export async function hasGuestOwnedRows(db: SafwaDb): Promise<boolean> {
  for (const table of ownerScopedTables(db)) {
    const count = await table.where("ownerKey").equals(GUEST_OWNER_KEY).count();
    if (count > 0) return true;
  }
  return false;
}
