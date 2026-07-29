/**
 * The Cache Storage operations the service worker and the app both need
 * (Phase 18, slice 10).
 *
 * The warm and the read take a `CacheStorage` rather than reaching for the
 * global `caches`, for two reasons. It is the only way to unit-test them —
 * Vitest has no Cache Storage — and they run in the WORKER while the sweep runs
 * on the PAGE, so a module that assumed one global would be wrong half the
 * time. `clearOwnerSensitiveCachesIfAvailable` is the exception and reads the
 * global deliberately: its callers are UI code that should not have to know
 * whether this environment has Cache Storage at all.
 *
 * `CacheStorage` is declared identically by `lib.dom` and `lib.webworker`, so
 * this file compiles in the root program and is still importable from
 * `sw.ts`, which is checked by `tsconfig.sw.json`.
 */
import {
  CACHE_NAMES,
  OFFLINE_FALLBACK_URL,
  OWNER_SENSITIVE_CACHE_NAMES,
} from "@/modules/pwa/cache-rules";

/**
 * The offline page's absolute URL, resolved once so the warm and the read
 * cannot disagree about what was stored.
 */
function offlineFallbackUrl(base: string): string {
  return new URL(OFFLINE_FALLBACK_URL, base).toString();
}

/**
 * Put the offline page in the cache at install time, so it is there for a
 * navigation to a route the learner has never visited.
 *
 * **Why this is not an `additionalPrecacheEntries` entry.** A precache entry
 * needs a revision, and a string entry gets `revision: null` — fetched once,
 * then never again (`@serwist/build` warns about exactly this). `/~offline` is
 * a Next page whose HTML references content-hashed chunks, so a copy pinned
 * forever would eventually point at chunks a later precache cleanup had
 * deleted: an offline page that itself fails offline. There is no build-stable
 * revision available where the worker is configured.
 *
 * Warming at install has the property the revision would have bought, and
 * measurement showed it more bluntly than expected. Three precache entries are
 * `/_next/static/<build id>/_buildManifest.js` and friends, and Next generates
 * a new build id every build — so the worker's bytes change on EVERY build,
 * not only on ones that touch an asset. Verified by building, changing one
 * word of `/~offline`'s text, building again, and hashing `sw.js.body`: the
 * three build-id entries were what moved. So this page is re-fetched on every
 * deploy, which is the freshness guarantee, at the cost of a service-worker
 * update per deploy whether or not anything relevant changed.
 *
 * `cache: "reload"` because the point is a copy that matches THIS build; the
 * HTTP cache may still be holding the last one.
 *
 * `base` is the worker's own `self.location.href`. It is a parameter rather
 * than a global read because `Request` cannot resolve a relative URL outside a
 * browsing context — passing it in is what lets both this and
 * `readOfflineFallback` agree on one absolute URL, and what lets either be
 * exercised at all outside a worker.
 */
export async function warmOfflineFallback(
  storage: CacheStorage,
  base: string,
): Promise<boolean> {
  try {
    const cache = await storage.open(CACHE_NAMES.offlineFallback);
    await cache.add(new Request(offlineFallbackUrl(base), { cache: "reload" }));
    return true;
  } catch (error) {
    // Swallowed, but not silent. This runs inside the install event's
    // `waitUntil`, and a rejection there FAILS THE INSTALL — so a transient
    // network fault while warming one fallback page would cost the learner the
    // entire service worker, offline study included. A worker with no fallback
    // page is a much smaller loss, and the next update tries again.
    //
    // The warning is the only trace this failure leaves. Without it, a deploy
    // that broke `/~offline` for everyone would surface as unlabelled browser
    // error pages weeks later with nothing to search for: `handlerDidError`
    // returns undefined, and Serwist then rethrows the ORIGINAL network error.
    // Nothing here carries user or account data.
    console.warn("[safwa-sw] offline fallback warm failed", error);
    return false;
  }
}

/** The warmed offline page, or `undefined` if warming never succeeded. */
export async function readOfflineFallback(
  storage: CacheStorage,
  base: string,
): Promise<Response | undefined> {
  try {
    const cache = await storage.open(CACHE_NAMES.offlineFallback);
    return await cache.match(offlineFallbackUrl(base));
  } catch {
    return undefined;
  }
}

/**
 * Drop the caches that can hold account-specific markup, on sign-out.
 *
 * Returns the names actually deleted, which is what makes this observable in a
 * test — `CacheStorage.delete` answers false for a cache that was never
 * created, and "nothing to delete" and "failed to delete" must not look the
 * same.
 *
 * Best-effort by contract: the caller (`signOutAndClearLocalState`) has already
 * ended the authoritative session, and nothing here may block that.
 */
export async function clearOwnerSensitiveCaches(
  storage: CacheStorage,
): Promise<string[]> {
  const deleted: string[] = [];
  for (const name of OWNER_SENSITIVE_CACHE_NAMES) {
    try {
      if (await storage.delete(name)) deleted.push(name);
    } catch {
      // One cache refusing to delete must not stop the others.
    }
  }
  return deleted;
}

/**
 * The same sweep, as the one line an account-departure path should call.
 *
 * There are two such paths — `signOutAndClearLocalState` and
 * `DeletedAccountCleanup` — and the first version of this slice wired the
 * sweep into only one of them, which is precisely the asymmetry that made
 * account deletion the weaker guarantee of the two. Every caller needs the same
 * three things (a `caches` that may not exist, a failure that must not
 * propagate, and no return value worth acting on), so they are here rather than
 * repeated at each site.
 *
 * `tests/unit/account-departure-cleanup.test.ts` asserts that every file
 * calling `clearAccountLocalState` also calls this, so a third departure path
 * cannot reintroduce the gap quietly.
 */
export async function clearOwnerSensitiveCachesIfAvailable(): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    await clearOwnerSensitiveCaches(caches);
  } catch {
    // Best-effort by contract: every caller has already done something
    // irreversible (ended the session, or observed the account deleted), and
    // nothing may block on storage.
  }
}
