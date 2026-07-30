import type { Page } from "@playwright/test";

/**
 * Service-worker probes for the offline suite (Phase 18, slice 12).
 *
 * Every function here does its real work inside `page.evaluate`, so its body
 * cannot import app code — the same constraint `idb.ts` documents. That is why
 * each takes the cache name as an argument rather than reaching for
 * `CACHE_NAMES`: the specs, which run in Node, import that themselves and pass
 * it in, so nothing here restates a name the worker owns.
 *
 * Note on WebKit: `browserContext.serviceWorkers()` is Chromium-only and
 * returns `[]` on WebKit even when a worker is registered and controlling the
 * page. Everything here is therefore written as an in-page check against
 * `navigator.serviceWorker` / `caches`, which behaves identically on both
 * engines — measured, and the reason the installability criteria can be
 * asserted on WebKit at all.
 */

/**
 * Wait until a worker is not merely registered but **controlling this page**.
 *
 * The distinction is the whole test. `navigator.serviceWorker.ready` resolves
 * once a worker is active, which can happen a beat before it claims the page —
 * and an uncontrolled page still goes to the network, so a spec that went
 * offline on `ready` alone would be testing nothing and failing for the wrong
 * reason.
 */
export async function waitForServiceWorkerControl(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      "serviceWorker" in navigator &&
      navigator.serviceWorker.controller !== null,
    undefined,
    { timeout: 30_000 },
  );
}

/** How many workers are registered for this origin. */
export function serviceWorkerRegistrationCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return 0;
    const registrations = await navigator.serviceWorker.getRegistrations();
    return registrations.length;
  });
}

/**
 * The URLs stored in one named cache, or `[]` if it does not exist.
 *
 * The offline specs need this because "the worker is controlling" and "the
 * worker has cached the page I am about to ask for offline" are different
 * facts, and only the second one makes an offline assertion meaningful. Without
 * it, an offline test that fails because nothing was ever cached looks
 * identical to one that fails because the fallback is broken.
 */
export function cachedUrls(page: Page, cacheName: string): Promise<string[]> {
  return page.evaluate(async (name) => {
    if (typeof caches === "undefined") return [];
    if (!(await caches.has(name))) return [];
    const cache = await caches.open(name);
    return (await cache.keys()).map((request) => request.url);
  }, cacheName);
}

/**
 * Wait until at least one cache whose name starts with `safwa-` exists.
 *
 * The runtime caches are written lazily, by the first request each rule
 * matches — so "the worker is controlling" and "the worker has cached anything"
 * are different moments, and going offline between them is a flake.
 */
export async function waitForRuntimeCaches(page: Page): Promise<void> {
  await page.waitForFunction(
    async () => {
      if (typeof caches === "undefined") return false;
      const names = await caches.keys();
      return names.some((name) => name.startsWith("safwa-"));
    },
    undefined,
    { timeout: 30_000 },
  );
}
