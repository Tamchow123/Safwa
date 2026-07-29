# modules/pwa

Progressive-web-app support (Phase 18): the service worker and, from slice 10,
the runtime cache rules it applies.

## Files

| File    | Runs in          | Purpose                                                       |
| ------- | ---------------- | ------------------------------------------------------------- |
| `sw.ts` | **worker scope** | the service-worker entry point — deliberately thin, see below |

## The one module compiled for a worker global scope

`sw.ts` is the only TypeScript in this repository that runs in a
`ServiceWorkerGlobalScope` rather than the browser or Node. `lib.dom` and
`lib.webworker` declare the same names with different shapes and cannot coexist
in one TypeScript program, so:

- `sw.ts` is listed in the root `tsconfig.json`'s `exclude`;
- `tsconfig.sw.json` checks it instead, with `lib: ["esnext", "webworker"]`;
- `pnpm typecheck` runs **both** passes.

That is an exclusion from one program, **not** from type checking. Anything with
logic worth testing therefore belongs in a sibling file in this module, which
the main program and the unit suite can still see — slice 10's cache-rule
predicates are written that way for exactly this reason. Keep `sw.ts` thin.

## `defaultCache` is never imported

Not as a shortcut, not "for now". Reading its source is what settled it
(`docs/phases/phases-18.md` §4):

- it caches **every `/api/*` GET for 24 hours**, which here means authenticated
  learner data in a cache that is not owner-keyed and is not cleared on
  sign-out — against CLAUDE.md rule 8's whole premise;
- its font rule keeps **4 entries**, and Geist plus three Noto Naskh Arabic
  weights already exceed that, so Arabic type would be evicted and re-fetched —
  the one thing that must not happen offline in an Arabic vocabulary app;
- it reads `process.env.NODE_ENV` at module scope, which serwist's esbuild
  configuration never defines.

Rules are written explicitly instead. `docs/phases/phases-18.md` §7 is the
table; §7.1 records precisely what the content rules do and do not buy, which
matters because a future regression there degrades latency and redundancy
without making the app offline-hostile — debugging should start at
`modules/content/load.ts`, not here.

## Content artifacts are excluded from the precache manifest

`app/serwist/[path]/route.ts` passes `globIgnores:
[CONTENT_ARTIFACT_PUBLIC_GLOB]` — the content module's own constant, because
`sw:verify` check `2c` has to name the same subtree as a URL prefix and a check
that stops matching passes silently. A Serwist precache route answers from Cache
Storage and takes precedence over a runtime route for the same URL, so
precaching the release pointer and each release's `learner.json` would:

- silently override `modules/content/load.ts`'s deliberate
  `cache: "no-store"` on the pointer — a service worker intercepts before the
  HTTP cache; and
- make §7's `NetworkFirst` pointer rule and `CacheFirst, keep 3` release rule
  unreachable.

Nothing is lost offline: `load.ts` already falls back to a verified cached
release in Dexie on every failure path, which predates this phase and needs no
service worker.

## How the worker is built and served

There is no bundler plugin. `pnpm build` is plain `next build` and this project
uses Turbopack, so a webpack-only tool such as `next-pwa` is not an option.
Instead `app/serwist/[path]/route.ts` is a `force-static` Route Handler that
runs esbuild at **build** time and emits `/serwist/sw.js`, with
`Service-Worker-Allowed: /` so a worker served from a subpath can control the
whole origin. `next.config.ts` wraps the config in `withSerwist`, which appends
`esbuild`/`esbuild-wasm` to `serverExternalPackages` and does nothing else.

That header is why the route's bounds matter more than they look. It grants
whatever the route returns control of the entire origin, and the route returns
exactly what `generateStaticParams` enumerated — `dynamicParams: false` makes
every other path a 404. Both halves are pinned:
`tests/unit/serwist-route.test.ts` asserts the three config values, and
`sw:verify` check `1b` asserts the enumerated set is the worker and its source
map and nothing else. If `1b` fails, the question is what the new file is and
whether serving it under that header is intended — then update the expected list
deliberately.

`docs/phases/phases-18.md` §6 makes adopting this tooling conditional on four
observations. They are enforced after every build by `pnpm sw:verify`
(`scripts/verify-service-worker.ts`, quality-gate step 20 and a CI step),
together with the two absence checks review added (`1b` above and `2c`, the
precache exclusion), and `tests/unit/service-worker-criteria.test.ts` breaks each
one against a synthetic build output to prove the check can fail. If a criterion
ever stops holding, the recorded fallback is a hand-written runtime-caching
worker plus **ADR-010** — not a relaxed check.
