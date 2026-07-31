/**
 * Phase 16 — authenticated sync request guard (§8.4).
 *
 * Every sync endpoint must, in order: (1) be enabled by the SYNC_ENABLED
 * kill-switch, (2) have an authenticated session, (3) that session's account
 * must be email-verified. The `user_id` is derived ONLY from the server
 * session — a client-supplied user id is never trusted. Errors are generic and
 * enumeration-safe and never leak internals.
 *
 * The decision logic lives in the pure `./guard-decision` module (unit tested
 * without the session/env stack); this thin `server-only` wrapper wires in the
 * real SYNC_ENABLED flag and server session.
 */
import "server-only";

import {
  assertSameOrigin,
  originHeadersOf,
} from "@/modules/auth/request-origin";
import { getServerSession } from "@/modules/auth/session";
import { getServerEnv } from "@/modules/env/server";

import {
  evaluateSyncGuard,
  SYNC_CROSS_ORIGIN_ERROR,
  SYNC_UNAVAILABLE_ERROR,
  type SyncGuardResult,
} from "./guard-decision";

export {
  evaluateSyncGuard,
  SYNC_CROSS_ORIGIN_ERROR,
  SYNC_UNAUTHORIZED_ERROR,
  SYNC_UNAVAILABLE_ERROR,
  SYNC_UNVERIFIED_ERROR,
  type SyncGuardResult,
} from "./guard-decision";

/**
 * Guard the current request: reads the SYNC_ENABLED flag and the authenticated
 * server session, and returns the authorised user id or a safe error. Sync
 * being disabled yields a 503 before any session read; guests (no session) and
 * unverified accounts are rejected.
 */
export async function guardSyncRequest(
  request?: Request,
): Promise<SyncGuardResult> {
  const env = getServerEnv();
  if (!env.syncEnabled) {
    return {
      ok: false,
      status: 503,
      error: SYNC_UNAVAILABLE_ERROR,
      reason: "disabled",
    };
  }

  // Same-origin assertion, before the session is even read (Phase 18.1).
  //
  // The session cookie is SameSite=Lax, which already means a cross-site
  // POST arrives with no cookie and is refused below as unauthenticated. The
  // gap Lax leaves open is the top-level GET navigation — it DOES carry the
  // cookie — which is how a stranger's page can cause an authenticated
  // `/api/sync/pull`. Nothing is readable to them without CORS headers, and
  // this app sets none; refusing it anyway costs nothing and removes the
  // request rather than merely the payoff.
  //
  // Optional parameter so a caller with no Request in hand keeps the previous
  // behaviour rather than silently losing the check — every route passes one.
  if (request !== undefined) {
    const verdict = assertSameOrigin(
      originHeadersOf(request),
      new URL(env.appUrl).origin,
    );
    if (!verdict.sameOrigin) {
      // 403 rather than 401: this is not a request that authenticating
      // differently would fix, and the message says nothing about whether a
      // session existed.
      //
      // `reason` is what stops this being reported as an unverified email —
      // both are 403, and the merge protocol translates a refusal for the
      // learner to read. See SyncGuardRefusal.
      return {
        ok: false,
        status: 403,
        error: SYNC_CROSS_ORIGIN_ERROR,
        reason: "cross-origin",
      };
    }
  }

  const session = await getServerSession();
  return evaluateSyncGuard(true, session);
}
