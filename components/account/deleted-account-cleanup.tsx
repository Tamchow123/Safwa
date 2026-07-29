"use client";

/**
 * Phase 17 §11 (final paragraph) — clearing a DELETED account's local rows.
 *
 * Deletion is confirmed by Better Auth's own emailed endpoint, so nothing in
 * this app runs at the moment the account actually goes: the learner clicks a
 * link in their mail, the server deletes the row and its cascades, and the
 * browser is redirected back. Every ordinary departure runs
 * `clearAccountLocalState` on the way out; this one has no way out to run on,
 * which is why a deleted account's private rows would otherwise sit in this
 * device's IndexedDB indefinitely.
 *
 * So the deletion callback lands HERE, and this component does on arrival what
 * sign-out does on departure — for the one account that was actually deleted.
 *
 * WHAT MAKES THE ARRIVAL BELIEVABLE. The marker in the URL is a NONCE, not a
 * flag. `pending-account-deletion.ts` minted it when the learner asked to
 * delete their account, kept it here, and handed the matching
 * `/?account-deleted=<nonce>` to Better Auth as the callback — which Better
 * Auth carries inside the emailed link and only redirects to AFTER the account
 * is gone. A browser arriving with a nonce this device recognises has therefore
 * arrived from a deletion that really happened. A crafted link cannot: the
 * nonce exists only in this device's storage and in the learner's own mailbox,
 * and anyone holding that mail could delete the account outright instead.
 *
 * Two designs were tried before this one and both were wrong, which is why the
 * reasoning is written down rather than assumed:
 *
 *   - a CONSTANT marker (`?account-deleted=1`) authorises nothing. Anyone could
 *     append it to a link and wipe a signed-in learner's local rows, including
 *     mutations queued but not yet pushed, which exist nowhere else;
 *   - a marker plus "nobody is signed in" is not much better. A session ends
 *     for reasons that are not deletion — this app sets
 *     `revokeSessionsOnPasswordReset`, and sessions expire on their own — so a
 *     learner who requested a deletion, changed their mind and reset their
 *     password would still be one crafted link away from losing live data.
 *
 * The nonce sidesteps both: it is evidence of the deletion itself, not of some
 * state that a deletion happens to produce. It also needs no network call, so
 * there is no third outcome where the answer is unknown.
 *
 * WHAT IT REMOVES. `clearAccountLocalState(db, <the recorded account>)` — that
 * account's rows, its queued mutations and the sync cursor. Scoped, not the
 * unknown-account sweep: a device where two accounts have studied loses only
 * the one that was actually deleted, and a guest's rows are preserved either
 * way, which is §11's policy and keeps a deferred merge possible.
 *
 * IF THE SWEEP FAILS the nonce stays in the URL, so a reload retries it. That
 * is bounded: once the record passes its TTL the nonce stops matching and the
 * URL is cleaned up on the next load regardless. The alternative — dropping the
 * marker on failure — was the earlier behaviour and it silently forecloses the
 * only retry path, leaving a deleted account's rows on the device forever after
 * one transient IndexedDB error.
 *
 * KNOWN LIMIT, stated rather than papered over: the record lives on the device
 * that REQUESTED the deletion. A learner who requests it on their laptop and
 * opens the mail on their phone leaves the laptop's rows in place until that
 * laptop signs out (which clears them by the ordinary path). Closing that would
 * mean trusting something weaker than the nonce, and the rows in question can
 * no longer sync to anything.
 */
import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { forgetLastKnownOwner } from "@/modules/auth/last-known-owner";
import { getSafwaDb } from "@/modules/content/db";
import { clearOwnerSensitiveCachesIfAvailable } from "@/modules/pwa/cache-storage";
import { clearAccountLocalState } from "@/modules/sync/client/logout";
import {
  forgetPendingAccountDeletion,
  readPendingAccountDeletion,
} from "./pending-account-deletion";

/**
 * The query parameter Better Auth's delete-account callback returns with. Its
 * VALUE is the one-time nonce — the parameter name is public and means nothing
 * on its own.
 */
export const ACCOUNT_DELETED_PARAM = "account-deleted";

/**
 * Where the delete-account confirmation link returns to, for a given request's
 * nonce. Built here rather than spelled out in the dialog so the reader and the
 * writer of this URL cannot drift apart.
 */
export function deletedAccountCallback(nonce: string): string {
  return `/?${ACCOUNT_DELETED_PARAM}=${encodeURIComponent(nonce)}`;
}

/**
 * The nonce currently being processed, if any — the ONLY thing guarding against
 * a duplicate sweep.
 *
 * The decision to sweep is taken SYNCHRONOUSLY on entry, so a per-run
 * `cancelled` flag cannot help: React 19's StrictMode mounts, cleans up and
 * remounts an effect, and the first run's `clearAccountLocalState` is already in
 * flight by the time its own cleanup fires. Worse, gating the FINALISATION on
 * such a flag actively breaks it — the run that did the work is precisely the
 * one whose cleanup has already run, so it would skip spending the nonce after
 * a sweep that genuinely succeeded, and the URL would sit there looking like a
 * failure. A module-level guard is the right shape because the duplicate is a
 * different component instance, not a second render of one.
 *
 * It is deliberately per-document. Two TABS landing on the same callback can
 * both sweep; that is harmless — `clearAccountLocalState` is transactional and
 * idempotent, both read the same authorising record, and a duplicate spend and
 * navigate are no-ops.
 */
let inFlightNonce: string | null = null;

export function DeletedAccountCleanup() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const nonce = params.get(ACCOUNT_DELETED_PARAM) ?? "";

  useEffect(() => {
    if (nonce.length === 0) return;
    if (inFlightNonce === nonce) return;

    const deleted = readPendingAccountDeletion(nonce, Date.now());
    if (deleted === null) {
      // Not a deletion this device can vouch for — a stale link, someone
      // else's, or a request that has since expired. Nothing is touched, and
      // the URL is tidied so it stops carrying a value that means nothing.
      router.replace(pathname);
      return;
    }

    inFlightNonce = nonce;

    // Forget the durable last-known owner (Phase 18 §2.1) BEFORE the Dexie
    // sweep, and unconditionally on a deletion this device vouched for.
    //
    // It has to be here and not only in sign-out, because a TTL-free memory
    // would otherwise outlive the account it names: delete, re-register, then
    // go offline before the new account completes one successful session check,
    // and an `unknown` classification would resolve to the DELETED account's
    // id and stamp fresh offline reviews with a dead owner key. No clock could
    // have fixed that — the id is wrong the instant it changes, not eventually.
    //
    // Unconditional rather than only-if-it-matches-`deleted`: if the memory
    // somehow named a different account, forgetting still degrades only to the
    // guest fallback, which is the safe direction. Not gated on the sweep
    // either — a stale owner is wrong whether or not the rows were removed.
    forgetLastKnownOwner();

    // Cache Storage goes with the Dexie sweep, not after it (Phase 18 §7).
    // Account deletion is the strongest "forget this device" signal there is,
    // and a cached document or RSC payload can carry the deleted account's
    // rendered data — with no session left to sign out of, this is the last
    // code path that will ever run for that account. Not chained onto the
    // sweep's `then`, because it must happen even if the Dexie side fails.
    void clearOwnerSensitiveCachesIfAvailable();

    void clearAccountLocalState(getSafwaDb(), deleted)
      .then(() => {
        // Spent, so the same link cannot replay a completed cleanup. Not gated
        // on the component still being mounted: the sweep succeeded, and a
        // `router.replace` after unmount is a no-op, whereas skipping this
        // would leave a spent nonce advertising itself in the URL.
        forgetPendingAccountDeletion();
        router.replace(pathname);
      })
      .catch(() => {
        // Leave BOTH the record and the nonce in place: the URL is the only
        // thing that brings us back here, so dropping it would turn one
        // transient IndexedDB failure into rows that outlive their account
        // permanently. A reload retries, and the TTL bounds the retrying.
      })
      .finally(() => {
        inFlightNonce = null;
      });
  }, [nonce, router, pathname]);

  return null;
}
