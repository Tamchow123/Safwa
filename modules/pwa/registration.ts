/**
 * Registering, unregistering and updating the service worker (Phase 18, slice
 * 11).
 *
 * Everything that decides anything is here, pure and injected;
 * `components/pwa/service-worker-provider.tsx` owns nothing but the effects
 * that call it. The same split `components/sync/*-provider.tsx` makes, and for
 * the same reason: a decision inside a `useEffect` can only be tested by
 * rendering a tree and simulating a browser that has service workers, which
 * jsdom does not.
 *
 * The container is a parameter rather than a global read for the same reason
 * `cache-storage.ts` takes a `CacheStorage`: `navigator.serviceWorker` does not
 * exist in Node, in jsdom, or on a page served over plain HTTP.
 */

/**
 * The worker's URL, and the scope it must control.
 *
 * `/serwist/sw.js` is a subpath, which by default would scope the worker to
 * `/serwist/` and leave it controlling nothing. `app/serwist/[path]/route.ts`
 * answers with `Service-Worker-Allowed: /`, which is what permits the wider
 * scope requested here — the two halves only work together, so they are named
 * in each other's comments.
 */
export const SERVICE_WORKER_URL = "/serwist/sw.js";
export const SERVICE_WORKER_SCOPE = "/";

/** The narrow slice of `ServiceWorkerContainer` this module uses. */
export type ServiceWorkerRegistry = {
  register: (
    url: string,
    options?: { scope?: string },
  ) => Promise<ServiceWorkerRegistration>;
  getRegistrations: () => Promise<readonly ServiceWorkerRegistration[]>;
};

/** What this build should do about service workers on load. */
export type ServiceWorkerPolicy = "register" | "unregister" | "unsupported";

/**
 * The whole decision, as one function.
 *
 * `unregister` is not the same as "do nothing", and the difference is the
 * entire point of the kill switch. A service worker survives a deploy: it is
 * installed on the device, not shipped with the page. A build that simply
 * stopped calling `register()` would leave the previous worker installed,
 * controlling every navigation and serving its own caches indefinitely. Turning
 * the switch off has to actively undo it, or `docs/DEPLOYMENT.md` §8's
 * "unregister SW" rollback step is a sentence rather than a mechanism.
 */
export function resolveServiceWorkerPolicy(input: {
  enabled: boolean;
  supported: boolean;
}): ServiceWorkerPolicy {
  if (!input.supported) return "unsupported";
  return input.enabled ? "register" : "unregister";
}

/**
 * Whether a controller change should reload the page.
 *
 * **This is the phase's update strategy, and it is a decision rather than a
 * default.** `sw.ts` sets `skipWaiting` and `clientsClaim`, so a new worker
 * takes over open tabs the moment it activates — and slice 10 measured that
 * every build produces a new worker, because three precache entries carry the
 * build id. So this fires on every deploy, not only on ones that changed
 * something relevant.
 *
 * Without a reload, a tab left open across a deploy runs the OLD build's
 * JavaScript under the NEW worker's precache. The old build's chunks have been
 * deleted by precache cleanup, so the next lazily-loaded route is a cache miss:
 * fine online, and a broken route offline — precisely the guarantee this phase
 * exists to make. Reloading costs at most the current unanswered question:
 * `modules/study-session/persistence.ts` writes each graded attempt, its review
 * event and the replayed scheduling state atomically before the next question
 * renders, so no study progress and no unsynced event lives only in memory.
 *
 * Deferring the reload until the page is hidden was considered and rejected. It
 * costs the learner the same in-flight question, at a moment they cannot see it
 * happen, and on a desktop tab that is never hidden it may never fire at all —
 * turning a bounded, visible interruption into an unbounded, invisible skew.
 *
 * Two guards, both load-bearing:
 *
 * - `hadController` — `controllerchange` ALSO fires the first time a worker
 *   claims a page that had none, which is every first visit. Reloading then
 *   would reload every new visitor once, for nothing.
 * - `alreadyReloading` — the reload is asynchronous, and a second
 *   `controllerchange` before it completes would stack another one. This is the
 *   difference between an update and a reload loop.
 */
export function shouldReloadOnControllerChange(
  state: ControllerChangeState,
): boolean {
  return state.hadController && !state.reloading;
}

/**
 * What the page knows between `controllerchange` events.
 *
 * `hadController` is the answer for the NEXT event, not a fact recorded once at
 * mount — see below.
 */
export type ControllerChangeState = {
  hadController: boolean;
  reloading: boolean;
};

/** The state a page starts in, from the controller it has right now. */
export function initialControllerChangeState(
  hadController: boolean,
): ControllerChangeState {
  return { hadController, reloading: false };
}

/**
 * One `controllerchange`: whether to reload, and what to carry forward.
 *
 * This exists because the state transition is the part that is easy to get
 * wrong, and getting it wrong is silent. The first version of this slice held
 * `hadController` in a `const` captured before `register()` — which suppresses
 * the reload on a page's first-ever controller correctly, and then goes on
 * suppressing every later one for the rest of that page's life. A tab opened
 * for the first time and left open across a deploy would never reload: exactly
 * the stale-JS-under-a-new-precache case the reload was added for, reached by
 * the guard meant to prevent a different problem.
 *
 * `hadController` therefore becomes true after ANY controller change, because
 * by definition the page now has one. It cannot be recomputed from
 * `container.controller` inside the handler either — by the time the event
 * fires, that has already flipped to the new worker, so the prior state has to
 * be remembered rather than re-read.
 */
export function advanceControllerChange(state: ControllerChangeState): {
  reload: boolean;
  next: ControllerChangeState;
} {
  const reload = shouldReloadOnControllerChange(state);
  return {
    reload,
    next: { hadController: true, reloading: state.reloading || reload },
  };
}

/**
 * Register the worker.
 *
 * Total: a registration failure must not propagate. Registration fails for
 * ordinary, uninteresting reasons — a private window, a blocked-storage
 * profile, an origin without TLS — and every one of them leaves an app that
 * works, just without offline support. Throwing out of an effect over that
 * would take the page down with it.
 *
 * The warning is the only trace the failure leaves, and it is deliberate: a
 * deploy that broke the worker route would otherwise present as "offline mode
 * quietly stopped working" with nothing to search for. Nothing here carries
 * user or account data.
 */
export async function registerServiceWorker(
  registry: ServiceWorkerRegistry,
): Promise<boolean> {
  try {
    await registry.register(SERVICE_WORKER_URL, {
      scope: SERVICE_WORKER_SCOPE,
    });
    return true;
  } catch (error) {
    console.warn("[safwa-pwa] service worker registration failed", error);
    return false;
  }
}

/**
 * Unregister every worker registered for this origin — not only the one this
 * build knows about.
 *
 * `getRegistrations()` rather than `getRegistration(SERVICE_WORKER_SCOPE)`
 * because the kill switch has to be able to undo a worker this build has no
 * knowledge of: a previous deploy's, or one registered at a different scope by
 * a version of this code that has since been replaced. The rollback exists for
 * the case where something unexpected is installed, so it must not depend on
 * the installed thing matching today's constants.
 *
 * Returns how many were actually removed, so "there was nothing to unregister"
 * and "unregistering failed" cannot look the same to a caller or a test.
 */
export async function unregisterServiceWorkers(
  registry: ServiceWorkerRegistry,
): Promise<number> {
  try {
    const registrations = await registry.getRegistrations();
    // In parallel, not in a sequential `for await`. One registration refusing
    // to go must not strand the others — and a registration that never settles
    // at all, which is the sort of anomaly this rollback exists for, must not
    // stop the rest from even being attempted.
    const results = await Promise.allSettled(
      registrations.map(async (registration) => registration.unregister()),
    );
    return results.filter(
      (result) => result.status === "fulfilled" && result.value === true,
    ).length;
  } catch (error) {
    console.warn("[safwa-pwa] could not enumerate service workers", error);
    return 0;
  }
}
