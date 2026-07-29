/// <reference lib="webworker" />

/**
 * The service worker entry point (Phase 18, slices 9–10).
 *
 * Wiring only, and nothing else may move in here: this file is invisible to
 * both the root TypeScript program and Vitest, so anything written here cannot
 * be tested. `modules/pwa/README.md` explains why and what the sibling modules
 * are for; the short version is that a reader should be able to check this file
 * by eye and find every decision it applies somewhere testable.
 *
 * `defaultCache` is never imported, here or later. Reading its source settled
 * it (phases-18.md §4): it caches every `/api/*` GET for 24 hours, which for
 * this app means authenticated learner data in a cache that is not owner-scoped
 * and is not cleared on sign-out; and its font rule keeps four entries, which
 * Geist plus three Noto Naskh Arabic weights already exceed, so Arabic type
 * would be evicted and re-fetched — the one thing that must not happen offline
 * in an Arabic vocabulary app.
 *
 * §4 gives a third reason that is WRONG and should not be repeated: that
 * `defaultCache` reads `process.env.NODE_ENV` "which serwist's esbuild
 * configuration never defines". `@serwist/build` does not define it, but calls
 * esbuild with `platform: "browser"` and `minify: true`, and esbuild supplies
 * it — the emitted worker contains zero occurrences of `process.env` while
 * serwist's dist is full of `process.env.NODE_ENV !== "production"` guards.
 * The two reasons above are each sufficient on their own.
 */
import {
  CacheFirst,
  ExpirationPlugin,
  NetworkFirst,
  NetworkOnly,
  Serwist,
} from "serwist";
import type {
  PrecacheEntry,
  RuntimeCaching,
  SerwistGlobalConfig,
} from "serwist";

import {
  isStorableResponse,
  SERVER_RENDERED_CACHE_MAX_AGE_SECONDS,
} from "@/modules/pwa/cache-policy";
import {
  BUILD_ASSET_MAX_AGE_SECONDS,
  CACHE_NAMES,
  DOCUMENT_CACHE_MAX_ENTRIES,
  DOCUMENT_NETWORK_TIMEOUT_SECONDS,
  matcherFor,
  POINTER_NETWORK_TIMEOUT_SECONDS,
  RELEASE_CACHE_MAX_ENTRIES,
  RSC_CACHE_MAX_ENTRIES,
  RSC_NETWORK_TIMEOUT_SECONDS,
  RULE_ORDER,
} from "@/modules/pwa/cache-rules";
import {
  readOfflineFallback,
  warmOfflineFallback,
} from "@/modules/pwa/cache-storage";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    /**
     * Injected at build time by `@serwist/turbopack` at the `injectionPoint`.
     *
     * Typed as possibly `undefined` because it genuinely is under `next dev`:
     * the option schema sets `disablePrecacheManifest` in development, so the
     * placeholder is left unreplaced. A worker that assumes an array here works
     * in production and throws in development.
     */
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

/**
 * The last resort for a navigation: the warmed `/~offline` page.
 *
 * `handlerDidError` fires only after the strategy itself has failed, which for
 * `NetworkFirst` means the network failed AND its cache had no copy — so a page
 * the learner has visited before still comes back from the document cache, and
 * only a genuinely uncached route reaches this.
 */
const offlineFallbackPlugin = {
  handlerDidError: () => readOfflineFallback(self.caches, self.location.href),
};

/**
 * The only thing standing between a response and Cache Storage.
 *
 * Applied to the two rules whose responses are server-rendered. It refuses both
 * what the server marked private and what is not a 200 — and the second half is
 * not belt-and-braces: registering ANY `cacheWillUpdate` plugin stops
 * `NetworkFirst` from prepending its own status guard, so this plugin's
 * existence is what makes the status check necessary. `cache-policy.ts` carries
 * both decisions and the reasoning behind them; `null` means do not store.
 */
const privateResponsePlugin = {
  cacheWillUpdate: async ({ response }: { response: Response }) =>
    isStorableResponse(response) ? response : null,
};

/**
 * §7's table, in registration order.
 *
 * Serwist registers these in array order and the FIRST match wins, so the order
 * is behaviour. It is taken from `RULE_ORDER` rather than written out again
 * here, so the order the worker registers is the order the unit tests resolve
 * against — there is no second list to drift.
 */
const HANDLERS = {
  api: new NetworkOnly(),
  buildAsset: new CacheFirst({
    cacheName: CACHE_NAMES.buildAssets,
    plugins: [
      new ExpirationPlugin({ maxAgeSeconds: BUILD_ASSET_MAX_AGE_SECONDS }),
    ],
  }),
  releasePointer: new NetworkFirst({
    cacheName: CACHE_NAMES.contentPointer,
    networkTimeoutSeconds: POINTER_NETWORK_TIMEOUT_SECONDS,
  }),
  learnerRelease: new CacheFirst({
    cacheName: CACHE_NAMES.contentReleases,
    plugins: [new ExpirationPlugin({ maxEntries: RELEASE_CACHE_MAX_ENTRIES })],
  }),
  rsc: new NetworkFirst({
    cacheName: CACHE_NAMES.rsc,
    networkTimeoutSeconds: RSC_NETWORK_TIMEOUT_SECONDS,
    plugins: [
      new ExpirationPlugin({
        maxEntries: RSC_CACHE_MAX_ENTRIES,
        maxAgeSeconds: SERVER_RENDERED_CACHE_MAX_AGE_SECONDS,
      }),
      privateResponsePlugin,
    ],
  }),
  appShell: new CacheFirst({ cacheName: CACHE_NAMES.appShell }),
  document: new NetworkFirst({
    cacheName: CACHE_NAMES.documents,
    networkTimeoutSeconds: DOCUMENT_NETWORK_TIMEOUT_SECONDS,
    plugins: [
      new ExpirationPlugin({
        maxEntries: DOCUMENT_CACHE_MAX_ENTRIES,
        maxAgeSeconds: SERVER_RENDERED_CACHE_MAX_AGE_SECONDS,
      }),
      privateResponsePlugin,
      offlineFallbackPlugin,
    ],
  }),
} as const;

const runtimeCaching: RuntimeCaching[] = RULE_ORDER.map((rule) => ({
  matcher: matcherFor(rule),
  handler: HANDLERS[rule],
}));

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  // Take over immediately rather than waiting for every tab to close. This app
  // has one user on one device; the alternative is a stale worker persisting
  // until they happen to close the last tab, which is indistinguishable from
  // "the update did not install".
  //
  // ANSWERED IN SLICE 11, recorded here because this is where the takeover is
  // configured. Together these claim already-open tabs the instant a new
  // worker activates, with no reload — so a tab left open across a deploy runs
  // old page JS against a new precache. Slice 11 takes the reload:
  // `shouldReloadOnControllerChange` in `modules/pwa/registration.ts` reloads
  // the page when a NEW worker takes over one that already had a controller,
  // which costs at most the current unanswered question (every graded attempt
  // is already durable) and is the only option that leaves no window in which
  // a lazily-loaded chunk is missing offline. That function's docblock carries
  // the full reasoning and the alternatives that were rejected.
  skipWaiting: true,
  clientsClaim: true,
  // Enabled HERE and not in slice 9, because the payoff needs a route that
  // consumes it. `StrategyHandler.fetch()` awaits `event.preloadResponse` and
  // returns it when present, but only for `request.mode === "navigate"` — so it
  // is the document rule above, and its built-in `NetworkFirst` strategy, that
  // turn the second request the browser makes into a saved round trip rather
  // than waste. Verified in serwist's own dist, not assumed.
  navigationPreload: true,
  runtimeCaching,
});

/**
 * Warm the offline page before anything needs it.
 *
 * Registered before `addEventListeners()` so the ordering is visible: both this
 * and Serwist's own install listener run, and `waitUntil` keeps the install
 * open for both. `warmOfflineFallback` never rejects — see its own comment for
 * why failing the install over one page would be the wrong trade.
 */
self.addEventListener("install", (event) => {
  event.waitUntil(warmOfflineFallback(self.caches, self.location.href));
});

serwist.addEventListeners();
