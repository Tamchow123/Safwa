/// <reference lib="webworker" />

/**
 * The service worker entry point (Phase 18, slice 9).
 *
 * Deliberately thin, and it stays thin. This file is the ONE module in the
 * repository compiled for a worker global scope rather than the browser or the
 * server, so it is excluded from the root `tsconfig.json` and checked by
 * `tsconfig.sw.json` instead (`pnpm typecheck` runs both). Anything with logic
 * worth testing therefore belongs in a sibling module that the main program —
 * and the unit suite — can still see; slice 10's cache rules are written that
 * way for exactly this reason.
 *
 * `defaultCache` is never imported, here or later. Reading its source is what
 * settled it (phases-18.md §4): it caches every `/api/*` GET for 24 hours,
 * which for this app means authenticated learner data in a cache that is not
 * owner-scoped and is not cleared on sign-out; its font rule keeps four
 * entries, which Geist plus three Noto Naskh Arabic weights already exceed, so
 * Arabic type would be evicted and re-fetched — the one thing that must not
 * happen offline in an Arabic vocabulary app; and it reads `process.env.NODE_ENV`
 * at module scope, which serwist's esbuild configuration never defines.
 *
 * `runtimeCaching` is empty in this slice ON PURPOSE. Slice 9 is a decision
 * point about the TOOLING — does the worker build, does the manifest contain
 * real chunks, is it served with the right scope header — and an empty rule set
 * makes that question answerable on its own. Slice 10 writes the rules.
 */
import { Serwist } from "serwist";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";

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

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  // Take over immediately rather than waiting for every tab to close. This app
  // has one user on one device; the alternative is a stale worker persisting
  // until they happen to close the last tab, which is indistinguishable from
  // "the update did not install".
  //
  // OPEN QUESTION FOR SLICE 11, recorded here because this is where the
  // decision is made: together these claim already-open tabs the instant a new
  // worker activates, with no reload. A tab left open across a deploy then
  // runs old page JS against a new precache, and if it is mid-quiz with an
  // unsynced review event the version skew has no defined recovery path.
  // Vercel keeps previous deployments' hashed assets reachable, which blunts
  // it, but slice 11 owns registration and must decide explicitly: silent
  // takeover, a `controllerchange`-triggered reload, or deferring control
  // while `runSync` has a push in flight.
  skipWaiting: true,
  clientsClaim: true,
  // `navigationPreload` is deliberately NOT enabled here. The browser's
  // preload response is only read by a route that handles the navigation, and
  // `runtimeCaching` is empty in this slice — so enabling it now would make
  // every navigation cost two concurrent requests, one of which nothing reads.
  // It belongs with slice 10's document rule, which is what consumes it.
  runtimeCaching: [],
});

serwist.addEventListeners();
