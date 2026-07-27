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

import { getServerSession } from "@/modules/auth/session";
import { getServerEnv } from "@/modules/env/server";

import {
  evaluateSyncGuard,
  SYNC_UNAVAILABLE_ERROR,
  type SyncGuardResult,
} from "./guard-decision";

export {
  evaluateSyncGuard,
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
export async function guardSyncRequest(): Promise<SyncGuardResult> {
  if (!getServerEnv().syncEnabled) {
    return { ok: false, status: 503, error: SYNC_UNAVAILABLE_ERROR };
  }
  const session = await getServerSession();
  return evaluateSyncGuard(true, session);
}
