/**
 * WHO the current session says the learner is — `account`, `guest`, or the
 * third answer this module exists to make sayable: `unknown` (Phase 18 §2).
 *
 * Before this module, every caller asked `data?.user?.id ?? null` and got back
 * two answers where there are three. That collapse is a defect with teeth: on a
 * COLD BOOT WITH NO NETWORK while signed in, Better Auth's session store
 * resolves to `{ data: null, error: <non-null>, isPending: false }` — the fetch
 * REJECTED, it is not still in flight — so `?? null` reports **guest**. Every
 * offline review would then be stamped `ownerKey: "guest"`: a CLAUDE.md hard
 * rule 8 violation, invisible to the account's own owner-scoped reads, and
 * never enqueued for sync. The learner would meet it as a guest-merge prompt
 * offering to import their own work back to themselves.
 *
 * The discriminator that makes the third answer cheap: a GENUINE guest resolves
 * to `{ data: null, error: null }` — the server answered, and the answer was
 * "nobody is signed in" — while an unreachable server resolves to
 * `{ data: null, error: <non-null> }`. The store's own transitions
 * (`better-auth/dist/client/query.mjs`) guarantee it: `onSuccess` sets
 * `error: null`, both failure paths set a non-null `error`, and `onRequest`
 * only clears `error` while simultaneously setting `isPending` whenever `data`
 * is null. There is therefore no window in which an unreachable server looks
 * like a guest.
 *
 * PURE: no React, no DOM, no Better Auth import, no storage. It takes a plain
 * snapshot and returns a verdict, so every branch below is unit-testable
 * without a browser or a running server. The only import is
 * {@link isValidOwnerAccountId}, reused rather than reinvented so that "a
 * usable account id" means exactly one thing across the codebase — the same
 * predicate that gates {@link accountOwnerKey}, whose rejection would otherwise
 * surface much later as a thrown write.
 */

import { isValidOwnerAccountId } from "@/modules/content/owner-key";

/** HTTP status that means "the server answered: you are not signed in". */
const UNAUTHORIZED_STATUS = 401;

/**
 * The shape this module needs from a session, named STRUCTURALLY rather than
 * imported from Better Auth. Two reasons: the classifier stays pure and
 * testable with object literals, and a future auth-client change cannot break
 * this module's contract silently — it would fail to typecheck at the call
 * site instead. Better Auth's real `useSession()` value is assignable to this
 * as-is (its `error` is a `BetterFetchError`, which carries `status: number`).
 */
export type ClassifiableSession = {
  readonly data?: { readonly user?: { readonly id?: string } | null } | null;
  readonly isPending?: boolean;
  readonly error?: { readonly status?: number } | null;
};

/** The three answers. `unknown` is the one the old `?? null` could not give. */
export type SessionIdentity =
  | { readonly kind: "account"; readonly accountId: string }
  | { readonly kind: "guest" }
  | { readonly kind: "unknown" };

/** Cached singletons — these carry no data, so allocating per call is waste. */
const GUEST: SessionIdentity = { kind: "guest" };
const UNKNOWN: SessionIdentity = { kind: "unknown" };

/**
 * Classify a session snapshot.
 *
 * The order below is the contract, and each step is only reachable because the
 * ones above it did not fire:
 *
 * 1. **A valid account id ⇒ `account`.** Checked first because it is the only
 *    positive evidence available, and because Better Auth deliberately RETAINS
 *    `data` across a non-401 failure — so a signed-in learner whose refresh
 *    fails offline keeps being classified as themselves, which is both correct
 *    and the common case.
 * 2. **`data.user` present but its id unusable ⇒ `unknown`, never `guest`.**
 *    This is a deviation from a naive reading of the ordering, and it is
 *    deliberate: the server said *somebody* is signed in. Answering `guest`
 *    there would re-create the exact silent mis-scoping this module exists to
 *    prevent, and answering `account` is impossible — {@link accountOwnerKey}
 *    would throw on the value. `unknown` is the only honest answer, and it
 *    degrades to the last-known owner rather than to a wrong one.
 * 3. **`isPending` ⇒ `unknown`.** The fetch is still in flight; nobody knows
 *    yet, and a write must not be stamped from a guess.
 * 4. **No error ⇒ `guest`.** The server answered and said nobody is signed in.
 *    This is the ONLY path that yields `guest`, which is what makes the guest
 *    verdict trustworthy enough to act on (slice 4 forgets the remembered owner
 *    on it).
 * 5. **A 401 ⇒ `guest`.** Also a real answer from a reachable server: the
 *    session is gone or was never valid.
 * 6. **Anything else ⇒ `unknown`.** A network rejection (which arrives as a
 *    plain `TypeError`, not a `BetterFetchError`, and so has no `status` at
 *    all), a 5xx, or the `503` a deployment with `AUTH_ENABLED=false` returns.
 *    None of those are evidence about the learner; they are evidence about the
 *    server.
 */
export function classifySessionIdentity(
  session: ClassifiableSession | null | undefined,
): SessionIdentity {
  // A missing snapshot is not a guest — it is an absence of information, and
  // the whole point of this module is to stop treating those two as the same.
  if (!session) return UNKNOWN;

  const user = session.data?.user;
  if (user) {
    return isValidOwnerAccountId(user.id)
      ? { kind: "account", accountId: user.id }
      : UNKNOWN;
  }

  if (session.isPending) return UNKNOWN;

  // Explicitly `null`/`undefined`, NOT merely falsy. Types are erased at
  // runtime, and this is the one branch that may answer `guest` from an
  // absence: if a future dependency ever rejected the session promise with a
  // falsy primitive (`throw 0`, `throw false`), a truthiness test would read it
  // as "the server answered, nobody is signed in" and reproduce exactly the
  // defect this module exists to close. Anything else falls through to the
  // status check and, having no 401, lands on `unknown` — the safe direction.
  const error = session.error;
  if (error === null || error === undefined) return GUEST;

  return error.status === UNAUTHORIZED_STATUS ? GUEST : UNKNOWN;
}

/**
 * The account id when the session names one, else `null`. A convenience for
 * read paths that only need "is there an account", NOT a shortcut past the
 * classifier — `null` here still means "no account named", which covers both
 * `guest` and `unknown` and must never be treated as "guest".
 */
export function accountIdFromSession(
  session: ClassifiableSession | null | undefined,
): string | null {
  const identity = classifySessionIdentity(session);
  return identity.kind === "account" ? identity.accountId : null;
}
