import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The provider's wiring. The decisions it applies are unit-tested in
 * `modules/pwa/registration.test.ts`; what can only be proved here is that the
 * right branch runs against the real `navigator.serviceWorker`, that the kill
 * switch does BOTH halves, and that the reload listener is attached before
 * registration rather than after.
 *
 * That ordering is not a style point. `register()` can resolve into an
 * immediate activation, and a listener added afterwards would miss the
 * `controllerchange` it exists for.
 */
const enabled = vi.hoisted(() => ({ value: true }));
vi.mock("@/modules/env/client", () => ({
  clientEnv: {
    appUrl: undefined,
    get serviceWorkerEnabled() {
      return enabled.value;
    },
  },
}));

const clearAllAppCachesIfAvailableMock = vi.fn(async () => [] as string[]);
vi.mock("@/modules/pwa/cache-storage", () => ({
  clearAllAppCachesIfAvailable: () => clearAllAppCachesIfAvailableMock(),
}));

import { ServiceWorkerProvider } from "@/components/pwa/service-worker-provider";
import {
  SERVICE_WORKER_SCOPE,
  SERVICE_WORKER_URL,
} from "@/modules/pwa/registration";

type Listener = (event: Event) => void;

function installFakeContainer(options: {
  controller?: object | null;
  registrations?: ServiceWorkerRegistration[];
}) {
  const listeners = new Map<string, Set<Listener>>();
  const register = vi.fn(async () => ({}) as ServiceWorkerRegistration);
  const unregister = vi.fn(async () => true);

  const container = {
    controller: options.controller ?? null,
    register,
    getRegistrations: async () =>
      options.registrations ??
      ([{ unregister }] as unknown as ServiceWorkerRegistration[]),
    addEventListener: (type: string, listener: Listener) => {
      const set = listeners.get(type) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: Listener) => {
      listeners.get(type)?.delete(listener);
    },
  };

  Object.defineProperty(window.navigator, "serviceWorker", {
    value: container,
    configurable: true,
  });

  return {
    register,
    unregister,
    listenerCount: (type: string) => listeners.get(type)?.size ?? 0,
    emit: (type: string) => {
      for (const listener of [...(listeners.get(type) ?? [])])
        listener(new Event(type));
    },
  };
}

function removeServiceWorkerSupport(): void {
  Reflect.deleteProperty(window.navigator, "serviceWorker");
}

const reload = vi.fn();
const originalLocation = Object.getOwnPropertyDescriptor(window, "location");

beforeEach(() => {
  enabled.value = true;
  reload.mockClear();
  clearAllAppCachesIfAvailableMock.mockClear();
  // Reinstated per test rather than torn down afterwards: Testing Library's
  // auto-cleanup unmounts in its own `afterEach`, so removing the container in
  // ours would pull it out from under a still-mounted component.
  removeServiceWorkerSupport();
  Object.defineProperty(window, "location", {
    value: { ...window.location, reload },
    configurable: true,
  });
});

afterEach(() => {
  if (originalLocation)
    Object.defineProperty(window, "location", originalLocation);
  vi.restoreAllMocks();
});

describe("the service-worker provider", () => {
  it("renders nothing", () => {
    installFakeContainer({});
    const { container } = render(<ServiceWorkerProvider />);
    expect(container).toBeEmptyDOMElement();
  });

  it("registers at root scope when enabled", async () => {
    const fake = installFakeContainer({});
    render(<ServiceWorkerProvider />);
    await waitFor(() =>
      expect(fake.register).toHaveBeenCalledWith(SERVICE_WORKER_URL, {
        scope: SERVICE_WORKER_SCOPE,
      }),
    );
  });

  it("listens for a controller change BEFORE registering", () => {
    // register() can resolve into an immediate activation; a listener attached
    // afterwards would miss the very event it exists for.
    const fake = installFakeContainer({});
    let listenersWhenRegistered = -1;
    fake.register.mockImplementation(async () => {
      listenersWhenRegistered = fake.listenerCount("controllerchange");
      return {} as ServiceWorkerRegistration;
    });
    render(<ServiceWorkerProvider />);
    expect(listenersWhenRegistered).toBe(1);
  });

  it("reloads when a new worker takes over a page that had one", async () => {
    const fake = installFakeContainer({ controller: {} });
    render(<ServiceWorkerProvider />);
    fake.emit("controllerchange");
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it("does not reload on the first worker a page ever gets", async () => {
    const fake = installFakeContainer({ controller: null });
    render(<ServiceWorkerProvider />);
    fake.emit("controllerchange");
    await waitFor(() => expect(fake.register).toHaveBeenCalled());
    expect(reload).not.toHaveBeenCalled();
  });

  it("DOES reload when that same page is later claimed by an update", async () => {
    // The tab that matters: opened for the first time, kept open across a
    // deploy. Suppressing the first controller change is correct; carrying that
    // suppression forward would leave this page running the old build's JS
    // under the new worker's precache for the rest of its life.
    const fake = installFakeContainer({ controller: null });
    render(<ServiceWorkerProvider />);
    fake.emit("controllerchange");
    expect(reload).not.toHaveBeenCalled();
    fake.emit("controllerchange");
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it("reloads once, not once per event", async () => {
    const fake = installFakeContainer({ controller: {} });
    render(<ServiceWorkerProvider />);
    fake.emit("controllerchange");
    fake.emit("controllerchange");
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("stops listening when unmounted", () => {
    const fake = installFakeContainer({ controller: {} });
    const { unmount } = render(<ServiceWorkerProvider />);
    expect(fake.listenerCount("controllerchange")).toBe(1);
    unmount();
    expect(fake.listenerCount("controllerchange")).toBe(0);
  });

  it("unregisters AND clears the caches when the switch is off", async () => {
    // Both halves. Unregistering stops the worker intercepting; only the sweep
    // removes what it already stored, and Cache Storage belongs to the origin
    // rather than to the registration, so nothing about unregistering touches
    // it.
    enabled.value = false;
    const fake = installFakeContainer({});
    render(<ServiceWorkerProvider />);
    await waitFor(() => expect(fake.unregister).toHaveBeenCalled());
    await waitFor(() =>
      expect(clearAllAppCachesIfAvailableMock).toHaveBeenCalled(),
    );
    expect(fake.register).not.toHaveBeenCalled();
  });

  it("clears the caches even if unregistration never finishes", async () => {
    // The two halves are deliberately not chained. They touch different stores,
    // so neither depends on the other — and an unregistration that HANGS rather
    // than rejects would otherwise take the cache sweep down with it silently,
    // leaving a rollback half done with nothing logged.
    enabled.value = false;
    installFakeContainer({
      registrations: [
        { unregister: () => new Promise<boolean>(() => {}) },
      ] as unknown as ServiceWorkerRegistration[],
    });
    render(<ServiceWorkerProvider />);
    await waitFor(() =>
      expect(clearAllAppCachesIfAvailableMock).toHaveBeenCalled(),
    );
  });

  it("does nothing where the browser has no service workers", () => {
    // Not "unregister": there is nothing to unregister, and calling into an
    // absent API to find that out would throw inside an effect.
    removeServiceWorkerSupport();
    expect(() => render(<ServiceWorkerProvider />)).not.toThrow();
    expect(clearAllAppCachesIfAvailableMock).not.toHaveBeenCalled();
  });
});
