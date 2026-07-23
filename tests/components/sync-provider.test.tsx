import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RunSyncDeps } from "@/modules/sync/client/orchestrator";

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

let capturedListener: ((status: unknown) => void) | null = null;
let capturedDeps: RunSyncDeps | null = null;
const controllerSync = vi.fn(async () => null);
const controllerUnsub = vi.fn();
const createSyncControllerMock = vi.fn((deps: RunSyncDeps) => {
  capturedDeps = deps;
  return {
    sync: controllerSync,
    subscribe: (fn: (status: unknown) => void) => {
      capturedListener = fn;
      return controllerUnsub;
    },
    getStatus: () => ({ kind: "synced", pendingCount: 0 }),
    refreshPending: vi.fn(),
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

const SIGNED_IN = {
  data: { user: { id: "user-1", email: "a@b.co" } },
  isPending: false,
  error: null,
};

beforeEach(() => {
  sessionState = { data: null, isPending: false, error: null };
  capturedListener = null;
  capturedDeps = null;
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

    // The attention-state retry must actually recover: re-mint, build the
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
