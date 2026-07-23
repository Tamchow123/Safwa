/**
 * Phase 16 — account-wide sync cursor (§9.3, §D1). `user_sync_state.sync_revision`
 * is the single monotonic per-account cursor: an ingestion transaction that
 * changes authoritative state bumps it ONCE and stamps `last_sync_seq` on every
 * row it changed with the returned value, so `pull?since=<cursor>` can return a
 * gap-free, ordered slice across components AND collections (a single component
 * revision cannot represent an account-wide pull).
 *
 * `server-only` — takes a live Drizzle transaction / connection.
 */
import "server-only";

import { eq, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { userSyncState } from "@/db/schema";

/** A Drizzle transaction handle (the argument to `db.transaction(async (tx) => ...)`). */
export type SyncTx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Atomically increment and return the account's sync cursor within the current
 * transaction. Upserts the per-account row; the `ON CONFLICT DO UPDATE`
 * acquires the row lock, serialising concurrent ingestion batches for the same
 * account so every bump yields a distinct, monotonic value. Call this ONCE per
 * transaction that makes an authoritative change, and stamp the changed rows
 * with the result.
 */
export async function nextAccountCursor(
  tx: SyncTx,
  userId: string,
): Promise<number> {
  const [row] = await tx
    .insert(userSyncState)
    .values({ userId, syncRevision: 1 })
    .onConflictDoUpdate({
      target: userSyncState.userId,
      set: {
        syncRevision: sql`${userSyncState.syncRevision} + 1`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ syncRevision: userSyncState.syncRevision });
  if (!row) {
    throw new Error("nextAccountCursor: upsert returned no row");
  }
  return row.syncRevision;
}

/** The account's current sync cursor (0 when the account has never synced). */
export async function currentAccountCursor(
  db: Database | SyncTx,
  userId: string,
): Promise<number> {
  const [row] = await db
    .select({ syncRevision: userSyncState.syncRevision })
    .from(userSyncState)
    .where(eq(userSyncState.userId, userId));
  return row?.syncRevision ?? 0;
}
