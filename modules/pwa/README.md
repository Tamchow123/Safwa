# modules/pwa

Progressive-web-app support (Phase 18): the service worker and, from slice 10,
the runtime cache rules it applies.

## Files

| File               | Runs in             | Purpose                                                                                                                                            |
| ------------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sw.ts`            | **worker scope**    | the service-worker entry point — deliberately thin, see below                                                                                      |
| `cache-rules.ts`   | both                | which rule a **request** gets, as pure predicates plus the names, bounds and registration order they are wired with                                |
| `cache-policy.ts`  | both                | which **response** may then be written to the two server-rendered caches, and for how long — the confidentiality guard                             |
| `cache-storage.ts` | worker **and** page | the Cache Storage operations: warm the offline page, read it, drop the account-sensitive caches on sign-out, and drop them all for the kill switch |
| `registration.ts`  | page                | whether this build registers, unregisters, or reloads — the update strategy and the kill switch                                                    |
| `install-hint.ts`  | page                | whether to offer installing the app, and by which of the two mechanisms                                                                            |

`cache-rules.ts` and `cache-policy.ts` are split because they answer to
different owners. The first is a routing table; the second is where "what can
this app cache from a signed-in learner" is decided, and it is kept small and
purpose-named so that question has one file to read.

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
  the one thing that must not happen offline in an Arabic vocabulary app.

§4 gives a third reason — that `defaultCache` reads `process.env.NODE_ENV` at
module scope "which serwist's esbuild configuration never defines" — and slice
10 **measured it to be wrong**, so it should not be repeated. `@serwist/build`
does not define it, but it calls esbuild with `platform: "browser"` and
`minify: true`, and esbuild then supplies `process.env.NODE_ENV` itself. The
emitted worker contains zero occurrences of `process.env` while serwist's own
dist is full of `process.env.NODE_ENV !== "production"` guards — they were
substituted and eliminated. The two reasons above are each sufficient on their
own; this one is not a reason at all.

Rules are written explicitly instead, in `cache-rules.ts`.
`docs/phases/phases-18.md` §7 is the table; §7.1 records precisely what the
content rules do and do not buy, which matters because a future regression there
degrades latency and redundancy without making the app offline-hostile —
debugging should start at `modules/content/load.ts`, not here.

## Why the rules are predicates in a separate file

Three properties fall out of it, and none of them would if the rules were
inline in `sw.ts`:

- **They are testable.** `sw.ts` is invisible to the root TypeScript program and
  to Vitest. `cache-rules.test.ts` resolves whole requests through `ruleFor`,
  which applies first-match-wins over `RULE_ORDER` exactly as Serwist does — so
  what it asserts is the rule a request actually receives, not the behaviour of
  one predicate in isolation.
- **Order is data.** `RULE_ORDER` is the registration order, and `sw.ts` builds
  its `runtimeCaching` array from it. There is no second list to drift, and
  `/api` being first — which is what stops a later rule from ever caching an
  authenticated response — is asserted rather than merely observed.
- **The names are shared.** `scripts/verify-service-worker.ts` reads
  `CACHE_NAMES` to check the rules reached the bundle, and
  `components/account/sign-out-action.ts` reads
  `OWNER_SENSITIVE_CACHE_NAMES` to know what to drop.

The gap this leaves, stated plainly: every one of those unit tests passes
whether or not `sw.ts` imports any of it. That is what `sw:verify`'s check `1c`
is for — a cache name only appears in the emitted bundle because a handler was
constructed with it — and what slice 12's offline E2E proves properly.

## What may be written to the document and RSC caches

`cache-policy.ts`'s `isStorableResponse` gates both, through a `cacheWillUpdate`
plugin, and it refuses on two independent grounds — each its own function, since
each is there for its own reason.

**Not a 200.** Serwist's `NetworkFirst` prepends its own status guard only
`if (!this.plugins.some((p) => "cacheWillUpdate" in p))` — so registering the
privacy plugin below is exactly what removes it, and `cacheOkAndOpaquePlugin`
is not exported to put back. Without the status check a transient 500 would be
stored and later replayed as the page, because `Strategy` treats a response as
an error only when it is `undefined` or `type === "error"`.

**Marked private.** `/account` server-renders the learner's name and email, and
`app/(shell)/**` is server-rendered throughout. Measured against `pnpm start`:
a prerendered route answers `Cache-Control: s-maxage=31536000` with
`x-nextjs-prerender: 1`; a dynamic one answers
`private, no-cache, no-store, max-age=0, must-revalidate`. So the cache holds
public shells and nothing else.

A missing header still caches. Requiring a positive marker was considered and
declined: the markers were measured from `next start`, this app has never been
deployed, and a hosting edge that normalised them away would silently stop
caching every document and take offline study with it — a worse failure, and an
invisible one. `SERVER_RENDERED_CACHE_MAX_AGE_SECONDS` (30 days) bounds whatever
slips through, and `OWNER_SENSITIVE_CACHE_NAMES` is swept on both
account-departure paths.

That age bound is not free, and its clock is not the one a reader might assume.
`ExpirationPlugin` stamps an entry when it is **written** and does not refresh
that stamp on a cache-only read (`maxAgeFrom: "last-used"` is not configured),
and it enforces the bound on read as well as on write. So one unbroken 30-day
offline stretch expires every document and RSC entry together, **including the
start URL**: the installed app would launch into `/~offline`, whose "Try again"
link points at `/` and loops back until connectivity returns. Bounded,
self-healing on the next successful fetch, and it touches no study data —
progress is in Dexie and the fallback page has its own cache with no expiry.

**Covered as of slice 12:** `e2e/offline.spec.ts`'s "the Cache-Control contract
the cache policy rests on" block asserts the real header against a real
`next start` server, in both directions — `/account` (server-renders the
learner's name and email) must come back `no-store` or `private`, and `/study`
(prerendered) must not. Both halves matter: a contract that only refused to cache
would cost offline study the app shell to protect nothing. The requests are made
with `page.request`, which does not go through the service worker, so what is
asserted is the server's response rather than a replay from a cache.

That is still not the whole guarantee. `docs/DEPLOYMENT.md`'s first-deploy
checklist repeats the same check against the real host, because a hosting edge —
not `next start` — is what can normalise a header away, and no server Playwright
starts will ever be one.

## The offline page is warmed, not precached

`app/~offline/page.tsx` is fetched into its own cache during the worker's
`install` (`warmOfflineFallback`), and the document rule's `handlerDidError`
serves it when a navigation is both uncached and unreachable.

It is not an `additionalPrecacheEntries` entry because a precache entry needs a
revision: a string entry gets `revision: null`, meaning fetched once and never
again, and `/~offline` is a Next page referencing content-hashed chunks — a copy
pinned forever would eventually point at chunks a later precache cleanup had
deleted. There is no build-stable revision available where the worker is
configured.

**The worker's bytes change on every build**, so the warm re-runs on every
deploy. That is stronger than the "changes when an asset changes" it was
originally documented as, and it was measured rather than assumed: build,
change one word of `/~offline`'s text, build again, hash `sw.js.body`. The
bytes differ, and the entries that moved are the three
`/_next/static/<build id>/_buildManifest.js`-style URLs — Next generates a new
build id every time.

Two consequences worth knowing:

- the offline page is never stale, including for a copy-only edit; and
- **every deploy activates a new service worker**, whether or not anything
  relevant changed. With `skipWaiting` + `clientsClaim` still set, that means
  every deploy claims open tabs — which is why slice 11 has to decide the
  update strategy rather than inherit it.

## Registration, the update strategy, and the kill switch

`components/pwa/service-worker-provider.tsx` is mounted in the **root** layout,
not the shell's — `(auth)` is a sibling route group, and someone who lands on
`/sign-in` first would otherwise reach the app with no worker registered. It
decides nothing; `registration.ts` does.

**`NEXT_PUBLIC_SW_ENABLED` is a tri-state, not a boolean.** Unset means on in a
production build and off otherwise, which keeps a worker out of `next dev` and
out of the four Playwright configs that predate this phase. `true` forces it on
(slice 12's offline config is the one place a worker must run outside a real
deploy). `false` **unregisters and clears the caches** — and that active undo is
the whole point: a worker is installed on the device, not shipped with the page,
so a build that merely stopped calling `register()` would leave the previous one
in control forever and `docs/DEPLOYMENT.md` §8's "unregister SW" step would be a
sentence rather than a mechanism. Anything unrecognised is treated as unset, not
as off: a typo silently disabling offline support in production is the worse
failure, and it is invisible until someone loses their connection.

Both halves enumerate, for the same reason: the rollback exists for the case
where something **unexpected** is installed, so neither half may depend on the
installed thing matching today's constants. `unregisterServiceWorkers` uses
`getRegistrations()` rather than the scope this build knows, and
`clearAllAppCaches` uses `caches.keys()` rather than the seven names in
`CACHE_NAMES`.

The cache sweep is separate and necessary because **`unregister()` does not
empty Cache Storage**. Cache Storage belongs to the origin, not to the
registration; Serwist's precache is pruned by a _new_ worker's activate-time
cleanup, which a rollback never runs because it installs no replacement. A kill
switch that only unregistered would leave every cache the worker ever wrote on
the device, inert and unreclaimable, until someone turned the worker back on.

They are also **not chained** — the call
`components/account/deleted-account-cleanup.tsx` already makes, for the same
reason. They touch different stores, so neither depends on the other, and
sequencing them would let an unregistration that hangs rather than rejects take
the cache sweep down with it silently.

`clearOwnerSensitiveCaches` stays narrow for the opposite reason: over-deleting
during a rollback costs a re-download, which is what a rollback implies, while
over-deleting on an ordinary sign-out costs the next learner on a shared device
the whole app.

**The update strategy is a reload.** `sw.ts` sets `skipWaiting` +
`clientsClaim`, and every build produces a new worker (see the section above),
so a new worker claims open tabs on every deploy. `shouldReloadOnControllerChange`
reloads when a worker takes over a page that **already had one** — never on the
first worker a page gets, which is every first visit, and never twice. The cost
is at most the current unanswered question: `modules/study-session/persistence.ts`
writes each graded attempt, its review event and the replayed scheduling state
atomically before the next question renders. The alternative — an open tab
running the old build's JS under the new precache — is a cache miss on the next
lazily-loaded route, which offline is a broken route.

## Two install mechanisms, because there are two

Chromium fires `beforeinstallprompt` and hands the page an object that can
trigger the real flow. WebKit implements none of it, on any iOS browser — the
app is still installable there, but only through Share → Add to Home Screen,
which a page can describe and cannot trigger. So iOS gets a different answer,
not a degraded version of the same one.

That is also why `install-hint.ts` sniffs the user agent, which is normally the
wrong tool: the thing being detected genuinely is the platform, and there is no
feature to test for, because the whole signal is the _absence_ of an event and
absence is indistinguishable from "not yet". iPadOS 13+ reports a desktop
Macintosh UA, so an iPad is recognised by a Mac-like UA that also reports touch
points.

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
together with three checks that are not §6 criteria: `1b` above, `1c` (the rules
reached the bundle) and `2c` (no content artifact is precached).
`tests/unit/service-worker-criteria.test.ts` breaks each one against a synthetic
build output to prove the check can fail. If a criterion ever stops holding, the
recorded fallback is a hand-written runtime-caching worker plus **ADR-010** —
not a relaxed check.
