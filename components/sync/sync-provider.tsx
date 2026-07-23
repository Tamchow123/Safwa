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

import { useSession } from "@/modules/auth/client";
import { getSafwaDb } from "@/modules/content/db";
import { getOrCreateDeviceProfile } from "@/modules/profile/device";
import {
  createSyncController,
  type SyncController,
} from "@/modules/sync/client/controller";
import { countPendingScheduling } from "@/modules/sync/client/local-selection";
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
 * notification — we have just kicked off a bootstrap sync, so `syncing` is the
 * honest placeholder (the controller replaces it on its first notify, which
 * always fires, even on the offline/guest early-return paths).
 */
function initialSignedInStatus(): SyncStatus {
  return deriveSyncStatus({
    enabled: true,
    authenticated: true,
    online: onlineNow(),
    running: true,
    pendingCount: 0,
    needsAttention: false,
  });
}

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const userId = session.data?.user?.id ?? null;

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
          countPending: countPendingScheduling,
        });
        controllerRef.current = controller;
        unsubscribe = controller.subscribe((next) => {
          if (!disposed) setSignedInStatus({ userId, status: next });
        });

        document.addEventListener("visibilitychange", onVisibility);
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
      window.removeEventListener("online", onOnline);
      unsubscribe();
      controllerRef.current = null;
    };
  }, [userId, retryToken]);

  const retry = useCallback((): void => {
    if (controllerRef.current) {
      void controllerRef.current.sync("manual");
    } else if (userId !== null) {
      // No controller (device-id mint failed): re-run the effect to re-attempt
      // building it, so the attention-state retry actually recovers (§20).
      setRetryToken((token) => token + 1);
    }
    // Guest (userId null): retry is a no-op — guests never call the server.
  }, [userId]);

  // Stable so a study runner can list it as an effect dependency without churn.
  const notifySessionEnd = useCallback((): void => {
    void controllerRef.current?.sync("session-end");
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
    <SyncContext.Provider value={{ status, retry, notifySessionEnd }}>
      {children}
    </SyncContext.Provider>
  );
}
