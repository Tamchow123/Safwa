"use client";

/**
 * Phase 17 §19 — the React wiring for the guest→account merge.
 *
 * The ONLY place the Better Auth session, Dexie and the merge runner meet.
 * Everything that decides anything lives outside React: `guest-merge-machine.ts`
 * decides what is true, `guest-merge-runner.ts` decides what to do about it, and
 * this file owns nothing but effects and context — the same split
 * `sync-provider.tsx` makes for ordinary sync.
 *
 * THE SESSION IS RESOLVED FIRST, ALWAYS (§19 "appear only after the auth session
 * is resolved", "never misclassify a pending session as a guest"). Resolution
 * is decided by `classifySessionIdentity`, not by Better Auth's `isPending`
 * alone: an offline cold boot leaves `isPending` false with no data, and
 * treating THAT as a resolved guest would offer a signed-in learner the chance
 * to merge their own work into their own account. This provider dispatches
 * NOTHING until the identity is `account` or `guest`. The machine starts in
 * `unresolved` and no guest data is read, let alone offered, before it knows
 * who is asking.
 *
 * THE GUEST-DATA CHECK IS A COUNT, NOT A COLLECTION (§9.1, §12). It calls
 * `summarizeGuestData`, which counts guest-owned rows; it does not build a
 * snapshot and it creates nothing. A learner who never consents has had no
 * profile created from a passive read and no byte sent.
 *
 * NOTHING RUNS ON ITS OWN. There is no automatic merge trigger anywhere in this
 * file: `consent()` is called from a control the learner pressed, and it is the
 * only thing that starts a run.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";

import { useSession } from "@/modules/auth/client";
import { classifySessionIdentity } from "@/modules/auth/session-identity";
import { getSafwaDb } from "@/modules/content/db";
import { getOrCreateDeviceProfile } from "@/modules/profile/device";
import {
  guestMergeReducer,
  initialGuestMergeState,
  isGuestMergeActive,
  canStartGuestMerge,
  needsRebaseOnlyRetry,
  type GuestMergeEvent,
  type GuestMergeState,
} from "@/modules/sync/client/guest-merge-machine";
import {
  isGuestMergeRunning,
  retryGuestMergeRebase,
  runGuestMerge,
  type GuestMergeRunnerDeps,
} from "@/modules/sync/client/guest-merge-runner";
import {
  isMeaningfulGuestData,
  summarizeGuestData,
} from "@/modules/sync/client/guest-snapshot";
import {
  forgetOnIdentityChange,
  initialSurfaceMemory,
  isSurfaceVisible,
  rememberDismissal,
} from "@/modules/sync/client/guest-merge-surface";
import { useSyncStatus } from "@/components/sync/sync-provider";

export type GuestMergeContextValue = {
  state: GuestMergeState;
  /** True while a merge is running — the submit control must be disabled. */
  active: boolean;
  /** True when a merge can be started or restarted from here. */
  canStart: boolean;
  /** Start the merge. The ONLY path to sending anything (§9.1). */
  consent: () => void;
  /** "Not now" — non-destructive, and the offer stays available (§9.1). */
  defer: () => void;
  /** Try again after a retryable failure. */
  retry: () => void;
  /**
   * Close a finished merge's surface.
   *
   * PRESENTATION ONLY — it changes nothing about the merge, which really is
   * over. It exists because the terminal states are terminal: the machine has
   * no "and now stop showing it" transition, and inventing one would make a
   * screen's dismissal look like part of the merge's own lifecycle.
   */
  dismiss: () => void;
  /**
   * Show a deferred offer again. Dispatches `reconsider`, so the learner sees
   * the counts before anything is sent — it is not a second consent button.
   */
  reconsider: () => void;
  /** False once a finished merge has been dismissed, until a new one starts. */
  visible: boolean;
};

const GuestMergeContext = createContext<GuestMergeContextValue | null>(null);

/**
 * Read the merge state. Returns null OUTSIDE a provider rather than throwing,
 * so a settings panel or header entry point rendered in isolation degrades to
 * nothing instead of crashing the shell — the same contract
 * `useOptionalSyncStatus` has.
 */
export function useGuestMerge(): GuestMergeContextValue | null {
  return useContext(GuestMergeContext);
}

export function GuestMergeProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = useSession();
  const [state, dispatch] = useReducer(
    guestMergeReducer,
    undefined,
    initialGuestMergeState,
  );

  // Presentation only: whether a finished merge's surface has been closed.
  // The rules live in `guest-merge-surface.ts`, pure and tested through the
  // sequences that broke them twice — an account-qualified key was not enough
  // on its own, and a boolean was not enough before that.
  const [surface, setSurface] = useState(initialSurfaceMemory);

  // Read inside callbacks that must not re-create themselves on every state
  // change — the merge runner's account guard in particular, which is handed to
  // a run that may outlive several renders and must see the CURRENT session
  // rather than the one captured when it started.
  //
  // Synchronised in an effect rather than during render: mutating a ref while
  // rendering is unsafe under concurrent React, which may render a component
  // whose output it then discards.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // "Not resolved yet" is broader than Better Auth's `isPending` (Phase 18 §2).
  // A cold boot with no network leaves `isPending` FALSE with `data` null —
  // the fetch rejected rather than staying in flight — and treating that as a
  // resolved guest is exactly the misclassification §19 forbids, only arriving
  // by a different route. Here it would be the worst-feeling version of it: an
  // offline learner offered the chance to merge their own account's work into
  // itself. `unknown` therefore gates these effects just as `isPending` does.
  const identity = classifySessionIdentity(session);
  const unresolved = identity.kind === "unknown";
  const userId = identity.kind === "account" ? identity.accountId : null;

  // Adjusted during render rather than in an effect: React's documented shape
  // for resetting state when an input changes, and the effect form is what
  // `react-hooks/set-state-in-effect` rejects. `forgetOnIdentityChange` returns
  // the SAME object when nothing changed, so this cannot loop.
  const nextSurface = forgetOnIdentityChange(surface, userId);
  if (nextSurface !== surface) setSurface(nextSurface);

  // The awaitable sync trigger, from the provider mounted above this one. It
  // goes through that provider's CONTROLLER, so the post-merge rebase inherits
  // the disabled/auth-lost back-offs instead of calling the server behind them.
  const { syncNow } = useSyncStatus();

  /** Is `id` still the signed-in account? One spelling, used by both guards. */
  const stillCurrent = useCallback((id: string): boolean => {
    const { session: current } = stateRef.current;
    return current.status === "signed-in" && current.userId === id;
  }, []);

  /**
   * The device id, minted once and reused (ARCH-004) — `sync-provider.tsx`
   * caches it across every trigger for the same reason, and re-running a Dexie
   * read-write transaction on each consent/retry bought nothing.
   */
  const deviceIdRef = useRef<string | null>(null);
  const readDeviceId = useCallback(
    async (db: ReturnType<typeof getSafwaDb>): Promise<string | null> => {
      if (deviceIdRef.current !== null) return deviceIdRef.current;
      const id = await getOrCreateDeviceProfile(db)
        .then((profile) => profile.deviceId)
        .catch(() => null);
      deviceIdRef.current = id;
      return id;
    },
    [],
  );

  useEffect(() => {
    if (unresolved) return;
    dispatch({ type: "session-resolved", userId });
  }, [unresolved, userId]);

  // The guest-data check. Runs once per resolved, signed-in session — a count,
  // never a collection.
  //
  // Deliberately NOT re-run when the flow changes (REL-003). An earlier version
  // depended on `flow.name === "deferred"` so a deferred offer's counts stayed
  // current; but that flag also flips as the learner consents OUT of `deferred`,
  // which fired a fresh IndexedDB scan racing the merge's own reads at the exact
  // moment it started. The reducer discarded the result, so it was waste rather
  // than a bug — but waste at the worst possible moment, and one relaxed guard
  // away from being a bug.
  useEffect(() => {
    if (unresolved || userId === null) return;
    let cancelled = false;
    void summarizeGuestData(getSafwaDb())
      .then((counts) => {
        if (cancelled) return;
        dispatch({
          type: "guest-data-checked",
          counts,
          meaningful: isMeaningfulGuestData(counts),
        });
      })
      .catch(() => {
        // A failed count is not a claim that there is nothing. Leaving the
        // machine in `checking` shows no offer, which is the honest outcome:
        // better to say nothing than to tell a learner their history is absent.
      });
    return () => {
      cancelled = true;
    };
  }, [unresolved, userId]);

  /**
   * Build the runner's dependencies.
   *
   * `onUnavailable` is the event to dispatch when the device profile cannot be
   * read (REL-002). It is the CALLER's to choose, because the two callers are
   * recovering from different things: a full merge that cannot start is an
   * ordinary local interruption, but a rebase-only retry that cannot start must
   * NOT be reported as one — doing so overwrites the `rebase-failed` reason and
   * its carried summary, and the next retry would then run the whole merge again
   * instead of just the pull it actually needed.
   */
  const buildDeps = useCallback(
    async (
      onUnavailable: GuestMergeEvent,
    ): Promise<GuestMergeRunnerDeps | null> => {
      if (userId === null) return null;
      const db = getSafwaDb();
      const deviceId = await readDeviceId(db);
      if (deviceId === null) {
        dispatch(onUnavailable);
        return null;
      }
      return {
        db,
        userId,
        dispatch,
        now: Date.now,
        // The account that started the merge must still be the signed-in one
        // for its results to be written. The SAME predicate is used for the
        // rebase's own guard below rather than a looser `id === userId`
        // (COMMIT-001): two spellings of one rule invite a future edit to
        // strengthen the one it happens to be reading.
        isCurrentAccount: stillCurrent,
        // The authoritative post-merge pull (§20.1). Routed through the sync
        // provider's controller rather than calling `runSync` here (ARCH-002),
        // so it inherits the disabled and auth-lost back-offs: a merge must not
        // keep contacting a server ordinary sync has already given up on. A full
        // run rather than a bare pull, so anything the account had queued
        // locally goes up in the same pass.
        rebase: async () => {
          if (!stillCurrent(userId)) return false;
          return syncNow();
        },
      };
    },
    [userId, stillCurrent, syncNow, readDeviceId],
  );

  const start = useCallback((): void => {
    void buildDeps({
      type: "upload-interrupted",
      reason: { kind: "local" },
    }).then((deps) => (deps ? runGuestMerge(deps) : undefined));
  }, [buildDeps]);

  const startRebase = useCallback((): void => {
    // A device profile this retry cannot read is one more failed rebase, not a
    // new kind of failure: reporting it as a local interruption would discard
    // the `rebase-failed` reason the next retry needs to route itself (REL-002).
    void buildDeps({ type: "rebase-failed" }).then((deps) =>
      deps ? retryGuestMergeRebase(deps) : undefined,
    );
  }, [buildDeps]);

  const consent = useCallback((): void => {
    // The machine is the authority on whether this is allowed; asking it first
    // means the rule lives in one place rather than being re-decided here.
    if (!canStartGuestMerge(stateRef.current)) return;
    // And the RUNNER is the authority on whether one is already going. Without
    // this, a provider that remounted mid-run would move its own state to
    // `preparing` and wait forever, because the running merge's events go to the
    // discarded instance's dispatch (REL-001).
    if (userId !== null && isGuestMergeRunning(userId)) return;
    dispatch({ type: "consented" });
    start();
  }, [start, userId]);

  const retry = useCallback((): void => {
    if (!canStartGuestMerge(stateRef.current)) return;
    if (userId !== null && isGuestMergeRunning(userId)) return;
    // Which KIND of retry this is, is the machine's decision — asked, not
    // re-derived (ARCH-001). The two conditions were briefly written twice and
    // already differed, which is a UI running a bare pull while the state it
    // renders says a full upload is under way.
    const rebaseOnly = needsRebaseOnlyRetry(stateRef.current);
    dispatch({ type: "retry" });
    if (rebaseOnly) {
      startRebase();
      return;
    }
    start();
  }, [start, startRebase, userId]);

  const defer = useCallback((): void => {
    dispatch({ type: "deferred" });
  }, []);

  const dismiss = useCallback((): void => {
    setSurface(rememberDismissal(stateRef.current, userId));
  }, [userId]);

  /**
   * Show a deferred offer again (SEC-002). It dispatches `reconsider`, NOT
   * `consented`: taking up a deferred offer must show the counts before
   * anything is sent, rather than starting the upload from a button whose
   * label is the only thing the learner read.
   */
  const reconsider = useCallback((): void => {
    dispatch({ type: "reconsider" });
  }, []);

  return (
    <GuestMergeContext.Provider
      value={{
        state,
        active: isGuestMergeActive(state),
        canStart: canStartGuestMerge(state),
        consent,
        defer,
        retry,
        dismiss,
        reconsider,
        visible: isSurfaceVisible(nextSurface, state),
      }}
    >
      {children}
    </GuestMergeContext.Provider>
  );
}
