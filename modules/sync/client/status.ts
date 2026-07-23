/**
 * Phase 16 — client sync-status derivation (§20). A PURE state machine mapping
 * the current sync inputs to the unobtrusive, authenticated-only indicator
 * states. No React, no Dexie, no fetch — so it is exhaustively unit-testable and
 * reused identically by the status UI and any headless caller.
 *
 * The indicator is shown ONLY to a signed-in user with sync enabled; the guest
 * / sync-disabled cases are surfaced here so the UI has one source of truth for
 * what (if anything) to render.
 */

export const SYNC_STATUS_KINDS = [
  /** Signed out — the UI shows an "account sync available" affordance, not a state. */
  "guest",
  /** SYNC_ENABLED=false on the server (or kill-switched) — nothing to do. */
  "disabled",
  /** A push/pull run is in flight. */
  "syncing",
  /** Fully reconciled: nothing pending, online, no recoverable failure. */
  "synced",
  /** N local changes not yet accepted by the server (online, will retry). */
  "pending",
  /** Offline — local study continues; changes queue until the next online run. */
  "offline",
  /** A recoverable failure needs a manual retry (honest, actionable). */
  "attention",
] as const;
export type SyncStatusKind = (typeof SYNC_STATUS_KINDS)[number];

export type SyncStatusInput = {
  /** Server SYNC_ENABLED flag (false → disabled). */
  enabled: boolean;
  /** Whether a session user is signed in (false → guest). */
  authenticated: boolean;
  /** navigator.onLine (or an injected equivalent). */
  online: boolean;
  /** A push/pull run is currently in flight. */
  running: boolean;
  /** Count of local mutations not yet accepted by the server. */
  pendingCount: number;
  /**
   * The last run ended in a RECOVERABLE failure the user should be told about
   * and can manually retry (e.g. repeated network failure, a recoverable
   * rejection needing a rebase). Transient/normal offline is NOT "attention".
   */
  needsAttention: boolean;
};

export type SyncStatus = {
  kind: SyncStatusKind;
  /** Number of not-yet-accepted local changes (0 unless kind is pending/attention). */
  pendingCount: number;
};

/**
 * Derive the sync status. Precedence (first match wins):
 *   guest → disabled → syncing → attention → offline → pending → synced.
 *
 * `syncing` outranks `attention`/`offline`/`pending` so an in-flight run reads
 * as progress, not a stale problem. `attention` (a recoverable failure the user
 * can act on) outranks plain `offline`/`pending` so an actionable problem isn't
 * hidden behind "offline". A negative/NaN pendingCount is clamped to 0.
 */
export function deriveSyncStatus(input: SyncStatusInput): SyncStatus {
  const pendingCount =
    Number.isFinite(input.pendingCount) && input.pendingCount > 0
      ? Math.floor(input.pendingCount)
      : 0;

  if (!input.authenticated) return { kind: "guest", pendingCount: 0 };
  if (!input.enabled) return { kind: "disabled", pendingCount: 0 };
  if (input.running) return { kind: "syncing", pendingCount };
  if (input.needsAttention) return { kind: "attention", pendingCount };
  if (!input.online) return { kind: "offline", pendingCount };
  if (pendingCount > 0) return { kind: "pending", pendingCount };
  return { kind: "synced", pendingCount: 0 };
}
