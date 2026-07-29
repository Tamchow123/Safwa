"use client";

/**
 * Phase 18, slice 11 — the effects that act on `modules/pwa/registration.ts`.
 *
 * Mounted in `app/layout.tsx` rather than the shell layout, deliberately: the
 * `(auth)` route group is outside the shell, and a learner who lands on
 * `/sign-in` first would otherwise reach the app with no worker registered
 * until their next navigation. Renders nothing.
 *
 * Nothing decided here. Whether to register, whether to reload, and what to
 * clear are all answered by the module, which is testable; this file exists
 * because effects are not.
 */
import { useEffect } from "react";

import { clientEnv } from "@/modules/env/client";
import { clearAllAppCachesIfAvailable } from "@/modules/pwa/cache-storage";
import {
  advanceControllerChange,
  initialControllerChangeState,
  registerServiceWorker,
  resolveServiceWorkerPolicy,
  unregisterServiceWorkers,
} from "@/modules/pwa/registration";

export function ServiceWorkerProvider() {
  useEffect(() => {
    const policy = resolveServiceWorkerPolicy({
      enabled: clientEnv.serviceWorkerEnabled,
      supported:
        typeof navigator !== "undefined" && "serviceWorker" in navigator,
    });

    if (policy === "unsupported") return;

    // Captured once, and used for everything below including the cleanup. The
    // teardown has to unsubscribe from the SAME container this effect
    // subscribed to; re-reading the global there would reopen the "is there
    // one at all" question at the least convenient moment.
    const container = navigator.serviceWorker;

    if (policy === "unregister") {
      // Both halves, and DELIBERATELY NOT CHAINED — the same call
      // `components/account/deleted-account-cleanup.tsx` makes for the same
      // reason. They touch different stores, so neither depends on the other,
      // and sequencing them would mean an unregistration that hangs rather than
      // rejects silently takes the cache sweep with it. Neither can reject.
      void unregisterServiceWorkers(container);
      void clearAllAppCachesIfAvailable();
      return;
    }

    // Read BEFORE registering. `controllerchange` fires when a worker claims a
    // page that had none — every first visit — and the reload guard needs to
    // know which of those two it is looking at.
    //
    // Carried in a mutable binding and advanced by the module on every event.
    // A value captured once here would suppress the reload for the whole life
    // of a page that started uncontrolled, which is the bug
    // `advanceControllerChange` documents.
    let state = initialControllerChangeState(container.controller !== null);

    const onControllerChange = () => {
      const { reload, next } = advanceControllerChange(state);
      state = next;
      if (reload) window.location.reload();
    };

    // Subscribed before registering, not after: `register()` can resolve into
    // an immediate activation, and a listener attached afterwards would miss
    // the very event it exists for.
    container.addEventListener("controllerchange", onControllerChange);
    void registerServiceWorker(container);

    return () => {
      container.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  return null;
}
