import { describe, expect, it, vi } from "vitest";

import type { SafwaDb } from "@/modules/content/db";

import { createSyncController, type SyncControllerDeps } from "./controller";
import type { SyncRunResult } from "./orchestrator";

// countPending and run are injected, so no real Dexie/network is needed.
const fakeDb = {} as SafwaDb;

function makeDeps(
  overrides: Partial<SyncControllerDeps> = {},
): SyncControllerDeps & {
  run: ReturnType<typeof vi.fn>;
  countPending: ReturnType<typeof vi.fn>;
} {
  const run = vi.fn(async (): Promise<SyncRunResult> => ({
    outcome: "synced",
  }));
  const countPending = vi.fn(async () => 0);
  return {
    db: fakeDb,
    userId: "user-1",
    deviceId: "dev-1",
    now: () => 1000,
    online: () => true,
    isCurrentAccount: () => true,
    countPending,
    run,
    running: () => false,
    ...overrides,
  } as SyncControllerDeps & {
    run: ReturnType<typeof vi.fn>;
    countPending: ReturnType<typeof vi.fn>;
  };
}

describe("createSyncController", () => {
  describe("guest gate — guests never call the server", () => {
    it("no-ops for a null user id and reports guest status", async () => {
      const deps = makeDeps({ userId: null });
      const controller = createSyncController(deps);

      const result = await controller.sync("bootstrap");

      expect(result).toBeNull();
      expect(deps.run).not.toHaveBeenCalled();
      expect(controller.getStatus().kind).toBe("guest");
    });
  });

  describe("offline gate", () => {
    it("does not call the server when offline and reports offline", async () => {
      const deps = makeDeps({ online: () => false });
      const controller = createSyncController(deps);

      const result = await controller.sync("periodic");

      expect(result).toBeNull();
      expect(deps.run).not.toHaveBeenCalled();
      expect(controller.getStatus().kind).toBe("offline");
    });
  });

  describe("run delegation", () => {
    it("passes the account/device context and injected clock to runSync", async () => {
      const isCurrentAccount = vi.fn(() => true);
      const deps = makeDeps({ now: () => 4242, isCurrentAccount });
      const controller = createSyncController(deps);

      await controller.sync("manual");

      expect(deps.run).toHaveBeenCalledTimes(1);
      const passed = deps.run.mock.calls[0]![0];
      expect(passed.userId).toBe("user-1");
      expect(passed.deviceId).toBe("dev-1");
      expect(passed.now()).toBe(4242);
      expect(passed.isCurrentAccount).toBe(isCurrentAccount);
    });
  });

  describe("outcome folding → status", () => {
    it("a synced run with no pending reports synced and clears attention", async () => {
      const run = vi
        .fn<() => Promise<SyncRunResult>>()
        .mockResolvedValueOnce({ outcome: "retry" })
        .mockResolvedValueOnce({ outcome: "synced" });
      const deps = makeDeps({ run });
      const controller = createSyncController(deps);

      await controller.sync("manual");
      expect(controller.getStatus().kind).toBe("attention");

      await controller.sync("manual");
      expect(controller.getStatus().kind).toBe("synced");
    });

    it("a retry outcome raises attention", async () => {
      const deps = makeDeps({
        run: vi.fn(async () => ({ outcome: "retry" }) as SyncRunResult),
      });
      const controller = createSyncController(deps);

      await controller.sync("periodic");

      expect(controller.getStatus().kind).toBe("attention");
    });

    it("surfaces the pending count after a run", async () => {
      const deps = makeDeps({ countPending: vi.fn(async () => 3) });
      const controller = createSyncController(deps);

      await controller.sync("bootstrap");

      const status = controller.getStatus();
      expect(status.kind).toBe("pending");
      expect(status.pendingCount).toBe(3);
    });
  });

  describe("disabled back-off", () => {
    it("stops calling the server after a disabled outcome", async () => {
      const deps = makeDeps({
        run: vi.fn(async () => ({ outcome: "disabled" }) as SyncRunResult),
      });
      const controller = createSyncController(deps);

      await controller.sync("bootstrap");
      expect(controller.getStatus().kind).toBe("disabled");

      const second = await controller.sync("periodic");
      expect(second).toBeNull();
      expect(deps.run).toHaveBeenCalledTimes(1); // no second call
    });
  });

  describe("auth-lost back-off", () => {
    it("stops automatic runs AND surfaces attention after an auth_lost outcome", async () => {
      const deps = makeDeps({
        run: vi.fn(async () => ({ outcome: "auth_lost" }) as SyncRunResult),
      });
      const controller = createSyncController(deps);

      await controller.sync("bootstrap");
      // Honest status: never silently `synced`/`pending` after the session is
      // lost — the indicator shows an actionable state (re-auth needed).
      expect(controller.getStatus().kind).toBe("attention");

      const second = await controller.sync("periodic");
      expect(second).toBeNull();
      expect(deps.run).toHaveBeenCalledTimes(1);
    });
  });

  describe("invalidated back-off", () => {
    it("stops further runs after an invalidated (account-switch) outcome", async () => {
      const deps = makeDeps({
        run: vi.fn(async () => ({ outcome: "invalidated" }) as SyncRunResult),
      });
      const controller = createSyncController(deps);

      await controller.sync("periodic");
      const second = await controller.sync("visible");

      expect(second).toBeNull();
      expect(deps.run).toHaveBeenCalledTimes(1);
    });
  });

  describe("in-flight status", () => {
    it("announces syncing at the START of a run, before it settles", async () => {
      // A run that stays pending until we resolve it — modelling a slow pull.
      let resolveRun: (r: SyncRunResult) => void = () => {};
      const runPromise = new Promise<SyncRunResult>((resolve) => {
        resolveRun = resolve;
      });
      const deps = makeDeps({ run: vi.fn(() => runPromise) });
      const controller = createSyncController(deps);
      const seen: string[] = [];
      controller.subscribe((s) => seen.push(s.kind));

      const pending = controller.sync("manual");
      // The FIRST notification the subscriber receives — emitted before the run
      // settles — already reads `syncing` (runningNow raised before awaiting).
      expect(seen[0]).toBe("syncing");

      resolveRun({ outcome: "synced" });
      await pending;
      // ...and it settles back to `synced` once the run resolves.
      expect(controller.getStatus().kind).toBe("synced");
    });
  });

  describe("subscribe/unsubscribe", () => {
    it("notifies subscribers and stops after unsubscribe", async () => {
      const deps = makeDeps();
      const controller = createSyncController(deps);
      const listener = vi.fn();
      const unsubscribe = controller.subscribe(listener);

      await controller.refreshPending();
      expect(listener).toHaveBeenCalled();

      listener.mockClear();
      unsubscribe();
      await controller.refreshPending();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("refreshPending resilience", () => {
    it("keeps the last known count when the count query throws", async () => {
      const countPending = vi
        .fn<() => Promise<number>>()
        .mockResolvedValueOnce(5)
        .mockRejectedValueOnce(new Error("dexie down"));
      const deps = makeDeps({ countPending });
      const controller = createSyncController(deps);

      await controller.refreshPending();
      expect(controller.getStatus().pendingCount).toBe(5);

      await controller.refreshPending(); // throws internally, swallowed
      expect(controller.getStatus().pendingCount).toBe(5);
    });
  });
});
