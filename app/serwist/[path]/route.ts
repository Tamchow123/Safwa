/**
 * Serves the built service worker (Phase 18, slice 9).
 *
 * `@serwist/turbopack` emits the worker through a Route Handler rather than a
 * bundler plugin, which is what makes it usable here at all: `pnpm build` is
 * plain `next build` and this project's output contains `.next/turbopack/`, so
 * Turbopack is the bundler and a webpack-only tool such as `next-pwa` is not an
 * option. `withSerwist()` in `next.config.ts` only appends to
 * `serverExternalPackages`; nothing else in the build is coupled to it.
 *
 * The handler is `force-static`, so everything below happens at BUILD time —
 * esbuild bundles `modules/pwa/sw.ts`, the precache manifest is injected, and
 * the result is written out as a static asset. Nothing here runs per request,
 * and no filesystem read reaches production traffic.
 *
 * `generateStaticParams` produces one entry per emitted file, which is why the
 * segment is a single `[path]` rather than a catch-all: the worker is `sw.js`
 * at the root of the output, so the served URL is `/serwist/sw.js`. The handler
 * sets `Service-Worker-Allowed: /` itself, which is what lets a worker served
 * from `/serwist/` control the whole origin.
 */
import { createSerwistRoute } from "@serwist/turbopack";

import { CONTENT_ARTIFACT_PUBLIC_GLOB } from "@/modules/content/constants";

export const { dynamic, dynamicParams, revalidate, generateStaticParams, GET } =
  createSerwistRoute({
    swSrc: "modules/pwa/sw.ts",
    /**
     * Content release artifacts are NOT precached, and this exclusion is
     * load-bearing rather than an optimisation.
     *
     * The default glob sweeps in all of `public/**`, which pulls in
     * `/content/active.json` and each release's `learner.json`. A Serwist
     * precache route answers a matching request straight from Cache Storage
     * and takes precedence over any runtime route for the same URL, with two
     * consequences neither `phases-18.md` §7 nor §4 anticipated:
     *
     *  - `modules/content/load.ts` fetches the pointer with `cache: "no-store"`
     *    specifically to defeat caching. A service worker intercepts before the
     *    HTTP cache, so precaching it silently overrides that intent.
     *  - §7 assigns the pointer `NetworkFirst` with a 3s timeout and each
     *    release `CacheFirst, keep 3`. Precaching both would make slice 10's
     *    rules dead on arrival — present in the code, never reached.
     *
     * Excluding them costs nothing that matters: §7.1 records that offline
     * content loading already works through `load.ts`'s Dexie fallback, which
     * predates this phase and needs no service worker. The app shell and icons
     * are still precached, which is what an offline cold boot actually needs.
     *
     * The pattern is the shared constant, not a local literal, because
     * `sw:verify`'s check 2c has to name the same subtree as a URL prefix —
     * and if those two ever disagree the check passes by matching nothing.
     */
    globIgnores: [CONTENT_ARTIFACT_PUBLIC_GLOB],
    // Pinned rather than left to the platform default, which is `esbuild` on
    // Windows and `esbuild-wasm` everywhere else. That default would mean this
    // project's worker is bundled by one tool on the machine it is authored on
    // and a different one in CI and on Vercel — a difference nobody would think
    // to look for when the output differs. `esbuild` is a direct devDependency
    // so the choice resolves identically on every platform.
    useNativeEsbuild: true,
  });
