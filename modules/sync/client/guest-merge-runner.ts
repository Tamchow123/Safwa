/**
 * Phase 17 §19, §20 — the merge RUNNER: the effects the pure state machine
 * deliberately does not own.
 *
 * `guest-merge-machine.ts` decides what is true; this decides what to DO about
 * it, and emits the events that move the machine on. The split is the one
 * `controller.ts` makes for ordinary sync, and it exists so every path — a
 * network dying mid-chunk, a pull that will not land, an oversized history — is
 * reachable in a unit test by calling a function, with no React and no DOM.
 *
 * WHAT IT SEQUENCES, once (and only once) the learner has consented:
 *
 *   collect the guest snapshot   -> `snapshot-collected` / `snapshot-too-large`
 *   upload it in bounded chunks  -> `upload-progress` … `upload-finalising`
 *   finalise locally             -> re-key, drop guest rows, mark completed
 *   rebase                       -> `rebase-succeeded` / `rebase-failed`
 *
 * SINGLE-FLIGHT IS KEPT HERE (REL-002-T13a). `uploadGuestMerge` holds no lock
 * of its own; this module refuses to start a second run for an account while one
 * is in flight, which is also what makes the machine's "duplicate submissions
 * are disabled while active" rule true of the effects and not only of the
 * display.
 *
 * THE REBASE IS NOT OPTIONAL (REL-002-T13b). Local finalisation drops the guest
 * component projections whose whole history moved, so between finalisation and
 * a successful pull the learner has cards missing. The run therefore does not
 * finish at the server's "applied": it pulls, retries a bounded number of times,
 * and reports failure honestly rather than letting the machine claim completion.
 *
 * Browser-only (Dexie), but every collaborator is injected, so it is testable
 * with none of them real.
 */
import type { SafwaDb } from "@/modules/content/db";

import {
  collectGuestSnapshot,
  GuestSnapshotTooLargeError,
  type GuestSnapshot,
} from "./guest-snapshot";
import { GuestMergeChunkOverflowError } from "./guest-merge-chunking";
import { finaliseGuestMerge } from "./guest-merge-finalise";
import {
  MAX_REBASE_ATTEMPTS,
  type GuestMergeEvent,
} from "./guest-merge-machine";
import { buildGuestMergeSummaryView } from "./guest-merge-summary";
import { uploadGuestMerge } from "./guest-merge-upload";

export type GuestMergeRunnerDeps = {
  db: SafwaDb;
  userId: string;
  /** Emits into the machine. Called only while this run is still current. */
  dispatch: (event: GuestMergeEvent) => void;
  /**
   * The authoritative post-merge pull. Resolves true when the device now holds
   * the merged state. Injected rather than imported so the runner does not
   * depend on the ordinary-sync orchestrator's whole dependency set.
   */
  rebase: () => Promise<boolean>;
  /** Injected clock, stamped onto the rebuilt derived caches. */
  now: () => number;
  /** True while this account is still the signed-in one (account-switch guard). */
  isCurrentAccount: (userId: string) => boolean;
  /** Test seams. */
  collect?: (db: SafwaDb) => Promise<GuestSnapshot>;
  upload?: typeof uploadGuestMerge;
  finalise?: typeof finaliseGuestMerge;
};

/**
 * Runs in flight, by account, COALESCED — a second caller gets the same promise
 * rather than a silent no-op (REL-001). Module-level for the same reason
 * `orchestrator.ts` keeps its registry there: two React trees, or a remount,
 * must not each get their own idea of whether a merge is running.
 *
 * The distinction between coalescing and refusing is not academic here. The
 * displayed state lives in a per-instance reducer, so a provider that remounts
 * mid-run and starts again would move ITS state to `preparing` and then wait
 * forever, because the events from the still-running original go to the
 * discarded closure. Returning the live promise lets the second caller await the
 * real outcome; `isGuestMergeRunning` lets it decline to start at all.
 */
const IN_FLIGHT = new Map<string, Promise<void>>();

/** Whether a merge run is currently in flight for `userId`. */
export function isGuestMergeRunning(userId: string): boolean {
  return IN_FLIGHT.has(userId);
}

/**
 * Run one complete merge for `userId`: collect, upload, finalise, rebase.
 *
 * Returns without doing anything if a run for this account is already in
 * flight. Never throws for a merge condition — those are dispatched as events
 * the UI renders honestly — but does not swallow a programming error.
 */
export function runGuestMerge(deps: GuestMergeRunnerDeps): Promise<void> {
  return coalesce(deps.userId, () => runOnce(deps));
}

/**
 * Register `work` as this account's in-flight run, or return the run already
 * under way. Synchronous check-and-set: there is no `await` between the lookup
 * and the store, so two callers cannot both win.
 */
function coalesce(userId: string, work: () => Promise<void>): Promise<void> {
  const existing = IN_FLIGHT.get(userId);
  if (existing) return existing;
  const run = work().finally(() => {
    IN_FLIGHT.delete(userId);
  });
  IN_FLIGHT.set(userId, run);
  return run;
}

/**
 * Re-run ONLY the post-merge pull, for a merge the server already applied whose
 * rebase gave up.
 *
 * The whole-merge path would work — the import key is durable and `begin`
 * answers `already_completed` — but it would first collect a snapshot of guest
 * rows finalisation has already re-keyed away, and spend a begin/finalize round
 * trip getting back to the only thing outstanding. The machine makes the same
 * distinction on `retry`; this is its other half.
 */
export function retryGuestMergeRebase(
  deps: GuestMergeRunnerDeps,
): Promise<void> {
  return coalesce(deps.userId, () => rebaseUntilLanded(deps));
}

async function runOnce(deps: GuestMergeRunnerDeps): Promise<void> {
  const { db, userId, dispatch } = deps;
  const collect = deps.collect ?? collectGuestSnapshot;
  const upload = deps.upload ?? uploadGuestMerge;
  const finalise = deps.finalise ?? finaliseGuestMerge;

  /** Stop writing to a machine that no longer belongs to this account. */
  const current = (): boolean => deps.isCurrentAccount(userId);

  // --- 1. collect ----------------------------------------------------------
  let snapshot: GuestSnapshot;
  try {
    snapshot = await collect(db);
  } catch (error) {
    if (!current()) return;
    // A history too large for one import, or for the chunk ceiling. Nothing has
    // been sent and no retry changes it, so it is attention, not a failure to
    // retry at.
    if (
      error instanceof GuestSnapshotTooLargeError ||
      error instanceof GuestMergeChunkOverflowError
    ) {
      dispatch({ type: "snapshot-too-large" });
      return;
    }
    dispatch({
      type: "upload-interrupted",
      reason: { kind: "local" },
    });
    return;
  }
  if (!current()) return;
  dispatch({ type: "snapshot-collected" });

  // --- 2. upload -----------------------------------------------------------
  const outcome = await upload(db, userId, snapshot, {
    onProgress: (progress) => {
      if (!current()) return;
      // The last chunk having landed is not the same as the server having
      // finalised; the driver's own `finalize` call follows. Reporting
      // `finalising` at that point is what stops the bar sitting at 100% while
      // the request that decides the outcome is still in flight.
      if (
        progress.chunksTotal > 0 &&
        progress.chunksSent >= progress.chunksTotal
      ) {
        // prettier-ignore
        dispatch({ type: "upload-finalising" });
        return;
      }
      dispatch({ type: "upload-progress", progress });
    },
  });
  if (!current()) return;

  if (outcome.status === "rejected") {
    dispatch({
      type: "upload-rejected",
      reason: { kind: "server", reasonCode: outcome.reasonCode },
    });
    return;
  }
  if (outcome.status === "interrupted") {
    // A retryable transport condition is retryable; anything else needs the
    // learner to do something (sign in again, most often), so it is attention.
    const reason = outcome.failure
      ? ({ kind: "transport", failure: outcome.failure } as const)
      : ({ kind: "local" } as const);
    dispatch(
      outcome.retryable
        ? { type: "upload-interrupted", reason }
        : { type: "upload-rejected", reason },
    );
    return;
  }

  // --- 3. finalise locally -------------------------------------------------
  // An empty snapshot never produced a chunk, so the progress callback never
  // reported finalising. Say it now rather than jumping from `preparing`
  // straight to a finished merge.
  dispatch({ type: "upload-finalising" });
  try {
    await finalise(db, {
      userId,
      importKey: outcome.importKey,
      snapshot,
      listIdMappings: outcome.listIdMappings,
      now: deps.now(),
    });
  } catch {
    if (!current()) return;
    // The SERVER merge is durable; only the local conversion failed. Retryable
    // under the same import key, which `begin` will answer `already_completed`
    // without resending anything.
    dispatch({ type: "upload-interrupted", reason: { kind: "local" } });
    return;
  }
  if (!current()) return;

  const summary = buildGuestMergeSummaryView({
    summary: outcome.summary,
    serverResult: outcome.result,
    skipped: snapshot.skipped,
  });
  dispatch({
    type: "upload-succeeded",
    summary,
    changedAnything: outcome.result === "applied",
  });

  // --- 4. rebase -----------------------------------------------------------
  await rebaseUntilLanded(deps);
}

/**
 * Pull until the device holds the merged state, or the budget runs out.
 *
 * The budget is `MAX_REBASE_ATTEMPTS`, imported from the machine rather than
 * chosen again here: the machine turns the same number of `rebase-failed`
 * events into `retryable-error`, so a second, local count could let this loop
 * keep pulling after the screen had already given up — or give up while the
 * screen still said "finishing". One number, one answer.
 */
async function rebaseUntilLanded(deps: GuestMergeRunnerDeps): Promise<void> {
  const { userId, dispatch } = deps;
  for (let attempt = 0; attempt < MAX_REBASE_ATTEMPTS; attempt += 1) {
    let landed = false;
    try {
      landed = await deps.rebase();
    } catch {
      // A throwing pull is a failed pull. The merge is already durable on the
      // server, so there is nothing here worth propagating to the caller.
      landed = false;
    }
    if (!deps.isCurrentAccount(userId)) return;
    if (landed) {
      dispatch({ type: "rebase-succeeded" });
      return;
    }
    dispatch({ type: "rebase-failed" });
  }
}
