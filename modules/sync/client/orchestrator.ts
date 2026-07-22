/**
 * Phase 16 — sync orchestrator (§18). One coalesced push→pull run per account:
 *
 *   1. PUSH: select unsynced local scheduling (events + attempts), send it,
 *      and mark each event by its per-item result (applyPushResults).
 *   2. PULL: page from the account cursor, applying each page authoritatively
 *      (applyPullResponse) until `hasMore` is false.
 *
 * SINGLE RUN per account (§18 "only one active sync run per account/device"):
 * overlapping calls coalesce onto the one in-flight run rather than racing —
 * this is also what prevents two concurrent applyPullResponse calls from
 * clobbering each other (the reliability concern the reconcile primitives left
 * to this layer).
 *
 * LOGOUT / ACCOUNT-SWITCH GUARD (§18): before every LOCAL write (push-result
 * apply, each pull-page apply) the run re-checks `isCurrentAccount(userId)`. If
 * the active account changed mid-run (logout/switch), the run stops WITHOUT
 * writing, so a stale in-flight run can never write NEW data for a
 * no-longer-current account or advance its cursor. NOTE: this guards a stale
 * run only — it does NOT clear content account A legitimately synced BEFORE the
 * switch. Clearing/partitioning the shared local database on logout (so
 * account B never reads A's already-synced content) is a separate concern
 * tracked for the logout-handler slice; the guard here is deliberately narrow.
 *
 * TIMEOUT + BOUNDED PULL: every push/pull is raced against a timeout (aborting
 * the fetch) so the run always SETTLES — a hung request can never leave the
 * single-flight slot wedged. The pull loop is capped and stops on a
 * non-advancing cursor, so a misbehaving server can't spin it forever.
 *
 * Failures never throw to the caller: local study is unaffected and the outcome
 * is returned for the status layer to surface (offline/pending/attention).
 * Browser-only (drives Dexie via the reconcile primitives).
 */
import type { SafwaDb } from "@/modules/content/db";
import {
  SYNC_BOUNDS,
  SYNC_PROTOCOL_VERSION,
  type PullQuery,
  type PullResponse,
  type PushRequest,
  type PushResponse,
} from "@/modules/sync/protocol";

import type { SyncApiFailure, SyncApiResult } from "./api";
import { applyPushResults } from "./apply-push-results";
import { selectUnsyncedScheduling } from "./local-selection";
import { applyPullResponse } from "./reconcile";
import { readCursorForAccount } from "./sync-state";

/** How the run ended — mapped to a sync status by the status layer. */
export type SyncOutcome =
  | "synced" // push (if any) + a full pull completed
  | "offline" // not online; nothing attempted
  | "invalidated" // the active account changed mid-run; stopped without writing
  | "auth_lost" // 401/403 — session gone / unverified
  | "disabled" // 503 — sync turned off server-side
  | "retry"; // a recoverable failure (network / server / rate-limit)

export type SyncRunResult = { outcome: SyncOutcome };

export type RunSyncDeps = {
  db: SafwaDb;
  userId: string;
  deviceId: string;
  /** Injected clock (epoch ms). */
  now: () => number;
  /** Whether the device is online (navigator.onLine or an injected equivalent). */
  online: () => boolean;
  /** True iff `userId` is still the signed-in account (logout/switch guard). */
  isCurrentAccount: (userId: string) => boolean;
  /** Injectable API (defaults to the real client). */
  push?: (
    request: PushRequest,
    init?: { signal?: AbortSignal },
  ) => Promise<SyncApiResult<PushResponse>>;
  pull?: (
    query: PullQuery,
    init?: { signal?: AbortSignal },
  ) => Promise<SyncApiResult<PullResponse>>;
  /** Per-request timeout (ms); defaults to DEFAULT_REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number;
};

/** Map an API failure reason to a run outcome. */
function outcomeForFailure(reason: SyncApiFailure): SyncOutcome {
  switch (reason) {
    case "unauthorized":
    case "forbidden":
      return "auth_lost";
    case "disabled":
      return "disabled";
    default:
      // network / server_error / rate_limited / too_large / bad_request /
      // invalid_response — all recoverable on a later trigger.
      return "retry";
  }
}

/** Bounded page size for the pull loop. */
const PULL_PAGE = SYNC_BOUNDS.maxPullPageSize;
/** Max scheduling items selected per push (bounded by the wire caps). */
const PUSH_LIMIT = SYNC_BOUNDS.maxEvents;
/** Default per-request timeout — a hung call becomes a recoverable `retry`. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Hard cap on pull pages per run (defence against a non-terminating server). */
const MAX_PULL_PAGES = 1000;

/**
 * Race an API call against a timeout. The timeout aborts the underlying fetch
 * (via the signal) AND resolves to a network-class failure — resolving, not
 * rejecting, so the run ALWAYS settles even if the call ignores the signal, and
 * the single-flight slot always clears.
 */
async function callWithTimeout<T>(
  timeoutMs: number,
  call: (init: { signal: AbortSignal }) => Promise<SyncApiResult<T>>,
): Promise<SyncApiResult<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<SyncApiResult<T>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, reason: "network" });
    }, timeoutMs);
  });
  try {
    return await Promise.race([call({ signal: controller.signal }), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runSyncOnce(deps: RunSyncDeps): Promise<SyncRunResult> {
  const { db, userId } = deps;
  if (!deps.online()) return { outcome: "offline" };

  const push = deps.push ?? (await import("./api")).pushSync;
  const pull = deps.pull ?? (await import("./api")).pullSync;
  const timeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  // --- 1. PUSH ---
  const selection = await selectUnsyncedScheduling(db, PUSH_LIMIT);
  if (selection.events.length > 0) {
    const request: PushRequest = {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      deviceId: deps.deviceId,
      attempts: selection.attempts,
      events: selection.events,
      revocations: [],
      bookmarks: [],
      lists: [],
      settings: [],
    };
    const pushed = await callWithTimeout(timeoutMs, (init) =>
      push(request, init),
    );
    if (!pushed.ok) return { outcome: outcomeForFailure(pushed.reason) };
    // Logout guard: don't write another account's push results.
    if (!deps.isCurrentAccount(userId)) return { outcome: "invalidated" };
    await applyPushResults(db, pushed.data.results);
  }

  // --- 2. PULL (bounded loop until no more pages) ---
  let since = await readCursorForAccount(db, userId);
  for (let page = 0; page < MAX_PULL_PAGES; page++) {
    const pulled = await callWithTimeout(timeoutMs, (init) =>
      pull({ since, limit: PULL_PAGE }, init),
    );
    if (!pulled.ok) return { outcome: outcomeForFailure(pulled.reason) };
    // Logout guard: don't apply another account's pulled data.
    if (!deps.isCurrentAccount(userId)) return { outcome: "invalidated" };
    await applyPullResponse(db, userId, pulled.data, deps.now());
    if (!pulled.data.hasMore) return { outcome: "synced" };
    // The server guarantees a strictly-advancing cursor when more pages remain;
    // a non-advancing cursor is a protocol violation — stop rather than spin.
    if (pulled.data.serverCursor <= since) return { outcome: "retry" };
    since = pulled.data.serverCursor;
  }
  // Exhausted the page cap without hasMore going false — a protocol anomaly.
  return { outcome: "retry" };
}

/**
 * Module-level single-flight registry. Keyed by account so two accounts on one
 * device (rare) still each get one run, but overlapping triggers for the SAME
 * account coalesce onto the one in-flight promise.
 */
const inFlight = new Map<string, Promise<SyncRunResult>>();

/** Whether a run is currently in flight for `userId`. */
export function isSyncRunning(userId: string): boolean {
  return inFlight.has(userId);
}

/**
 * Run one coalesced sync for `deps.userId`. Overlapping calls while a run is in
 * flight return the SAME promise (no second run starts). Never throws — an
 * unexpected error is caught and surfaced as a recoverable `retry` outcome.
 */
export function runSync(deps: RunSyncDeps): Promise<SyncRunResult> {
  const existing = inFlight.get(deps.userId);
  if (existing) return existing;

  const run = runSyncOnce(deps)
    .catch((error): SyncRunResult => {
      // Log only a sanitized message — never the raw error/response object,
      // which could echo response bodies/payloads into a shared device's console.
      console.error(
        "[sync] run failed:",
        error instanceof Error ? error.message : "unknown error",
      );
      return { outcome: "retry" };
    })
    .finally(() => {
      inFlight.delete(deps.userId);
    });
  inFlight.set(deps.userId, run);
  return run;
}
