import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RunSyncDeps } from "@/modules/sync/client/orchestrator";
import type { SyncStatus } from "@/modules/sync/client/status";
import { LAST_KNOWN_OWNER_STORAGE_KEY } from "@/modules/auth/last-known-owner";

/**
 * Proves the SyncProvider wiring (§18 triggers): guests build no controller and
 * fire no server call; a signed-in user gets one controller with the required
 * triggers (bootstrap, periodic-while-visible, visibility, online, session-end,
 * manual retry); and teardown/account-switch tears everything down. The
 * controller's own decision logic is unit-tested in controller.test.ts — here we
 * mock it and assert the provider drives it correctly.
 */
let sessionState: {
  data: { user: { id: string; email: string } } | null;
  isPending: boolean;
  error: unknown;
};
vi.mock("@/modules/auth/client", () => ({ useSession: () => sessionState }));

const fakeDb = { name: "fake" };
vi.mock("@/modules/content/db", () => ({ getSafwaDb: () => fakeDb }));

const getOrCreateDeviceProfileMock = vi.fn(async () => ({ deviceId: "dev-1" }));
vi.mock("@/modules/profile/device", () => ({
  getOrCreateDeviceProfile: () => getOrCreateDeviceProfileMock(),
}));

vi.mock("@/modules/sync/client/local-selection", () => ({
  // The provider wires the controller's countPending to countPendingChanges
  // (scheduling backlog + queued mutations, EXT-F2); stub it — these tests
  // exercise the provider's triggers/status, not the count itself.
  countPendingChanges: vi.fn(async () => 0),
}));

vi.mock("@/modules/sync/client/mutation-queue", () => ({
  // The provider wires the controller's countDeadLetter to
  // countDeadLetterMutations (R2-F6); stub it so the real Dexie module isn't
  // pulled in — these tests exercise the provider's wiring, not the count.
  countDeadLetterMutations: vi.fn(async () => 0),
}));

let capturedListener: ((status: unknown) => void) | null = null;
let capturedDeps: RunSyncDeps | null = null;
/**
 * The status a NEWLY BUILT fake controller carries and notifies on every
 * `sync()` — mirroring the real controller, which notifies at the start of
 * every run INCLUDING the offline early-return path, and which offline never
 * reaches `refreshPending()`, so a fresh instance's counts are genuinely zero.
 *
 * `null` (the default) keeps the fake silent, which is what every test that
 * drives the status through `capturedListener` by hand wants. The retry tests
 * set it so that the difference between "kept the controller" and "rebuilt it"
 * is observable in the rendered status rather than only in a call count.
 */
let freshControllerStatus: SyncStatus | null = null;
/** Whether a newly built fake controller reports itself permanently stopped. */
let freshControllerStopped = false;
const controllerSync = vi.fn(async (reason: string): Promise<null> => {
  void reason; // recorded for assertions; the fake needs nothing from it
  return null;
});
const controllerUnsub = vi.fn();
const createSyncControllerMock = vi.fn((deps: RunSyncDeps) => {
  capturedDeps = deps;
  // Captured per INSTANCE, not read from the module-level lets at call time:
  // the whole point of the retry tests is that a rebuilt controller starts
  // from its own zeroed view of the world, distinct from the outgoing one's.
  const ownStatus = freshControllerStatus;
  const ownStopped = freshControllerStopped;
  let ownListener: ((status: unknown) => void) | null = null;
  return {
    sync: (reason: string) => {
      if (ownStatus !== null) ownListener?.(ownStatus);
      return controllerSync(reason);
    },
    subscribe: (fn: (status: unknown) => void) => {
      ownListener = fn;
      capturedListener = fn;
      return controllerUnsub;
    },
    getStatus: () => ownStatus ?? { kind: "synced", pendingCount: 0 },
    refreshPending: vi.fn(),
    isStopped: () => ownStopped,
  };
});
vi.mock("@/modules/sync/client/controller", () => ({
  createSyncController: (deps: RunSyncDeps) => createSyncControllerMock(deps),
}));

import {
  SyncProvider,
  useSessionEndSync,
  useSyncStatus,
} from "@/components/sync/sync-provider";

function Consumer() {
  const { status, retry, notifySessionEnd } = useSyncStatus();
  return (
    <div>
      <span data-testid="kind">{status.kind}</span>
      <span data-testid="pending">{status.pendingCount}</span>
      <button onClick={retry}>retry</button>
      <button onClick={notifySessionEnd}>session-end</button>
    </div>
  );
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    value: state,
    configurable: true,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** jsdom reports `navigator.onLine` as true; the offline cases need it false. */
function setOnline(online: boolean) {
  Object.defineProperty(navigator, "onLine", {
    value: online,
    configurable: true,
  });
}

const SIGNED_IN = {
  data: { user: { id: "user-1", email: "a@b.co" } },
  isPending: false,
  error: null,
};

beforeEach(() => {
  sessionState = { data: null, isPending: false, error: null };
  localStorage.clear();
  setOnline(true);
  capturedListener = null;
  capturedDeps = null;
  freshControllerStatus = null;
  freshControllerStopped = false;
  controllerSync.mockClear();
  controllerUnsub.mockClear();
  createSyncControllerMock.mockClear();
  getOrCreateDeviceProfileMock.mockClear();
  Object.defineProperty(document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SyncProvider", () => {
  it("builds NO controller and reports guest status for a guest", async () => {
    render(
      <SyncProvider>
        <Consumer />
      </SyncProvider>,
    );
    // Flush any pending microtasks; a guest must schedule nothing.
    await act(async () => {});

    expect(screen.getByTestId("kind")).toHaveTextContent("guest");
    expect(createSyncControllerMock).not.toHaveBeenCalled();
    expect(getOrCreateDeviceProfileMock).not.toHaveBeenCalled();
    expect(controllerSync).not.toHaveBeenCalled();
  });

  it("mints the device id, builds one controller and fires a bootstrap sync", async () => {
    sessionState = SIGNED_IN;
    render(
      <SyncProvider>
        <Consumer />
      </SyncProvider>,
    );

    await waitFor(() =>
      expect(createSyncControllerMock).toHaveBeenCalledTimes(1),
    );
    expect(capturedDeps?.userId).toBe("user-1");
    expect(capturedDeps?.deviceId).toBe("dev-1");
    await waitFor(() =>
      expect(controllerSync).toHaveBeenCalledWith("bootstrap"),
    );
  });

  it("reflects controller status updates to consumers", async () => {
    sessionState = SIGNED_IN;
    render(
      <SyncProvider>
        <Consumer />
      </SyncProvider>,
    );
    await waitFor(() => expect(capturedListener).not.toBeNull());

    act(() => capturedListener!({ kind: "pending", pendingCount: 4 }));
    expect(screen.getByTestId("kind")).toHaveTextContent("pending");
  });

  it("manual retry triggers a manual sync", async () => {
    sessionState = SIGNED_IN;
    render(
      <SyncProvider>
        <Consumer />
      </SyncProvider>,
    );
    await waitFor(() => expect(createSyncControllerMock).toHaveBeenCalled());
    controllerSync.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    expect(controllerSync).toHaveBeenCalledWith("manual");
  });

  it("syncs when the device comes back online", async () => {
    sessionState = SIGNED_IN;
    render(
      <SyncProvider>
        <Consumer />
      </SyncProvider>,
    );
    await waitFor(() => expect(createSyncControllerMock).toHaveBeenCalled());
    controllerSync.mockClear();

    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(controllerSync).toHaveBeenCalledWith("online");
  });

  it("flushes a session-end sync when hidden and resyncs when visible again", async () => {
    sessionState = SIGNED_IN;
    render(
      <SyncProvider>
        <Consumer />
      </SyncProvider>,
    );
    await waitFor(() => expect(createSyncControllerMock).toHaveBeenCalled());
    controllerSync.mockClear();

    act(() => setVisibility("hidden"));
    expect(controllerSync).toHaveBeenCalledWith("session-end");

    controllerSync.mockClear();
    act(() => setVisibility("visible"));
    expect(controllerSync).toHaveBeenCalledWith("visible");
  });

  it("flushes a session-end sync on pagehide (iOS Safari's actual event)", async () => {
    // iOS Safari does not reliably fire `visibilitychange` when an installed
    // PWA is backgrounded or killed. Without this listener, a learner who
    // studies offline and swipes away loses the session-end flush entirely.
    sessionState = SIGNED_IN;
    render(
      <SyncProvider>
        <Consumer />
      </SyncProvider>,
    );
    await waitFor(() => expect(createSyncControllerMock).toHaveBeenCalled());
    controllerSync.mockClear();

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(controllerSync).toHaveBeenCalledWith("session-end");
  });

  it("restarts the periodic timer on pageshow, which bfcache is what fires", async () => {
    // The other half of pagehide, and the case that makes it safe. A page
    // restored from the back/forward cache — an installed iOS PWA returning to
    // the foreground — resumes the SAME heap, so this effect never re-runs and
    // nothing rebuilds itself. `visibilitychange` is not guaranteed on resume;
    // `pageshow` is. Without listening for it, the interval pagehide stopped
    // would stay stopped and the indicator would freeze.
    sessionState = SIGNED_IN;
    vi.useFakeTimers();
    render(
      <SyncProvider>
        <Consumer />
      </SyncProvider>,
    );
    await act(async () => {});
    await act(async () => {});

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    controllerSync.mockClear();

    // Nothing periodic while backgrounded.
    act(() => {
      vi.advanceTimersByTime(11 * 60_000);
    });
    expect(controllerSync).not.toHaveBeenCalledWith("periodic");

    act(() => {
      window.dispatchEvent(new Event("pageshow"));
    });
    expect(controllerSync).toHaveBeenCalledWith("visible");

    controllerSync.mockClear();
    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(controllerSync).toHaveBeenCalledWith("periodic");
  });

  it("does not resume on pageshow while the document is hidden", async () => {
    sessionState = SIGNED_IN;
    render(
      <SyncProvider>
        <Consumer />
      </SyncProvider>,
    );
    await waitFor(() => expect(createSyncControllerMock).toHaveBeenCalled());
    act(() => setVisibility("hidden"));
    controllerSync.mockClear();

    act(() => {
      window.dispatchEvent(new Event("pageshow"));
    });

    expect(controllerSync).not.toHaveBeenCalledWith("visible");
  });

  it("rebuilds the controller when the outgoing one has permanently stopped", async () => {
    // An `auth_lost`/`invalidated` outcome sets the controller's permanent
    // back-off, and its `sync()` discards the reason argument — so a "manual"
    // call through a stopped controller does nothing at all, leaving the app's
    // own visible remedy inert. Rebuilding is the only thing that recovers it.
    // This path became reachable from a cold boot only in this slice, because a
    // stale remembered account used to be misclassified as a guest and never
    // got a controller at all.
    sessionState = SIGNED_IN;
    freshControllerStopped = true;
    freshControllerStatus = { kind: "attention", pendingCount: 3 };
    render(
      <SyncProvider>
        <Consumer />
      </SyncProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("kind")).toHaveTextContent("attention"),
    );

    // What a REBUILT controller would honestly report: it has run no sync, so
    // it knows of no pending or dead-lettered work, and offline it never will.
    setOnline(false);
    freshControllerStopped = false;
    freshControllerStatus = { kind: "offline", pendingCount: 0 };
    createSyncControllerMock.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "retry" }));

    await waitFor(() =>
      expect(createSyncControllerMock).toHaveBeenCalledTimes(1),
    );
    // Correct here — the outgoing controller was inert, so its counts were the
    // stale ones — and it is what the next test proves must NOT happen when the
    // controller could still have acted.
    await waitFor(() =>
      expect(screen.getByTestId("kind")).toHaveTextContent("offline"),
    );
    expect(screen.getByTestId("pending")).toHaveTextContent("0");
  });

  it("does not rebuild for an attention state the live controller can still act on", async () => {
    // `attention` is one status kind covering three different causes: a
    // recoverable failure, a dead-letter backlog, and the permanent stop above.
    // Only the last needs a rebuild. Rebuilding for the others throws away the
    // outgoing controller's accurate counts for a fresh instance's zeroes —
    // and offline, that instance's bootstrap returns before `refreshPending()`
    // ever runs, so the zeroes stick. A learner tapping retry on 3 permanently
    // rejected changes would watch the warning soften to a bare "offline" while
    // nothing whatsoever had been resolved (R2-F6).
    sessionState = SIGNED_IN;
    freshControllerStatus = { kind: "attention", pendingCount: 3 };
    render(
      <SyncProvider>
        <Consumer />
      </SyncProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("kind")).toHaveTextContent("attention"),
    );

    setOnline(false);
    freshControllerStatus = { kind: "offline", pendingCount: 0 };
    controllerSync.mockClear();
    createSyncControllerMock.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    await act(async () => {});

    expect(controllerSync).toHaveBeenCalledWith("manual");
    expect(createSyncControllerMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("kind")).toHaveTextContent("attention");
    expect(screen.getByTestId("pending")).toHaveTextContent("3");
  });

  it("still issues a plain manual sync when the status is not attention", async () => {
    sessionState = SIGNED_IN;
    render(
      <SyncProvider>
        <Consumer />
      </SyncProvider>,
    );
    await waitFor(() => expect(capturedListener).not.toBeNull());

    act(() => capturedListener!({ kind: "pending", pendingCount: 2 }));
    controllerSync.mockClear();
    createSyncControllerMock.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "retry" }));

    expect(controllerSync).toHaveBeenCalledWith("manual");
    expect(createSyncControllerMock).not.toHaveBeenCalled();
  });

  it("removes the pagehide listener on unmount", async () => {
    sessionState = SIGNED_IN;
    const { unmount } = render(
      <SyncProvider>
        <Consumer />
      </SyncProvider>,
    );
    await waitFor(() => expect(createSyncControllerMock).toHaveBeenCalled());
    unmount();
    controllerSync.mockClear();

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    expect(controllerSync).not.toHaveBeenCalled();
  });

  it("fires a periodic sync while the tab is visible", async () => {
    sessionState = SIGNED_IN;
    vi.useFakeTimers();
    try {
      render(
        <SyncProvider>
          <Consumer />
        </SyncProvider>,
      );
      // Flush the async controller build (promise microtasks) under fake timers.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(createSyncControllerMock).toHaveBeenCalled();
      controllerSync.mockClear();

      act(() => {
        vi.advanceTimersByTime(5 * 60_000);
      });
      expect(controllerSync).toHaveBeenCalledWith("periodic");
    } finally {
      vi.useRealTimers();
    }
  });

  it("tears down listeners and the controller on unmount", async () => {
    sessionState = SIGNED_IN;
    const { unmount } = render(
      <SyncProvider>
        <Consumer />
      </SyncProvider>,
    );
    await waitFor(() => expect(createSyncControllerMock).toHaveBeenCalled());

    unmount();
    expect(controllerUnsub).toHaveBeenCalled();

    // No trigger fires after teardown.
    controllerSync.mockClear();
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(controllerSync).not.toHaveBeenCalled();
  });

  it("rebuilds the controller on account switch and tears the old one down", async () => {
    sessionState = SIGNED_IN;
    const { rerender } = render(
      <SyncProvider>
        <Consumer />
      </SyncProvider>,
    );
    await waitFor(() =>
      expect(createSyncControllerMock).toHaveBeenCalledTimes(1),
    );

    sessionState = {
      data: { user: { id: "user-2", email: "b@b.co" } },
      isPending: false,
      error: null,
    };
    rerender(
      <SyncProvider>
        <Consumer />
      </SyncProvider>,
    );

    // The old controller is unsubscribed and a fresh one is built for user-2.
    expect(controllerUnsub).toHaveBeenCalled();
    await waitFor(() =>
      expect(createSyncControllerMock).toHaveBeenCalledTimes(2),
    );
    await waitFor(() => expect(capturedDeps?.userId).toBe("user-2"));
  });

  it("shows the syncing placeholder (not the previous account's status) right after a switch", async () => {
    sessionState = SIGNED_IN;
    const { rerender } = render(
      <SyncProvider>
        <Consumer />
      </SyncProvider>,
    );
    await waitFor(() => expect(capturedListener).not.toBeNull());
    // user-1 is in an attention state.
    act(() => capturedListener!({ kind: "attention", pendingCount: 2 }));
    expect(screen.getByTestId("kind")).toHaveTextContent("attention");

    // Switch to user-2: before user-2's controller notifies, the indicator must
    // NOT still show user-1's attention — it shows the syncing placeholder.
    sessionState = {
      data: { user: { id: "user-2", email: "b@b.co" } },
      isPending: false,
      error: null,
    };
    rerender(
      <SyncProvider>
        <Consumer />
      </SyncProvider>,
    );
    expect(screen.getByTestId("kind")).toHaveTextContent("syncing");
  });

  it("surfaces attention (not a stuck syncing) if the device profile fails to init", async () => {
    sessionState = SIGNED_IN;
    getOrCreateDeviceProfileMock.mockRejectedValueOnce(new Error("idb down"));
    render(
      <SyncProvider>
        <Consumer />
      </SyncProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("kind")).toHaveTextContent("attention"),
    );
    expect(createSyncControllerMock).not.toHaveBeenCalled();
  });

  it("retry re-attempts the device-profile mint when it initially failed", async () => {
    sessionState = SIGNED_IN;
    // Only the first mint rejects; the retry re-attempt resolves normally.
    getOrCreateDeviceProfileMock.mockRejectedValueOnce(new Error("idb down"));
    render(
      <SyncProvider>
        <Consumer />
      </SyncProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("kind")).toHaveTextContent("attention"),
    );
    expect(createSyncControllerMock).not.toHaveBeenCalled();

    // The other rebuild trigger: there is no controller AT ALL to ask
    // `isStopped()`. The retry must still actually recover — re-mint, build the
    // controller and fire a bootstrap sync.
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    await waitFor(() =>
      expect(createSyncControllerMock).toHaveBeenCalledTimes(1),
    );
    await waitFor(() =>
      expect(controllerSync).toHaveBeenCalledWith("bootstrap"),
    );
  });

  it("notifySessionEnd triggers a session-end sync", async () => {
    sessionState = SIGNED_IN;
    render(
      <SyncProvider>
        <Consumer />
      </SyncProvider>,
    );
    await waitFor(() => expect(createSyncControllerMock).toHaveBeenCalled());
    controllerSync.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "session-end" }));
    expect(controllerSync).toHaveBeenCalledWith("session-end");
  });

  it("builds a controller for an OFFLINE COLD BOOT and reports offline, not guest", async () => {
    // Phase 18 §2/§5, and the reason this slice exists. The session read
    // rejected, so `isPending` is already false and `data` was never populated
    // — the shape `data?.user?.id ?? null` reported as a guest, which meant no
    // controller, no triggers, nothing to drain on reconnect, and an indicator
    // telling a signed-in learner they were a guest.
    localStorage.setItem(LAST_KNOWN_OWNER_STORAGE_KEY, "user-1");
    sessionState = { data: null, isPending: false, error: { status: 0 } };
    setOnline(false);

    render(
      <SyncProvider>
        <Consumer />
      </SyncProvider>,
    );

    await waitFor(() =>
      expect(createSyncControllerMock).toHaveBeenCalledTimes(1),
    );
    // Built for the REMEMBERED account, so its queue is that account's.
    expect(capturedDeps?.userId).toBe("user-1");
    expect(controllerSync).toHaveBeenCalledWith("bootstrap");
    // And the placeholder shown before the controller's first notify is honest
    // about the network rather than claiming a run is in flight.
    expect(screen.getByTestId("kind")).toHaveTextContent("offline");
  });

  it("still reports guest for an offline boot with no remembered owner", async () => {
    // A device that has never seen an account has nothing to be offline FOR.
    sessionState = { data: null, isPending: false, error: { status: 0 } };
    setOnline(false);

    render(
      <SyncProvider>
        <Consumer />
      </SyncProvider>,
    );
    await act(async () => {});

    expect(screen.getByTestId("kind")).toHaveTextContent("guest");
    expect(createSyncControllerMock).not.toHaveBeenCalled();
  });

  it("throws if useSyncStatus is used outside a provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Consumer />)).toThrow(/within a SyncProvider/);
    spy.mockRestore();
  });

  it("useSessionEndSync is a safe no-op outside a provider (study runners render standalone)", () => {
    function StandaloneRunner() {
      const notify = useSessionEndSync();
      // Calling it without a provider must not throw.
      notify();
      return <span>ok</span>;
    }
    expect(() => render(<StandaloneRunner />)).not.toThrow();
    expect(screen.getByText("ok")).toBeInTheDocument();
  });
});
