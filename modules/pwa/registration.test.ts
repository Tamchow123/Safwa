import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  advanceControllerChange,
  initialControllerChangeState,
  registerServiceWorker,
  resolveServiceWorkerPolicy,
  SERVICE_WORKER_SCOPE,
  SERVICE_WORKER_URL,
  shouldReloadOnControllerChange,
  unregisterServiceWorkers,
  type ControllerChangeState,
  type ServiceWorkerRegistry,
} from "@/modules/pwa/registration";

/**
 * The registration policy and the two operations it selects between.
 *
 * Both operations are total by contract — they run in an effect where a
 * rejection would take the page down — so most of what is asserted here is what
 * happens when the browser refuses, which is the half a happy-path test never
 * reaches.
 */
beforeEach(() => {
  // Three tests below deliberately fail an operation, and each logs a warning
  // that is the point of the code rather than noise to be silenced everywhere
  // else. Spying keeps the suite's output clean without hiding the assertion.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const registration = (
  unregister: () => Promise<boolean>,
): ServiceWorkerRegistration => ({ unregister }) as ServiceWorkerRegistration;

describe("what a build should do about service workers", () => {
  it("registers when enabled and supported", () => {
    expect(resolveServiceWorkerPolicy({ enabled: true, supported: true })).toBe(
      "register",
    );
  });

  it("UNREGISTERS when disabled, rather than doing nothing", () => {
    // The whole substance of the kill switch. A worker is installed on the
    // device, not shipped with the page: a build that merely stopped calling
    // register() would leave the previous one in control forever, and
    // DEPLOYMENT.md §8's rollback step would be a sentence rather than a
    // mechanism.
    expect(
      resolveServiceWorkerPolicy({ enabled: false, supported: true }),
    ).toBe("unregister");
  });

  it("does nothing at all where service workers do not exist", () => {
    // Not "unregister": there is nothing to unregister, and calling into an
    // absent API to find that out would throw.
    expect(
      resolveServiceWorkerPolicy({ enabled: false, supported: false }),
    ).toBe("unsupported");
    expect(
      resolveServiceWorkerPolicy({ enabled: true, supported: false }),
    ).toBe("unsupported");
  });
});

describe("whether a controller change should reload the page", () => {
  it("reloads when a NEW worker takes over a controlled page", () => {
    // The update strategy. sw.ts sets skipWaiting + clientsClaim and every
    // build produces a new worker, so without this a tab left open across a
    // deploy runs the old build's JS under the new worker's precache — a cache
    // miss on the next lazily-loaded route, which offline is a broken route.
    expect(
      shouldReloadOnControllerChange({
        hadController: true,
        reloading: false,
      }),
    ).toBe(true);
  });

  it("does NOT reload on the first worker a page ever gets", () => {
    // controllerchange also fires when a worker claims a page that had none,
    // which is every first visit. Reloading then would reload every new
    // visitor once, for nothing.
    expect(
      shouldReloadOnControllerChange({
        hadController: false,
        reloading: false,
      }),
    ).toBe(false);
  });

  it("does not stack a second reload on top of one already running", () => {
    // The reload is asynchronous. Without this guard a second controllerchange
    // before it completes is the difference between an update and a loop.
    expect(
      shouldReloadOnControllerChange({
        hadController: true,
        reloading: true,
      }),
    ).toBe(false);
  });
});

describe("the state a page carries between controller changes", () => {
  const advanceAll = (
    start: ControllerChangeState,
    events: number,
  ): boolean[] => {
    let state = start;
    const reloads: boolean[] = [];
    for (let index = 0; index < events; index += 1) {
      const result = advanceControllerChange(state);
      state = result.next;
      reloads.push(result.reload);
    }
    return reloads;
  };

  it("suppresses only the FIRST controller change, not every later one", () => {
    // The bug this function exists to prevent, and it is silent: holding
    // `hadController` at its mount-time value suppresses the first change
    // correctly and then goes on suppressing every later one for the whole life
    // of the page. A tab opened for the first time and left open across a
    // deploy would never reload — the exact stale-JS-under-a-new-precache case
    // the reload was added for, reached through the guard for a different one.
    expect(advanceAll(initialControllerChangeState(false), 2)).toEqual([
      false,
      true,
    ]);
  });

  it("reloads a returning visitor on the very first change", () => {
    expect(advanceAll(initialControllerChangeState(true), 1)).toEqual([true]);
  });

  it("reloads at most once, however many events arrive", () => {
    // The reload is asynchronous, so more events can land before the page goes.
    expect(advanceAll(initialControllerChangeState(true), 4)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(advanceAll(initialControllerChangeState(false), 4)).toEqual([
      false,
      true,
      false,
      false,
    ]);
  });

  it("records that the page now has a controller, whatever it decided", () => {
    // Not recomputed from `container.controller` in the handler: by the time
    // the event fires that has already flipped to the new worker, so the prior
    // state must be remembered rather than re-read.
    expect(
      advanceControllerChange(initialControllerChangeState(false)).next,
    ).toEqual({ hadController: true, reloading: false });
    expect(
      advanceControllerChange(initialControllerChangeState(true)).next,
    ).toEqual({ hadController: true, reloading: true });
  });

  it("does not mutate the state it was given", () => {
    const state = initialControllerChangeState(false);
    advanceControllerChange(state);
    expect(state).toEqual({ hadController: false, reloading: false });
  });
});

describe("registering", () => {
  it("asks for root scope, which the worker's own header is what permits", () => {
    const register = vi.fn(async () => registration(async () => true));
    return registerServiceWorker({
      register,
      getRegistrations: async () => [],
    }).then((ok) => {
      expect(ok).toBe(true);
      // The URL is a subpath, so without an explicit scope the worker would
      // control /serwist/ and nothing else. app/serwist/[path]/route.ts answers
      // with Service-Worker-Allowed: / — the two only work together.
      expect(register).toHaveBeenCalledWith(SERVICE_WORKER_URL, {
        scope: SERVICE_WORKER_SCOPE,
      });
      expect(SERVICE_WORKER_SCOPE).toBe("/");
    });
  });

  it("reports failure instead of propagating it", async () => {
    // A private window, a blocked-storage profile or a plain-HTTP origin all
    // reject here, and every one of them leaves an app that works — just
    // without offline support. Throwing out of the effect would take the page.
    const registry: ServiceWorkerRegistry = {
      register: async () => {
        throw new Error("insecure context");
      },
      getRegistrations: async () => [],
    };
    await expect(registerServiceWorker(registry)).resolves.toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe("unregistering — the kill switch's first half", () => {
  it("removes every registration, not only the one this build knows about", async () => {
    // getRegistrations() rather than getRegistration(scope): the rollback
    // exists for the case where something unexpected is installed, so it must
    // not depend on the installed thing matching today's constants.
    const registry: ServiceWorkerRegistry = {
      register: async () => registration(async () => true),
      getRegistrations: async () => [
        registration(async () => true),
        registration(async () => true),
      ],
    };
    await expect(unregisterServiceWorkers(registry)).resolves.toBe(2);
  });

  it("distinguishes nothing to remove from failing to remove", async () => {
    const registry: ServiceWorkerRegistry = {
      register: async () => registration(async () => true),
      getRegistrations: async () => [],
    };
    await expect(unregisterServiceWorkers(registry)).resolves.toBe(0);
  });

  it("keeps going when one registration refuses", async () => {
    const registry: ServiceWorkerRegistry = {
      register: async () => registration(async () => true),
      getRegistrations: async () => [
        registration(async () => {
          throw new Error("nope");
        }),
        registration(async () => true),
      ],
    };
    // One stubborn registration must not strand the others — a half-completed
    // rollback is the state hardest to reason about afterwards.
    await expect(unregisterServiceWorkers(registry)).resolves.toBe(1);
  });

  it("attempts every registration even when one never settles", async () => {
    // The anomaly this rollback exists for. A sequential `for await` would stop
    // at the stuck one and never reach its siblings; nothing would reject, so
    // nothing would be logged either.
    const attempted: string[] = [];
    const registry: ServiceWorkerRegistry = {
      register: async () => registration(async () => true),
      getRegistrations: async () => [
        registration(() => {
          attempted.push("stuck");
          return new Promise<boolean>(() => {});
        }),
        registration(async () => {
          attempted.push("second");
          return true;
        }),
      ],
    };
    // The call itself cannot resolve while one registration hangs — that is the
    // browser's to answer, not ours. What matters is that the second was still
    // attempted, which is why the provider no longer waits on this to run the
    // cache sweep.
    void unregisterServiceWorkers(registry);
    await vi.waitFor(() => expect(attempted).toEqual(["stuck", "second"]));
  });

  it("survives a container that cannot enumerate at all", async () => {
    const registry: ServiceWorkerRegistry = {
      register: async () => registration(async () => true),
      getRegistrations: async () => {
        throw new Error("storage blocked");
      },
    };
    await expect(unregisterServiceWorkers(registry)).resolves.toBe(0);
    expect(console.warn).toHaveBeenCalled();
  });
});
