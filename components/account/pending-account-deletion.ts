/**
 * Phase 17 §11 — the local record that an account deletion was actually
 * REQUESTED from this device, and the one-time secret that proves it COMPLETED.
 *
 * It exists because the deletion callback's query flag is not evidence of
 * anything. Better Auth's confirmation link lands the browser back on our app
 * with a marker in the URL, and a constant marker is something anyone can type:
 * a link with `?account-deleted=1` appended, sent to a signed-in learner, would
 * otherwise be enough to wipe this device's copy of a live account — including
 * mutations queued locally but not yet pushed, which exist nowhere else.
 *
 * So the marker is a NONCE, not a flag, and this record is where its other half
 * lives. The delete-account dialog mints one, stores it here, and asks Better
 * Auth to return to `/?account-deleted=<nonce>`. Better Auth carries that URL
 * inside the emailed confirmation link and only redirects to it AFTER it has
 * deleted the account. So a browser arriving with a nonce that matches this
 * record has arrived from a deletion that really happened, and the ways to
 * obtain the nonce are: this device's storage, the learner's own mailbox, and
 * whatever logs the emailed link's own GET request (it rides in that URL's
 * `callbackURL`, alongside Better Auth's own single-use `token` — the same
 * class of exposure, which is why `e2e/auth.spec.ts` disables trace capture for
 * the whole file). Anyone holding the mail could delete the account for real
 * instead, and a nonce read from a log is INERT anywhere else: replay needs the
 * paired record, which only the requesting device ever wrote. Nothing an
 * attacker can send reproduces it.
 *
 * WHY NOT INFER IT FROM THE SESSION. The obvious alternative — "the marker is
 * here and nobody is signed in, so the account must be gone" — was tried and is
 * wrong. A session ends for reasons that are not deletion: this app sets
 * `revokeSessionsOnPasswordReset`, so an ordinary password reset revokes every
 * session, and sessions also simply expire. A learner who requested a deletion,
 * changed their mind, and reset their password would then be one crafted link
 * away from losing a live account's unsynced work. The nonce does not care why
 * the session ended, because it is evidence of the deletion itself.
 *
 * It also names the ACCOUNT, so the cleanup deletes that account's rows rather
 * than falling back to every non-guest owner's — a device where two accounts
 * have studied loses only the one that was actually deleted.
 *
 * It expires with the deletion token itself (`deleteTokenExpiresIn`, one day in
 * `modules/auth/server.ts`). Past that the emailed link can no longer delete
 * anything, so a record older than that can no longer be describing a real
 * deletion.
 *
 * localStorage rather than Dexie deliberately: it must survive the round trip
 * through the mail client, it must be readable before the database is opened,
 * and it holds one account id and one random string — not learning state. Every
 * access is guarded, because private-mode browsers throw on the property itself.
 */

/** Where the record lives. Namespaced like the app's other local keys. */
export const PENDING_ACCOUNT_DELETION_KEY = "safwa.pending-account-deletion";

/**
 * How long the record stays valid — one day, matching
 * `DELETE_ACCOUNT_TOKEN_EXPIRES_IN_SECONDS` in `modules/auth/server.ts`. If
 * that server constant changes, change this with it: a record that outlives
 * the token it corresponds to is stale authority, not evidence.
 */
export const PENDING_ACCOUNT_DELETION_TTL_MS = 24 * 60 * 60 * 1000;

type PendingAccountDeletion = {
  userId: string;
  nonce: string;
  requestedAtMs: number;
};

/**
 * The subset of the `Storage` API used here. Taking it as a parameter keeps
 * these functions testable without a DOM and without a global stub.
 */
export type LocalStorageLike = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

function defaultStorage(): LocalStorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Private mode / disabled storage throws on the property access itself.
    return null;
  }
}

/**
 * Mint the one-time secret for a deletion request. `crypto.randomUUID` is the
 * platform CSPRNG — this value is the whole proof, so it must not be derived
 * from anything guessable such as a timestamp or the account id.
 */
export function newAccountDeletionNonce(): string {
  return crypto.randomUUID();
}

/**
 * Record that this device asked to delete `userId`, and the nonce the
 * confirmation callback must come back with. Call it only after the server has
 * accepted the request — that acceptance is what the record stands for.
 */
export function rememberPendingAccountDeletion(
  userId: string,
  nonce: string,
  nowMs: number,
  storage: LocalStorageLike | null = defaultStorage(),
): void {
  if (storage === null) return;
  const record: PendingAccountDeletion = {
    userId,
    nonce,
    requestedAtMs: nowMs,
  };
  try {
    storage.setItem(PENDING_ACCOUNT_DELETION_KEY, JSON.stringify(record));
  } catch {
    // Quota or private mode. The consequence is a cleanup that does not run,
    // which is the safe direction: nothing is deleted that should not be.
  }
}

function parseRecord(raw: string): PendingAccountDeletion | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as PendingAccountDeletion;
  if (typeof record.userId !== "string" || record.userId.length === 0) {
    return null;
  }
  if (typeof record.nonce !== "string" || record.nonce.length === 0) {
    return null;
  }
  if (typeof record.requestedAtMs !== "number") return null;
  return record;
}

/**
 * The account this device asked to delete, but ONLY if `nonce` is the secret
 * that request was made under. Any other answer is `null`.
 *
 * A malformed or expired record is removed as it is read, so a corrupted value
 * cannot sit there being re-examined forever. A record that is merely
 * MISMATCHED is kept: a wrong nonce is someone else's URL, and it must not be
 * able to destroy a legitimate pending deletion the learner is still going to
 * confirm.
 */
export function readPendingAccountDeletion(
  nonce: string,
  nowMs: number,
  storage: LocalStorageLike | null = defaultStorage(),
): string | null {
  if (storage === null || nonce.length === 0) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(PENDING_ACCOUNT_DELETION_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;

  const record = parseRecord(raw);
  if (record === null) {
    forgetPendingAccountDeletion(storage);
    return null;
  }

  // A record from the future is a clock that moved backwards, not a fresh
  // request; treat the age as elapsed rather than trusting the difference.
  const ageMs = nowMs - record.requestedAtMs;
  if (ageMs < 0 || ageMs > PENDING_ACCOUNT_DELETION_TTL_MS) {
    forgetPendingAccountDeletion(storage);
    return null;
  }

  if (record.nonce !== nonce) return null;
  return record.userId;
}

/** Drop the record — after the cleanup ran, or because it was never valid. */
export function forgetPendingAccountDeletion(
  storage: LocalStorageLike | null = defaultStorage(),
): void {
  if (storage === null) return;
  try {
    storage.removeItem(PENDING_ACCOUNT_DELETION_KEY);
  } catch {
    // Nothing to do; the TTL bounds how long a stuck record stays readable.
  }
}
