/**
 * The last account id this device saw a real session for (Phase 18 §2, §2.1).
 *
 * {@link classifySessionIdentity} can now answer `unknown` — "the server did
 * not tell us" — but a verdict of `unknown` is only useful if something
 * remembers who the learner was the last time the server DID tell us.
 * That memory is this module. On an offline cold boot it is the difference
 * between writing rows owned by the account and writing rows owned by a guest
 * the learner never was (CLAUDE.md hard rule 8).
 *
 * WHY `localStorage` AND NOT DEXIE. The owner is the *key* used to read and
 * write every owner-scoped Dexie store (`modules/content/owner-scope.ts`), so
 * keeping it inside one of those stores would be circular: you would need the
 * owner to look up the owner. It also has to be readable synchronously and
 * very early, before any async database open resolves. `localStorage` is the
 * same mechanism the repository already uses for the non-Dexie UI-preference
 * mirrors that `signOutAndClearLocalState` clears.
 *
 * WHY NO TTL. An expiring memory reintroduces the exact bug on the first day
 * after expiry, and a bug that appears on day 8 is far harder to find than one
 * that appears immediately. The memory's bound is an explicit forget on an
 * identity change instead — a classified `guest`, sign-out, or account
 * deletion (§2.1). A clock could not fix the account-deletion case anyway: a
 * re-registered learner's old id is wrong the instant it changes, not
 * eventually.
 *
 * WHAT IS STORED. Exactly the account id, nothing else — no envelope, no
 * timestamp, no JSON. The format version lives in the key, so a future format
 * change is a new key rather than a parser that must tolerate both. Anything
 * read back is re-validated through {@link isValidOwnerAccountId}, so a
 * tampered or truncated value degrades to "no memory" rather than to a
 * malformed owner key that would throw at the first write.
 *
 * EVERY ACCESS IS FALLIBLE. Reading `localStorage` at all throws in a
 * sandboxed iframe with storage blocked; `setItem` throws in Safari private
 * mode and when a quota is exceeded; and none of it exists during SSR or
 * prerendering, which matters because ~20 of this app's routes are
 * prerendered. So every entry point here is total: it degrades to
 * "no memory available" and never propagates an exception into a render or a
 * write path.
 */

import { isValidOwnerAccountId } from "@/modules/content/owner-key";

/**
 * The storage key. Versioned (`.v1`) so that a future change of what is stored
 * is a different key rather than a value this one must be able to parse.
 * Namespaced under `safwa.` to sit unambiguously beside the app's other
 * localStorage entries.
 */
export const LAST_KNOWN_OWNER_STORAGE_KEY = "safwa.last-known-owner.v1";

/** The narrow slice of the Storage API this module uses. */
export type LastKnownOwnerStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

/**
 * The ambient `localStorage`, or `null` when there is none to use. The access
 * itself is inside the `try`: a sandboxed iframe with storage disabled throws
 * on the *property read*, not merely on the method call, so testing
 * `typeof window === "undefined"` is not sufficient.
 */
function ambientStorage(): LastKnownOwnerStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * The stored owner, THROWING if the read itself fails.
 *
 * Deliberately not total, and used only where the difference matters: the two
 * mutators below verify their work by reading it back, and a swallowed read
 * failure there would turn "I could not check" into "confirmed" — the exact
 * "it did not throw, so it worked" fallacy the verification exists to close,
 * merely moved one layer down. {@link readLastKnownOwner} is the total wrapper
 * for callers who only want an answer.
 */
function readStoredOwner(storage: LastKnownOwnerStorage): string | null {
  const stored = storage.getItem(LAST_KNOWN_OWNER_STORAGE_KEY);
  return isValidOwnerAccountId(stored) ? stored : null;
}

/**
 * The account id this device last saw a real session for, or `null` when there
 * is none, storage is unavailable, or the stored value is no longer usable as
 * an owner account id.
 *
 * A value that fails validation is left in place rather than deleted. It is
 * already inert — it yields `null` here, so the caller falls back to the guest
 * owner exactly as if nothing were stored — and the next successful sign-in
 * overwrites it. Deleting it would add a write (and another failure mode) to a
 * read path in exchange for nothing.
 *
 * DO NOT use this to re-verify a {@link rememberLastKnownOwner} or
 * {@link forgetLastKnownOwner}. It is total by design, so a read that FAILED
 * and a value that is genuinely ABSENT both come back as `null` — checking a
 * forget with it would report "confirmed gone" for a storage that merely
 * refused to answer. That is the precise fallacy those two functions' boolean
 * return values exist to resolve, using a non-swallowing read internally.
 * Branch on the boolean; never on a follow-up read.
 */
export function readLastKnownOwner(
  storage: LastKnownOwnerStorage | null = ambientStorage(),
): string | null {
  if (!storage) return null;
  try {
    return readStoredOwner(storage);
  } catch {
    return null;
  }
}

/**
 * Record `accountId` as the last known owner. Never throws: a storage failure
 * (private mode, quota) must not break the sign-in that triggered it — the
 * cost is only that a later offline cold boot has no memory to fall back on.
 *
 * An id that is not usable as an owner account id is REFUSED rather than
 * stored, so this module can never be the source of a value that
 * {@link accountOwnerKey} would later throw on.
 *
 * Returns whether the memory is now actually in place. See
 * {@link forgetLastKnownOwner} for why the result is READ BACK rather than
 * inferred from the absence of an exception.
 */
export function rememberLastKnownOwner(
  accountId: string,
  storage: LastKnownOwnerStorage | null = ambientStorage(),
): boolean {
  if (!storage || !isValidOwnerAccountId(accountId)) return false;
  try {
    storage.setItem(LAST_KNOWN_OWNER_STORAGE_KEY, accountId);
    return readStoredOwner(storage) === accountId;
  } catch {
    return false;
  }
}

/**
 * Drop the memory. Called on the three identity changes of §2.1 — a classified
 * `guest`, sign-out, and account deletion — and on nothing else. Never throws,
 * for the same reason as above: a sign-out must not fail because storage
 * refused a delete.
 *
 * Returns whether the memory is now actually gone, and establishes that by
 * READING BACK rather than by trusting that `removeItem` returned normally.
 * Two distinct failures hide behind "it did not throw": a storage that rejects
 * the delete with an exception, and one that accepts it and does nothing. Both
 * leave a stale owner behind, and this is the sign-out and account-deletion
 * path — the one place a stale owner matters most, because on a shared device
 * the next person's offline writes would be stamped with the departing
 * account's key.
 *
 * The second of those failures gets a real second attempt (see below), and it
 * lives HERE rather than at either call site, so sign-out and account deletion
 * cannot drift apart in how hard they try. `false` means every avenue this
 * module has was tried and the memory may still be readable; there is nothing
 * further a caller can do about it, which is why this stays total rather than
 * throwing.
 */
export function forgetLastKnownOwner(
  storage: LastKnownOwnerStorage | null = ambientStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(LAST_KNOWN_OWNER_STORAGE_KEY);
    if (readStoredOwner(storage) === null) return true;
  } catch {
    return false;
  }

  // The delete returned normally and the value is STILL there. Repeating the
  // same call would do the same nothing, so NEUTRALISE it instead: an empty
  // string can never be a valid owner account id, so every reader — which
  // re-validates, always — treats it as no memory at all. This is a different
  // operation against the same store, which is the only reason it might
  // succeed where the delete silently did not.
  try {
    storage.setItem(LAST_KNOWN_OWNER_STORAGE_KEY, "");
    return readStoredOwner(storage) === null;
  } catch {
    return false;
  }
}
