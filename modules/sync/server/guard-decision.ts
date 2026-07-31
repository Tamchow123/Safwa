/**
 * Phase 16 — pure sync-guard decision (§8.4). Factored out of `auth-guard.ts`
 * (which is `server-only`) so the authorisation logic is exhaustively unit
 * testable without the session/env stack. No server-only / DB imports here.
 */

/**
 * Why the guard refused. Carried alongside the status because the status is
 * AMBIGUOUS: 403 covers both an unverified email — which the learner can act
 * on — and a cross-origin request, which they cannot and must never be told to
 * "verify their email" about. Callers that translate a refusal into their own
 * vocabulary (the merge protocol's reason codes) must branch on this, never on
 * the number.
 */
export type SyncGuardRefusal =
  "disabled" | "unauthenticated" | "unverified" | "cross-origin";

/** Outcome of the guard: either an authorised user id, or a safe HTTP error. */
export type SyncGuardResult =
  | { ok: true; userId: string }
  | {
      ok: false;
      status: 401 | 403 | 503;
      error: string;
      reason: SyncGuardRefusal;
    };

/** The minimal session shape the guard needs (id + verification flag). */
export type GuardSession = {
  user?: { id: string; emailVerified: boolean } | null;
} | null;

export const SYNC_UNAVAILABLE_ERROR = "Online sync is currently unavailable.";
export const SYNC_UNAUTHORIZED_ERROR = "Unauthorized";
export const SYNC_UNVERIFIED_ERROR = "Email verification is required to sync.";
/**
 * A request another origin caused (Phase 18.1). Says nothing about whether a
 * session existed, so it cannot be used to probe for one.
 */
export const SYNC_CROSS_ORIGIN_ERROR = "Request origin not allowed.";

/**
 * Pure guard decision. Given whether sync is enabled and the current session,
 * returns the authorised user id or the exact safe error the route should
 * surface. Order: disabled (503) → unauthenticated (401) → unverified (403).
 * Never throws; all rejection messages are fixed (enumeration-safe).
 */
export function evaluateSyncGuard(
  syncEnabled: boolean,
  session: GuardSession,
): SyncGuardResult {
  if (!syncEnabled) {
    return {
      ok: false,
      status: 503,
      error: SYNC_UNAVAILABLE_ERROR,
      reason: "disabled",
    };
  }
  const user = session?.user;
  if (!user) {
    return {
      ok: false,
      status: 401,
      error: SYNC_UNAUTHORIZED_ERROR,
      reason: "unauthenticated",
    };
  }
  if (!user.emailVerified) {
    return {
      ok: false,
      status: 403,
      error: SYNC_UNVERIFIED_ERROR,
      reason: "unverified",
    };
  }
  return { ok: true, userId: user.id };
}
