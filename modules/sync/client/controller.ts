/**
 * Phase 16 — sync controller (§18 triggers, §20 status). A framework-light
 * decision layer between the environment (a React provider owns the DOM timers
 * and listeners) and the coalescing `runSync` orchestrator.
 *
 * It answers one question per trigger: "should a sync run right now, and what is
 * the current status?" — and keeps the derived `SyncStatus` (deriveSyncStatus)
 * up to date so the indicator has a single source of truth. It deliberately owns
 * NO timers and NO DOM listeners: those live in the React wrapper, which calls
 * `sync(reason)` on each trigger (bootstrap / periodic tick / becoming visible /
 * online / session end / manual retry). Keeping this layer timer-free makes
 * every trigger path exhaustively unit-testable by calling a method.
 *
 * INVARIANTS it enforces:
 *  - GUESTS NEVER CALL THE SERVER (§18): with no signed-in user id, `sync()`
 *    is a no-op returning null and the status is `guest`.
 *  - DISABLED BACK-OFF: a run that returns `disabled` (server SYNC_ENABLED=false
 *    / kill-switch) flips `enabled` false for the rest of the session, so we stop
 *    hammering a disabled server; status becomes `disabled`.
 *  - AUTH-LOST BACK-OFF: an `auth_lost` outcome (session gone/unverified) stops
 *    automatic runs until the environment re-authenticates and rebuilds the
 *    controller — a stale session must not spin retries — AND surfaces the
 *    actionable `attention` status, so the indicator never claims `synced`
 *    while local changes have silently stopped reaching the server.
 *  - INVALIDATED BACK-OFF: an `invalidated` outcome (the active account changed
 *    mid-run) also stops further runs on this now-stale controller instance, so
 *    it cannot keep issuing guarded-but-real calls in the window before the
 *    provider rebuilds a fresh controller for the new account.
 *  - ONE RUN, COALESCED (§18): overlapping `sync()` calls funnel through
 *    `runSync`, which returns the one in-flight promise, so overlapping triggers
 *    can never start a second concurrent run.
 *  - HONEST STATUS: `needsAttention` is set by a `retry` outcome (a recoverable
 *    failure the user can act on) or an `auth_lost` outcome (re-auth needed),
 *    and cleared by any subsequent `synced` outcome; transient offline is NOT
 *    attention.
 *
 * The status is recomputed and pushed to subscribers at the START of every run
 * (a local `runningNow` flag is raised BEFORE awaiting, so the indicator shows
 * `syncing` immediately for the run's originating caller — not only for a second
 * caller that coalesces onto an already-registered run) and again when it
 * settles. Pure/injectable clock, online and pending-count so tests inject
 * everything. SETTLEMENT NOTE: the network run is bounded by runSync's own
 * per-request timeout; the local `countPending` Dexie count is assumed
 * non-hanging (as elsewhere in the codebase's local reads), so it is awaited
 * without a separate timeout race.
 */
import type { SafwaDb } from "@/modules/content/db";

import { runSync as defaultRunSync, isSyncRunning } from "./orchestrator";
import type { RunSyncDeps, SyncRunResult } from "./orchestrator";
import { deriveSyncStatus, type SyncStatus } from "./status";

/** Why a sync was triggered — for logging/telemetry and test intent only. */
export type SyncTriggerReason =
  | "bootstrap" // first sync after sign-in / app load (§18 bootstrap)
  | "periodic" // the active-interval timer fired (§18 periodic while active)
  | "visible" // the document became visible again
  | "online" // the device came back online (a later online retry)
  | "session-end" // a study session finished / the page is being hidden
  | "manual"; // the user pressed retry from an attention state

export type SyncControllerDeps = {
  db: SafwaDb;
  /** The signed-in account id. Guests must build NO controller (or pass null). */
  userId: string | null;
  deviceId: string;
  /** Injected clock (epoch ms). */
  now: () => number;
  /** navigator.onLine (or an injected equivalent). */
  online: () => boolean;
  /** True iff `userId` is still the signed-in account (logout/switch guard). */
  isCurrentAccount: (userId: string) => boolean;
  /**
   * Count of THIS account's local changes not yet accepted by the server
   * (pending badge). Scoped by userId so a guest's local history is never
   * counted as this account's pending work (§18, EXT-F1).
   */
  countPending: (db: SafwaDb, userId: string) => Promise<number>;
  /** Injectable orchestrator (defaults to the real coalescing runSync). */
  run?: (deps: RunSyncDeps) => Promise<SyncRunResult>;
  /** Injectable in-flight probe (defaults to the real isSyncRunning). */
  running?: (userId: string) => boolean;
};

export type SyncController = {
  /** The current derived status (never throws; safe to read any time). */
  getStatus(): SyncStatus;
  /** Subscribe to status changes; returns an unsubscribe function. */
  subscribe(listener: (status: SyncStatus) => void): () => void;
  /**
   * Trigger a sync for `reason`. No-op (returns null) for a guest, a
   * sync-disabled or auth-lost account, or when offline. Otherwise runs one
   * coalesced push→pull and returns its result. Never throws.
   */
  sync(reason: SyncTriggerReason): Promise<SyncRunResult | null>;
  /** Recompute the pending count and re-derive status (no server call). */
  refreshPending(): Promise<void>;
};

export function createSyncController(deps: SyncControllerDeps): SyncController {
  const run = deps.run ?? defaultRunSync;
  const running = deps.running ?? isSyncRunning;

  // Mutable session-scoped inputs to deriveSyncStatus.
  let enabled = true; // optimistic; a `disabled` outcome flips this false.
  let stopped = false; // an `auth_lost`/`invalidated` outcome stops automatic runs.
  let needsAttention = false;
  let pendingCount = 0;
  // Raised synchronously around our own run so the START notification reads
  // `syncing` even though runSync only registers the account in its in-flight
  // map *inside* the call (after our pre-run notify would otherwise fire).
  let runningNow = false;

  const listeners = new Set<(status: SyncStatus) => void>();

  function computeStatus(): SyncStatus {
    return deriveSyncStatus({
      enabled,
      authenticated: deps.userId !== null,
      online: deps.online(),
      running: runningNow || (deps.userId !== null && running(deps.userId)),
      pendingCount,
      needsAttention,
    });
  }

  function notify(): void {
    const status = computeStatus();
    for (const listener of listeners) listener(status);
  }

  async function refreshPending(): Promise<void> {
    const { userId } = deps;
    if (userId === null) {
      pendingCount = 0;
      notify();
      return;
    }
    try {
      pendingCount = await deps.countPending(deps.db, userId);
    } catch {
      // A failed count must never break status; keep the last known value.
    }
    notify();
  }

  async function sync(
    reason: SyncTriggerReason,
  ): Promise<SyncRunResult | null> {
    void reason;
    const { userId } = deps;
    // Guests never call the server; a disabled/auth-lost session backs off.
    if (userId === null || !enabled || stopped) {
      notify();
      return null;
    }
    if (!deps.online()) {
      notify();
      return null;
    }

    // Raise the in-flight flag and announce `syncing` BEFORE awaiting, so a
    // subscribed indicator shows progress immediately for the originating call.
    runningNow = true;
    notify();
    let result: SyncRunResult;
    try {
      result = await run({
        db: deps.db,
        userId,
        deviceId: deps.deviceId,
        now: deps.now,
        online: deps.online,
        isCurrentAccount: deps.isCurrentAccount,
      });
    } finally {
      runningNow = false;
    }

    // Fold the outcome into the session inputs.
    switch (result.outcome) {
      case "synced":
        needsAttention = false;
        break;
      case "retry":
        needsAttention = true;
        break;
      case "disabled":
        enabled = false;
        break;
      case "auth_lost":
        // Session gone/unverified: stop auto-runs AND surface an actionable
        // state, so the indicator never reads `synced` while changes have
        // silently stopped reaching the server (needs re-auth).
        stopped = true;
        needsAttention = true;
        break;
      case "invalidated":
        // The active account changed mid-run: this controller's userId is now
        // stale, so back off rather than keep issuing guarded-but-real calls
        // until the provider rebuilds a fresh controller for the new account.
        stopped = true;
        break;
      case "offline":
        // Transient — leave attention as-is; status reflects online/guard.
        break;
    }

    await refreshPending(); // also notifies with the settled status.
    return result;
  }

  return {
    getStatus: computeStatus,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sync,
    refreshPending,
  };
}
