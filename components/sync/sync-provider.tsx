"use client";

/**
 * Phase 16 — the React wiring for online sync (§18 triggers, §20 status). This
 * is the ONLY place DOM timers/listeners and the Better Auth session meet the
 * framework-light sync controller. Study/collection UI never imports sync
 * decision logic; the sole exception is `useSessionEndSync()` below — an opaque,
 * non-throwing trigger carrying NO push/pull/selection logic, exported so a
 * study runner can request an end-of-session sync without depending on (or
 * knowing anything about) the sync layer.
 *
 * Lifecycle, keyed on the signed-in account id:
 *  - GUEST (no user id): no controller is built and NO trigger fires — guests
 *    never call the server (§18). The status is `guest`.
 *  - SIGNED IN: mint/read the device id, build one controller, then wire the
 *    required triggers — bootstrap on mount, a periodic tick WHILE the document
 *    is visible (paused when hidden), a sync when the tab becomes visible again,
 *    a push+pull when the tab is hidden (session end), an online-restored retry,
 *    and a manual retry exposed via context for the attention state.
 *  - TEARDOWN / ACCOUNT SWITCH: the effect's cleanup clears the interval, removes
 *    every listener, unsubscribes, and drops the controller. A `disposed` flag
 *    also flips the controller's `isCurrentAccount` guard false, so any run still
 *    in flight for the old account stops WITHOUT writing (defence in depth on top
 *    of the controller's own `invalidated` back-off).
 *
 * Overlapping triggers are safe: the controller delegates to the coalescing
 * runSync, so at most one run per account is ever in flight. Clock/online are
 * read live; the whole thing self-gates, so mounting it app-wide is safe.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { useLocalOwner } from "@/components/sync/use-local-owner";
import { getSafwaDb } from "@/modules/content/db";
import { getOrCreateDeviceProfile } from "@/modules/profile/device";
import {
  createSyncController,
  type SyncController,
} from "@/modules/sync/client/controller";
import { countPendingChanges } from "@/modules/sync/client/local-selection";
import { countDeadLetterMutations } from "@/modules/sync/client/mutation-queue";
import {
  deriveSyncStatus,
  type SyncStatus,
} from "@/modules/sync/client/status";

/** How often to sync while the tab is active (§18 periodic-while-active). */
const PERIODIC_INTERVAL_MS = 5 * 60_000;

export type SyncContextValue = {
  /** The current derived sync status (single source of truth for the indicator). */
  status: SyncStatus;
  /** Manual retry from the attention state (§18/§20) — a no-op for a guest. */
  retry: () => void;
  /**
   * Request a push+pull because a study session just ended (§18 "push at
   * successful session end"). A no-op for a guest / before the controller
   * exists; overlapping triggers coalesce, so calling it is always safe. If a
   * session completes in the brief window before the async controller build
   * resolves, this specific nudge is dropped — the freshly-completed data is
   * still durably in Dexie and reaches the server via the bootstrap sync (which
   * runs as soon as the controller comes up) or the next periodic/visibility
   * sync. That best-effort coverage is deliberate for Stage A (no durable
   * per-trigger retry).
   */
  notifySessionEnd: () => void;
  /**
   * Run one sync and AWAIT its outcome, resolving true only when the account is
   * fully in step with the server. Unlike the fire-and-forget triggers above,
   * this is for a caller that cannot continue until the pull has landed — the
   * post-merge rebase (phases-17.md §20.1), which runs after local finalisation
   * has dropped the merged components' local cards.
   *
   * It goes through the CONTROLLER rather than calling `runSync` directly
   * (ARCH-002), so it inherits the disabled and auth-lost back-offs: a caller
   * cannot keep hammering a server this provider has already established should
   * not be contacted. Resolves false for a guest, a backed-off account, an
   * offline device, or a run that did not finish — all of which the caller must
   * treat as "not yet", never as success.
   */
  syncNow: () => Promise<boolean>;
};

const SyncContext = createContext<SyncContextValue | null>(null);

/** Read the current sync status + manual retry. Must be inside <SyncProvider>. */
export function useSyncStatus(): SyncContextValue {
  const value = useContext(SyncContext);
  if (value === null) {
    throw new Error("useSyncStatus must be used within a SyncProvider");
  }
  return value;
}

/**
 * Non-throwing status read: returns null when rendered OUTSIDE a SyncProvider.
 * The status indicator lives in the shared header, which is also rendered in
 * isolation (e.g. guest-independence unit tests) where no provider wraps it —
 * so the indicator degrades to nothing rather than crashing the shell.
 */
export function useOptionalSyncStatus(): SyncContextValue | null {
  return useContext(SyncContext);
}

/** Stable no-op used when a component renders outside a SyncProvider. */
const NOOP_SESSION_END = () => {};

/**
 * The session-end sync trigger, safe to call from a study runner. Unlike
 * `useSyncStatus`, this does NOT require a provider: outside one (e.g. a runner
 * rendered in isolation in a test) it returns a stable no-op, so study UI can
 * request an end-of-session sync without depending on the sync layer or knowing
 * anything about it (§18 "Do not put sync logic directly into study UI").
 */
export function useSessionEndSync(): () => void {
  return useContext(SyncContext)?.notifySessionEnd ?? NOOP_SESSION_END;
}

function onlineNow(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

/** The guest status — shown before/without a signed-in account. */
function guestStatus(): SyncStatus {
  return deriveSyncStatus({
    enabled: true,
    authenticated: false,
    online: true,
    running: false,
    pendingCount: 0,
    needsAttention: false,
  });
}

/**
 * The status shown for a signed-in account before its controller's first
 * notification. `running` is conditioned on being online: a bootstrap sync has
 * been kicked off, so `syncing` is the honest placeholder for a device that can
 * actually reach the server — but claiming it while OFFLINE would be a claim
 * about the network, and `running` outranks `offline` in the precedence order,
 * so the placeholder would hide the very thing the learner needs to see. The
 * controller replaces this on its first notify either way (it always fires,
 * even on the offline early-return path); this is about the moment before that.
 */
function initialSignedInStatus(): SyncStatus {
  const online = onlineNow();
  return deriveSyncStatus({
    enabled: true,
    authenticated: true,
    online,
    running: online,
    pendingCount: 0,
    needsAttention: false,
  });
}

export function SyncProvider({ children }: { children: React.ReactNode }) {
  // Phase 18: the LOCAL OWNER, not a raw `useSession()` read. On an offline
  // cold boot the session resolves to `unknown`, which `data?.user?.id ?? null`
  // reported as a guest — so no controller was built, no trigger ever fired,
  // and the indicator claimed `guest` to a learner who was signed in. Going
  // through the classifier means the controller exists, the queue drains on
  // reconnect, and the status reads `offline`, which is the true thing.
  const userId = useLocalOwner();

  // Only the signed-in status lives in state (set via the controller's async
  // subscription); the guest status is derived at render, so the effect never
  // sets state synchronously. The status is TAGGED with the account it belongs
  // to, so a status left over from a previous account is ignored at render on an
  // account switch (the new account falls back to the `syncing` placeholder
  // until ITS controller notifies) rather than briefly showing the old account's
  // pending/attention state.
  const [signedInStatus, setSignedInStatus] = useState<{
    userId: string;
    status: SyncStatus;
  } | null>(null);
  // Bumped by a manual retry when NO controller exists yet (e.g. the device-id
  // mint failed): it re-runs the effect so the mint — and thus the controller
  // build — is genuinely re-attempted, keeping the `attention` retry actionable.
  const [retryToken, setRetryToken] = useState(0);
  const controllerRef = useRef<SyncController | null>(null);

  useEffect(() => {
    // Guests never call the server: no controller, no triggers.
    if (userId === null) {
      controllerRef.current = null;
      return;
    }

    let disposed = false;
    let controller: SyncController | null = null;
    let unsubscribe = () => {};
    let interval: ReturnType<typeof setInterval> | undefined;

    const db = getSafwaDb();

    function startInterval(): void {
      if (interval === undefined && document.visibilityState === "visible") {
        interval = setInterval(() => {
          void controller?.sync("periodic");
        }, PERIODIC_INTERVAL_MS);
      }
    }
    function stopInterval(): void {
      if (interval !== undefined) {
        clearInterval(interval);
        interval = undefined;
      }
    }

    const onVisibility = (): void => {
      if (document.visibilityState === "visible") {
        void controller?.sync("visible");
        startInterval();
      } else {
        // The tab is hidden: pause the periodic timer and flush a session-end
        // push+pull (best-effort — Phase 16 needs no durable offline retry).
        stopInterval();
        void controller?.sync("session-end");
      }
    };
    // iOS Safari does not reliably fire `visibilitychange` when the app is
    // backgrounded or killed — `pagehide` is the event that is actually
    // dispatched there, and it is the last moment this document is guaranteed
    // to run code. Without it, a learner who studies offline in an installed
    // PWA and swipes away loses the session-end flush entirely.
    //
    // Safe beside the visibilitychange handler rather than instead of it: on
    // desktop both can fire for one backgrounding, and the controller delegates
    // to the coalescing `runSync`, so overlapping triggers join the one
    // in-flight run. No debounce of our own is needed or wanted.
    const onPageHide = (): void => {
      stopInterval();
      void controller?.sync("session-end");
    };
    // The other half of `pagehide`, and not optional once it exists. A page
    // restored from the back/forward cache — which is what an installed iOS
    // PWA returning to the foreground looks like — resumes the SAME JavaScript
    // heap, so this effect never re-runs and nothing rebuilds itself. It fires
    // `pageshow`; `visibilitychange` is not guaranteed, which is the very
    // unreliability that made `pagehide` necessary above. Without this, the
    // interval that `pagehide` stopped stays stopped and the indicator freezes
    // on its pre-background status while fresh reviews queue up unreported.
    const onPageShow = (): void => {
      if (document.visibilityState === "visible") {
        void controller?.sync("visible");
        startInterval();
      }
    };
    const onOnline = (): void => {
      void controller?.sync("online");
    };

    // The device id is async (minted on first use), so build the controller and
    // wire triggers once it resolves. A teardown before then is honoured via
    // `disposed`, so we never attach listeners to a controller nobody holds.
    void getOrCreateDeviceProfile(db)
      .then((profile) => {
        if (disposed) return;
        controller = createSyncController({
          db,
          userId,
          deviceId: profile.deviceId,
          now: Date.now,
          online: onlineNow,
          // A torn-down (account-switched) controller is no longer current, so
          // an in-flight run for the old account stops without writing.
          isCurrentAccount: (id) => !disposed && id === userId,
          countPending: countPendingChanges,
          // A permanent dead-letter forces the honest attention state (R2-F6).
          countDeadLetter: countDeadLetterMutations,
        });
        controllerRef.current = controller;
        unsubscribe = controller.subscribe((next) => {
          if (!disposed) setSignedInStatus({ userId, status: next });
        });

        document.addEventListener("visibilitychange", onVisibility);
        window.addEventListener("pagehide", onPageHide);
        window.addEventListener("pageshow", onPageShow);
        window.addEventListener("online", onOnline);
        startInterval();
        void controller.sync("bootstrap");
      })
      .catch(() => {
        // Device-id mint failed (e.g. IndexedDB unavailable/corrupt): no
        // controller could be built, so surface an honest `attention` state
        // rather than leaving the indicator stuck on the `syncing` placeholder.
        if (!disposed) {
          setSignedInStatus({
            userId,
            status: deriveSyncStatus({
              enabled: true,
              authenticated: true,
              online: onlineNow(),
              running: false,
              pendingCount: 0,
              needsAttention: true,
            }),
          });
        }
      });

    return () => {
      disposed = true;
      stopInterval();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", onOnline);
      unsubscribe();
      controllerRef.current = null;
    };
  }, [userId, retryToken]);

  const retry = useCallback((): void => {
    if (userId === null) return; // Guest: guests never call the server.

    // Rebuild rather than re-call ONLY when the controller has nothing left to
    // give. Two cases: the device-id mint failed so there is no controller at
    // all (§20), or an `auth_lost`/`invalidated` outcome set the permanent
    // back-off — and `sync()` discards its `reason`, so a "manual" call through
    // a stopped controller returns immediately without attempting anything,
    // leaving the app's own visible remedy inert. Rebuilding is self-limiting:
    // the effect re-reads the owner, so a session that has since resolved to
    // guest builds nothing.
    //
    // Asked of the controller rather than inferred from an `attention` status,
    // which cannot answer it: `attention` also covers a plain recoverable
    // failure and a dead-letter backlog, and rebuilding for either would
    // discard an accurate `deadLetterCount` for a fresh controller's zero —
    // which, if the device is offline at that moment, its bootstrap never
    // refreshes. A learner tapping retry on a permanent failure would watch it
    // soften to "offline" while nothing had been resolved (R2-F6).
    const controller = controllerRef.current;
    if (controller === null || controller.isStopped()) {
      setRetryToken((token) => token + 1);
      return;
    }

    void controller.sync("manual");
  }, [userId]);

  // Stable so a study runner can list it as an effect dependency without churn.
  const notifySessionEnd = useCallback((): void => {
    void controllerRef.current?.sync("session-end");
  }, []);

  const syncNow = useCallback(async (): Promise<boolean> => {
    const controller = controllerRef.current;
    // No controller means a guest, or an account whose controller has not been
    // built yet. Either way this device is not in step with a server, and
    // saying otherwise is the false claim the caller depends on us not making.
    if (!controller) return false;
    const result = await controller.sync("manual");
    return result?.outcome === "synced";
  }, []);

  // Guest status is derived at render; a signed-in account shows ITS controller
  // status once subscribed (matched by userId so a stale status from a previous
  // account is never shown), or the `syncing` placeholder until the first notify.
  const status =
    userId === null
      ? guestStatus()
      : signedInStatus?.userId === userId
        ? signedInStatus.status
        : initialSignedInStatus();

  return (
    <SyncContext.Provider value={{ status, retry, notifySessionEnd, syncNow }}>
      {children}
    </SyncContext.Provider>
  );
}
