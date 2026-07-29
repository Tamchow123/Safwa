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

  describe("isStopped — can this instance still act?", () => {
    // The provider offers a manual retry and has to choose between calling this
    // controller again and replacing it. `attention` cannot answer that: it
    // covers a recoverable failure, a dead-letter backlog AND the permanent
    // stop alike. Replacing a controller that could still act would discard its
    // accurate counts for a fresh instance's zeroes (R2-F6), so the distinction
    // has to come from here.
    it("is false for a fresh controller", () => {
      expect(createSyncController(makeDeps()).isStopped()).toBe(false);
    });

    it("is true after an auth_lost outcome, which no reason gets past", async () => {
      const deps = makeDeps({
        run: vi.fn(async () => ({ outcome: "auth_lost" }) as SyncRunResult),
      });
      const controller = createSyncController(deps);

      await controller.sync("bootstrap");

      expect(controller.isStopped()).toBe(true);
      // Not merely "automatic runs": an explicitly manual one is refused too,
      // which is exactly why only a rebuild can recover this state.
      expect(await controller.sync("manual")).toBeNull();
      expect(deps.run).toHaveBeenCalledTimes(1);
    });

    it("is true after an invalidated outcome", async () => {
      const controller = createSyncController(
        makeDeps({
          run: vi.fn(async () => ({ outcome: "invalidated" }) as SyncRunResult),
        }),
      );

      await controller.sync("periodic");

      expect(controller.isStopped()).toBe(true);
    });

    it("stays false for a recoverable failure that reports attention", async () => {
      const controller = createSyncController(
        makeDeps({
          run: vi.fn(async () => ({ outcome: "retry" }) as SyncRunResult),
        }),
      );

      await controller.sync("periodic");

      expect(controller.getStatus().kind).toBe("attention");
      expect(controller.isStopped()).toBe(false);
    });

    it("stays false for a dead-letter backlog that reports attention", async () => {
      const controller = createSyncController(
        makeDeps({ countDeadLetter: vi.fn(async () => 2) }),
      );

      await controller.sync("bootstrap");

      // A successful run, so nothing is backed off — but the permanent
      // rejections still force the honest attention state.
      expect(controller.getStatus().kind).toBe("attention");
      expect(controller.isStopped()).toBe(false);
    });

    it("stays false when a disabled server backs the controller off", async () => {
      // `disabled` is a separate lever from `stopped`: the server said there is
      // nothing to do, not that this instance is broken. A rebuild would change
      // nothing, so the provider must not be told to attempt one.
      const controller = createSyncController(
        makeDeps({
          run: vi.fn(async () => ({ outcome: "disabled" }) as SyncRunResult),
        }),
      );

      await controller.sync("bootstrap");

      expect(controller.getStatus().kind).toBe("disabled");
      expect(controller.isStopped()).toBe(false);
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

  describe("dead-letter surfacing (R2-F6)", () => {
    it("forces attention when a mutation has dead-lettered, even after a synced run", async () => {
      const deps = makeDeps({ countDeadLetter: vi.fn(async () => 1) });
      const controller = createSyncController(deps);

      await controller.sync("bootstrap"); // outcome synced, 0 pending
      // A permanent, non-recoverable failure must never read as `synced` (§20).
      expect(controller.getStatus().kind).toBe("attention");
    });

    it("does not count a dead-letter as pending backlog", async () => {
      const deps = makeDeps({
        countPending: vi.fn(async () => 0),
        countDeadLetter: vi.fn(async () => 2),
      });
      const controller = createSyncController(deps);

      await controller.sync("bootstrap");
      const status = controller.getStatus();
      expect(status.kind).toBe("attention");
      expect(status.pendingCount).toBe(0); // dead rows are not "pending N"
    });

    it("reports synced when there is no dead-letter and nothing pending", async () => {
      const deps = makeDeps({ countDeadLetter: vi.fn(async () => 0) });
      const controller = createSyncController(deps);

      await controller.sync("bootstrap");
      expect(controller.getStatus().kind).toBe("synced");
    });

    it("keeps the last known dead-letter count when its query throws", async () => {
      const countDeadLetter = vi
        .fn<() => Promise<number>>()
        .mockResolvedValueOnce(1)
        .mockRejectedValueOnce(new Error("dexie down"));
      const deps = makeDeps({ countDeadLetter });
      const controller = createSyncController(deps);

      await controller.refreshPending();
      expect(controller.getStatus().kind).toBe("attention");

      await controller.refreshPending(); // throws internally, swallowed
      expect(controller.getStatus().kind).toBe("attention"); // last known kept
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
