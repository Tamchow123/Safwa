/**
 * Phase 16 — client sync-state persistence (§18, design D7). A single Dexie
 * `sync_state` row ("account") holds the account this device last synced as, the
 * account-wide pull cursor, and the last successful sync time. The stored
 * `userId` is how the client detects an account switch / logout: a cursor that
 * belongs to a different user is NOT ours, so a fresh account bootstraps from 0
 * rather than reusing another account's cursor. Browser-only (Dexie).
 */
import type { SafwaDb, SyncStateRecord } from "@/modules/content/db";

const ACCOUNT_KEY = "account" as const;

/** The default state before any sync has run (or after invalidation). */
export const INITIAL_SYNC_STATE: SyncStateRecord = {
  key: ACCOUNT_KEY,
  userId: null,
  serverCursor: 0,
  lastSyncAt: null,
};

/** Read the stored sync state (the default when none exists). */
export async function readSyncState(db: SafwaDb): Promise<SyncStateRecord> {
  return (await db.syncState.get(ACCOUNT_KEY)) ?? INITIAL_SYNC_STATE;
}

/**
 * The pull cursor to use for `userId`: the stored cursor ONLY if it belongs to
 * this account, else 0 (bootstrap). This is the account-switch/logout guard —
 * a stale cursor from a previous user can never be reused.
 */
export async function readCursorForAccount(
  db: SafwaDb,
  userId: string,
): Promise<number> {
  const state = await readSyncState(db);
  return state.userId === userId ? state.serverCursor : 0;
}

/** Persist the sync state (always under the single "account" key). */
export async function writeSyncState(
  db: SafwaDb,
  next: Omit<SyncStateRecord, "key">,
): Promise<void> {
  await db.syncState.put({ ...next, key: ACCOUNT_KEY });
}

/**
 * Record a successful reconcile for an account. If the account changed since the
 * last write, this overwrites the prior user's cursor — the intended
 * invalidation on account switch.
 */
export async function recordSyncProgress(
  db: SafwaDb,
  userId: string,
  serverCursor: number,
  at: number,
): Promise<void> {
  await writeSyncState(db, { userId, serverCursor, lastSyncAt: at });
}

/**
 * Clear the sync context (logout / account switch) so a stale cursor can never
 * be reused for a different account's pull.
 */
export async function invalidateSyncState(db: SafwaDb): Promise<void> {
  await writeSyncState(db, {
    userId: null,
    serverCursor: 0,
    lastSyncAt: null,
  });
}
