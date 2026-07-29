# Phase 18 — PWA, offline & first production deploy

**Branch:** `phase/18-pwa-offline-deploy` · **Workflow:** `/run-phase`
(branch → reviewed slices → per-commit review → `scripts/quality-gate.ps1`
exit 0 → full council → **draft** PR; the human reviews and merges).

**This is the last implementation phase.** Phases 19, 20 and 21 are
deliberately skipped and most of Phase 22 is deferred; §3 records why, and —
more importantly — what would reopen each of them.

---

## 1. Why this phase exists

Phases 0–17 are merged and the Core MVP is complete. The owner wants to stop
building and start studying daily **on a phone** (iPhone and Android), hosted
on **Vercel + Neon**, using a **real account** so review history is
server-backed rather than device-local.

Three things stand between the finished app and that:

1. **It isn't deployed.** `docs/DEPLOYMENT.md` is explicitly a "planning
   baseline". Nothing is provisioned, there is no `vercel.json`, and CI has no
   deploy step.
2. **It isn't installable and doesn't work offline.** There is no web manifest,
   no service worker, and not a single image file in the repository. A service
   worker requires a secure context, so **deployment must come first** — the
   PWA cannot be proved anywhere but locally until it does.
3. **There are no backups.** `pg_dump` appears exactly once in the repository,
   as a prose bullet in `docs/DEPLOYMENT.md` §7. Once a hosted Postgres holds
   months of learning history, that is the one omission worth regretting.

## 2. The defect this phase must fix before it can ship its own feature

`components/sync/use-local-owner.ts` resolves the owner for every private Dexie
read and write. On a **cold boot with no network while signed in**:

- `useLocalOwner()` returns `data?.user?.id ?? null` → `null` → **guest**.
- `useResolveOwner()` returns early because `isPending` is already `false` (the
  session fetch _rejected_ rather than staying in flight), so `ownerRef.current`
  — never populated — is `null`. The `catch` that promises to "fall back to the
  last known owner rather than silently claiming guest" is **unreachable in
  exactly this case**, because nothing is awaited on that path.

The consequence is that every offline review would be stamped
`ownerKey: "guest"`. That violates CLAUDE.md hard rule 8, makes the rows
invisible to the account's own owner-scoped reads, and prevents them from ever
being enqueued for sync (`modules/sync/client/persistence.ts` gates enqueueing
on the bound attempt's `userId`). It would surface to the learner only as a
Phase-17 guest-merge prompt offering to import their own work back to
themselves.

**This is unreachable today.** With no service worker, an offline cold boot
shows the browser's own network-error page and no application code runs at all.
Adding the PWA is precisely what makes the path reachable. The fix therefore
belongs in this phase, **ahead of** the service worker, not in a phase of its
own.

The discriminator that makes a clean fix possible: a genuine guest resolves to
`{ data: null, error: null }` — the server answered, and the answer was "nobody
is signed in" — while an unreachable server resolves to `{ data: null, error:
<non-null> }`. `tests/setup.ts` already stubs `error: null`, so the existing
unit suite classifies as "genuine guest" and does not churn.

### The offline identity contract this phase establishes

| Session shape                                      | Classification | Local owner used            |
| -------------------------------------------------- | -------------- | --------------------------- |
| `data.user.id` is a valid account id               | `account`      | `account:<id>` (and remembered) |
| `isPending`                                        | `unknown`      | last-known owner, else guest |
| `data == null`, `error == null` (server answered)  | `guest`        | guest (and the memory is forgotten) |
| `error.status === 401`                             | `guest`        | guest (and the memory is forgotten) |
| network reject / 5xx / 503 from `AUTH_ENABLED=false` | `unknown`      | last-known owner, else guest |

"Last-known owner" is a durable `localStorage` record with **no TTL**. Expiring
it would reintroduce the bug on the first day after expiry, which is strictly
worse than not having it — a bug that appears once is found, a bug that appears
on day 8 is not.

### 2.1 The memory must be forgotten on identity change, not on a clock

Having no TTL means the memory's only bound is an explicit forget. There are
exactly three events that must forget it, and all three are identity changes
the app already observes:

| Event                                    | Where it is wired                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------- |
| A classified **`guest`** (server answered "nobody is signed in", or a 401) | the hooks themselves, `components/sync/use-local-owner.ts` (slice 4) |
| **Sign-out**                             | `components/account/sign-out-action.ts`, beside the existing preference-mirror clearing |
| **Account deletion**                     | `components/account/deleted-account-cleanup.tsx`, beside its existing `clearAccountLocalState` |

Account deletion matters specifically because a TTL-free memory would otherwise
outlive the account it names: delete the account, re-register, go offline before
the new account has completed one successful session check, and `unknown` would
resolve to the **old, deleted** account id — stamping fresh offline reviews with
a dead owner key. A clock cannot fix that (the id is wrong immediately, not
eventually); forgetting on the deletion event can, and does.

**The residual gap, stated rather than papered over.** `forgetLastKnownOwner()`
is exhaustive within what a caller can control: it deletes, verifies by reading
back, and — when the delete returns normally but the value survives —
neutralises the value with a write, which is a different operation and so can
succeed where the delete silently did not. Three failures survive even that: a
storage that refuses every operation, one that accepts both and honours
neither, and one whose reads throw so nothing can be confirmed. In those cases
the only remaining backstop is the hooks' own forget on the next `guest`
classification, and **that requires a render to happen**. A learner who signs
out and immediately closes the tab, on a device where storage is that broken,
can leave the memory behind. Nothing in this phase closes that; it is recorded
here so it is not mistaken for a guarantee.

## 3. What is deliberately skipped, and what reopens it

| Deferred                | Why                                                                                                                                                                                        | What reopens it                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Phase 19** — multi-device offline reconciliation | The `stale_branch_conflict` fork needs two devices alternating offline edits on **one** component. Single-device use cannot reach it; the machinery would be built and never exercised. | **Acquiring a second study device.** The moment a second device studies the same account offline, Phase 19 is required, not optional. |
| **Phase 20** — settings & reset controls | Roughly 70% already shipped across Phases 12–17 (settings surface, account deletion, scoped sign-out cleanup), and the remainder has a working substitute: delete the account and start again. | Sharing the app with anyone who needs a partial reset without losing everything.                     |
| **Phase 21** — admin & content management | The JSON → `pnpm content:build` → `pnpm db:register-content` pipeline already works and is the owner's own workflow. An admin UI would wrap a pipeline of one user.                          | A second content editor, or content editing from a device without the repository checked out.        |
| **Most of Phase 22** — hardening & launch | Public-launch polish (accessibility audit, CSP, Sentry, performance budget, analytics, attribution page) for an app with one user. | Any public launch. **CSP specifically** is listed in §11 as knowingly left undone.                   |

Only Phase 22's **deploy, backup and security-header** slices are absorbed
here, because they are what "used daily on a phone" actually requires.

## 4. Approach

Fix identity first, then deploy, then add the service worker on top of a
deployment that can actually serve it, then prove the whole thing on both
phones.

**Service-worker tooling.** Adopt `@serwist/turbopack`. It satisfies the
Serwist choice already recorded in `docs/ARCHITECTURE.md` §2, so no new ADR is
needed for the choice itself. `withSerwist()` only appends to
`serverExternalPackages`; the worker is emitted by esbuild through a
`force-static` route handler, with no webpack coupling. That matters: `pnpm
build` is plain `next build` and the build output contains `.next/turbopack/`,
so Turbopack is the default bundler here and `next-pwa` (webpack-only) is not
viable.

**Slice 9 is a timeboxed decision point with explicit exit criteria.** Failing
them means a hand-written runtime-caching service worker and **ADR-010** to
record the departure from the recorded Serwist choice.

Three traps found by reading the package source, which shape the cache rules:

1. `defaultCache` caches **all `/api/*` GETs for 24 hours**. That is
   unacceptable here: authenticated learner data in a cache that is not
   owner-scoped and is not cleared on sign-out.
2. Its font rule is `maxEntries: 4`. Geist plus three Noto Naskh Arabic weights
   already exceed that, so Arabic type would be evicted and re-fetched — the
   one thing that must not happen offline in an Arabic vocabulary app.
3. It reads `process.env.NODE_ENV` at module scope, which serwist's esbuild
   configuration never defines.

**Therefore: write explicit rules; never import `defaultCache`.**

## 5. Slices

Each slice is one commit. `pnpm test` and `pnpm typecheck` pass at every slice.

| #   | Slice                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Phase contract.** This document; Phase 18's scope in `IMPLEMENTATION_PHASES.md` amended to absorb the deploy/backup/header subset of 22 and to record §3; `CLAUDE.md` current state.                                                                                       |
| 2   | **Pure identity classifier.** `classifySessionIdentity()` → `account \| guest \| unknown`, per the table in §2. Reuses `isValidOwnerAccountId` from `modules/content/owner-key.ts` rather than inventing a second notion of a valid id.                                       |
| 3   | **Durable last-known owner.** `localStorage` under `safwa.last-known-owner.v1`; every access in `try`/`catch` (Safari private mode throws on write); values re-validated through `isValidOwnerAccountId` on read. Deliberately **not** Dexie — the owner is the _key_ used to read owner-scoped stores, so storing it in one is circular. |
| 4   | **Wire the fix.** Both hooks classify instead of reading `data?.user?.id`. `unknown` → last-known owner; `guest` → `null` **and forget**. `localStorage` is read in an effect, never during render (20 routes are prerendered). Sign-out **and account deletion** both forget (§2.1). The docblock is updated — it currently asserts the behaviour this slice makes true. |
| 5   | **Honest status offline.** Derive `userId` from the classifier so the sync controller exists and reports offline rather than `guest`. Add a **`pagehide`** flush — iOS Safari does not reliably fire `visibilitychange` on background/kill. It sits safely beside the existing `visibilitychange` handler because `modules/sync/client/controller.ts` delegates to the **coalescing** `runSync`: overlapping triggers join the one in-flight run, so no debounce of our own is needed or wanted. Gate the merge offer on `unknown`, not only `isPending`. The header shows "Offline" rather than a sign-in CTA when a remembered owner exists. |
| 6   | **Close sign-up + env ceilings.** `SIGNUP_ALLOWED_EMAILS` parsed in env; **production fails closed if unset** — for a personal instance, open sign-up is the bug, not the safeguard. Enforced via `createAuthMiddleware` `hooks.before` on `/sign-up/email`. Adds the production upper bounds on all four `AUTH_RATE_LIMIT_*` variables that `DEPLOYMENT.md` §2 already asks for, so the E2E values structurally cannot reach production — **plus a floor on the two windows**, which §2 did not ask for and which is the actual security direction for that half of the pair: a one-second window empties faster than any max can slow an attacker down, so a ceiling alone would leave the same hole open from the other side. |
| 7   | **Icons, manifest, viewport.** One hand-authored SVG master, a `sharp` generator script, and committed PNGs (192/512, maskable 192/512, apple-touch 180, favicon). **No Arabic in the mark** — there is no source dataset for a brand word, so hard rule 3 is satisfied by avoidance, not by transcription. `viewportFit: "cover"` finally activates the currently-inert `env(safe-area-inset-bottom)` in `components/mobile-nav.tsx`. |
| 8   | **Deploy readiness.** Pin `outputFileTracingIncludes` for `content-server/**` and `public/content/**` onto the routes that read them — it works today only by `@vercel/nft` inference, and the failure mode is a runtime 503, not a build error. Add HSTS / nosniff / frame-deny / Permissions-Policy beside the existing `Referrer-Policy`. **No CSP** (§11). Correct `DEPLOYMENT.md` §3, which claims the Neon serverless driver; the app uses a `pg` Pool per ADR-008. |
| 9   | **Service-worker tooling — decision point.** Install `@serwist/turbopack`, wrap the config, add the route handler and a stub worker. Exit criteria in §6.                                                                                                                    |
| 10  | **Cache rules + offline shell.** Pure predicates, then the runtime rules of §7 and a `/~offline` fallback. Caches are cleared on sign-out. Note what rules 3–4 do and do not buy (§7.1): offline content loading **already works** via `modules/content/load.ts`'s own Dexie fallback; the rules bound latency and add a second independent layer, they are not what makes offline content possible. |
| 11  | **Registration + kill switch + install hint.** Mounted in `app/layout.tsx` so auth pages are covered. Disabled under `next dev`, so the four existing Playwright configs are behaviourally untouched. `NEXT_PUBLIC_SW_ENABLED=false` **unregisters and clears caches** — that is what makes `DEPLOYMENT.md` §8's "unregister SW" rollback real rather than aspirational. iOS has no `beforeinstallprompt`, so the hint shows Share → Add to Home Screen. |
| 12  | **Offline + WebKit E2E — the proof.** §8.                                                                                                                                                                                                                                   |
| 13  | **Backups + restore drill.** §9. Explicitly includes rewriting **`docs/DEPLOYMENT.md` §7**: the quarterly drill cadence, the `age` private key's two-independent-copies requirement, and correcting its stale "Restore drill at Phase 22" line (this phase absorbs that slice). The commitments must live in the ops doc a human opens during an incident, not only in this one. |
| 14  | **Docs sweep + full gate**, then the council and a draft PR.                                                                                                                                                                                                                |

### 5.1 Which layer tests which slice

`docs/TEST_STRATEGY.md` describes a pyramid with distinct unit, component,
integration and E2E layers, and a phase is expected to say which of them covers
each new surface rather than leaving a reviewer to infer it. This phase's
commitment, slice by slice:

| Slice                              | Unit                                                                                                     | Component                                              | Integration (Postgres)                                                        | E2E                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 2 identity classifier              | table-driven over every row of §2 — valid id, `isPending`, `error == null`, 401, network reject, 5xx, 503 | —                                                      | —                                                                             | —                                                       |
| 3 last-known owner                 | remember / read / forget; corrupt or over-length value rejected; throwing `localStorage`; no-`window`     | —                                                      | —                                                                             | —                                                       |
| 4 wire the fix                     | —                                                                                                        | both hooks: offline cold boot, genuine guest, forget-on-sign-out and on deletion | —                                                                             | slice 12 step 3 (the regression proof)                  |
| 5 honest status offline            | —                                                                                                        | provider: controller exists under `unknown`; no merge offer; `pagehide` flush | —                                                                             | offline status in the header                            |
| 6 sign-up allowlist + ceilings     | env parsing and the production ceilings                                                                  | —                                                      | allowlisted registers / non-allowlisted refused, against real Better Auth     | its own Playwright config (port 3104)                   |
| 7 icons, manifest, viewport        | manifest shape; generator determinism                                                                    | —                                                      | —                                                                             | installability criteria (§10)                           |
| 8 deploy readiness                 | header set; precondition script fails on an incomplete env                                               | —                                                      | —                                                                             | —                                                       |
| 9 SW tooling                       | —                                                                                                        | —                                                      | —                                                                             | build-output assertions of §6                           |
| 10 cache rules + offline shell     | predicate table over every route class, including "no `/api` URL matches any caching rule"                | —                                                      | —                                                                             | offline suite                                           |
| 11 registration + kill switch      | register / unregister / clear-caches branches; dev no-op; iOS vs Chromium hint                            | —                                                      | —                                                                             | the four existing configs stay green (no dev-mode change) |
| 12 offline + WebKit                | —                                                                                                        | —                                                      | —                                                                             | the whole journey, both projects                        |
| 13 backups                         | restore script refuses a non-test database name                                                          | —                                                      | —                                                                             | —                                                       |

A dash means "deliberately not covered at that layer", not "forgotten".

## 6. Slice 9 exit criteria (the decision point)

All four must hold, observed and not inferred:

1. `pnpm build` emits `/serwist/sw.js`.
2. `__SW_MANIFEST` is non-empty **and** contains `_next/static` chunks — an
   empty manifest that still builds is the failure mode that looks like
   success.
3. `NODE_ENV=test next start` serves the worker with `Service-Worker-Allowed:
/`.
4. The client bundle under `NODE_ENV=test` is a genuine **production** React
   build. Evidence is **paired**, because an absence-only check silently stops
   discriminating the day React renames its markers: assert a React
   development-only string is **absent** _and_ that a known production-only
   marker is **present**. The assertion carries a comment naming both strings
   and stating that a React major upgrade requires re-validating them.

Any failure → hand-written runtime-caching service worker + **ADR-010**
recording why the Serwist choice was departed from.

If criterion 4 fails specifically, the fallback is a **localhost-only**
`ALLOW_INSECURE_URLS_IN_PRODUCTION`-shaped escape hatch modelled on the
existing `ALLOW_DEV_EMAIL_TRANSPORT_IN_PRODUCTION` in `modules/env/server.ts`
— never a blanket relaxation.

## 7. Runtime cache rules

Written explicitly; `defaultCache` is never imported (§4).

| Route class                          | Strategy                       | Why                                                                                        |
| ------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------ |
| `/api/**`                            | **NetworkOnly**                | Authenticated learner data. Never cached, so nothing survives sign-out that shouldn't.      |
| `/_next/static/**` (incl. `woff2`)   | CacheFirst, 1 year             | Content-hashed and immutable by construction; includes the Arabic font faces.               |
| `/content/active.json`               | NetworkFirst, 3s timeout       | The release pointer. Must be fresh when possible, must not hang the app when it isn't.      |
| `/content/releases/*/learner.json`   | CacheFirst, keep 3             | Immutable per release; three is enough for the current release plus a rollback and a spare. |
| RSC payloads                         | NetworkFirst                   | Navigation data; stale is acceptable, missing is not.                                       |
| Documents (navigations)              | precache → NetworkFirst        | With `/~offline` as the fallback for anything genuinely uncached.                           |
| `/manifest.webmanifest`, `/icons/**` | CacheFirst                     | Unhashed `public/` paths, so **not** covered by the `/_next/static/**` rule. Slice 10 asserts they are in the emitted precache manifest; if they are not, this explicit rule is what covers them. Without it the offline install hint can render a broken icon, and §10's "every declared icon URL is reachable" would only ever be true online. |

### 7.1 What the content rules actually buy — stated precisely

It would be wrong to say rules 3–4 are what let the app load content offline.
They are not. `modules/content/load.ts` already falls back on **every** failure
path (`pointer-unavailable`, `download-failed`, `checksum-mismatch`,
`invalid-release`, `pointer-mismatch`) to `fallbackToVerifiedCache` →
`readVerifiedActiveCachedRelease`, which reads and re-verifies a previously
cached release straight out of Dexie. That path predates this phase, needs no
service worker, and is populated by exactly the same successful online fetches a
runtime cache would be. **Offline content loading already works.**

What the two rules genuinely add:

1. **A latency bound.** `fetchActiveReleasePointer` and
   `fetchLearnerReleaseText` pass no `AbortSignal` and set no timeout, so on a
   connection that is degraded rather than absent they can hang for as long as
   the platform allows before the Dexie fallback is ever reached. Rule 3's 3s
   NetworkFirst timeout is what turns that hang into a fast, correct answer.
2. **A second independent layer**, at a different level of the stack, for the
   case where the Dexie copy is missing or fails verification.

Recording this matters because it changes what a future regression means: a
broken cache rule degrades latency and redundancy, it does not take the app
offline-hostile. Debugging should start at `load.ts`, not at the worker.

## 8. Required proof (slice 12)

A new Playwright config on port 3105 running `pnpm build && pnpm start` under
`NODE_ENV=test`, with **Pixel 7** and **iPhone (WebKit)** projects. Under
`next dev` there is no service worker at all, so this cannot be folded into an
existing config.

The journey:

1. Study online while signed in.
2. Cold-boot **offline in a new page** (not a reload of a warm page).
3. Assert the account's due cards render **and** that newly written rows in the
   **client's IndexedDB** carry `ownerKey = "account:<id>"`. **This is the
   regression test for §2** and is the phase's single most important assertion.
   It must be made client-side, through the existing `e2e/helpers/idb.ts` probe
   (`idbAll` / `idbCount`, keys built with `e2eAccountOwnerKey`) — extend that
   helper if it lacks something, never reimplement one (CLAUDE.md, `e2e/`
   conventions). A server-side `db-probe` assertion alone would **not** prove
   this defect fixed: the whole failure is a client-side mis-stamping, and rows
   stamped `guest` never reach the server at all.
4. Assert no guest-merge dialog appears.
5. Study offline; reload offline; the queue survives.
6. Reconnect; verify server state.

Plus: checksum-mismatch recovery, a route never visited online, and the
installability criteria of §10.

The 28–32px header controls are raised to a 44px hit area **via padding only**
— no visual change to the icons themselves.

## 9. Backups (slice 13)

Daily `pg_dump --format=custom` against Neon's **direct** endpoint (the pooled
endpoint does not support everything a dump needs), with a PG17 client,
**`age`-encrypted to a public key** so that a compromised Actions token can
exfiltrate nothing readable, size-guarded against silent empty dumps, retained
30 days.

The restore script is **name-guarded** exactly like `db/reset-test-database.ts`
— it refuses to restore over anything whose database name does not match the
disposable-test pattern.

**Artifacts alone are not offsite.** A monthly manual pull is documented as a
human step; a backup that lives only in the same account as the thing it backs
up is a partial backup.

Two things follow from that same reasoning and are easy to leave out:

- **The decryption key needs the redundancy the dumps get.** Every retained
  artifact is encrypted to one `age` keypair. A lost private key voids all 30
  days at once, silently, and the failure is only discovered during the incident
  that needed the restore. So: the private key is stored in a password manager
  that is itself backed up, **plus** one independent offline copy kept
  physically elsewhere. Encrypting to two recipients is an acceptable
  alternative. What is not acceptable is a single copy on the same laptop that
  runs the app. **Slice 13 writes this into `DEPLOYMENT.md` §7** — see below.
- **A restore proved once is not a restore path.** The drill at H5 proves it at
  t=0, against the schema of the day. Migrations accumulate and the
  `pg_dump`/`pg_restore`/`age`/PG17-client toolchain drifts. The commitment is a
  **quarterly** drill, and additionally after any migration that is not purely
  additive.

Both of those belong in the operations doc, not only in a phase-history doc:
`DEPLOYMENT.md` is what `CLAUDE.md`'s document map names as the authority on
backups, and it is what a human actually opens during an incident. So **slice 13
rewrites `docs/DEPLOYMENT.md` §7** to carry the cadence and the key-redundancy
requirement, and to correct its existing "**Restore drill at Phase 22**" line —
this phase absorbs that slice, so Phase 22 is now the wrong reference. Until
that edit lands, §7 still says the old thing; nothing here should be read as
claiming otherwise.

## 10. Installability verification, and the Lighthouse problem

The Phase 18 testing checkpoint in `IMPLEMENTATION_PHASES.md` says "Lighthouse
PWA installability pass". **Lighthouse removed the PWA category in v12**, so
that checkpoint as written is no longer automatable by any current Lighthouse
version. Rather than pretend otherwise, this phase substitutes the explicit
criteria Lighthouse used to assert, checked directly in Playwright:

- `/manifest.webmanifest` returns 200 and parses as JSON.
- It declares `name`, `short_name`, `start_url` and `display`.
- It declares at least one icon ≥192px and one ≥512px, and every declared icon
  URL is reachable.
- A service worker is registered and has a `fetch` handler.
- The page is a secure context.

Plus **one manual DevTools check** at H4 (below), which is where a real install
is being done anyway.

## 11. Knowingly not done

- **No Content-Security-Policy.** Next's inline bootstrap script plus the
  `worker-src` a service worker needs make a correct, non-`unsafe-inline`
  policy real work with a real chance of breaking the app subtly. It is left to
  Phase 22 honestly, rather than shipped as a permissive policy that reads like
  protection.
- **`modules/profile/export.ts` stays write-only.** `SafwaDataExport` has zero
  consumers; there is no importer. An importer is a separate feature, and the
  `pg_dump` chain is the real restore path. The asymmetry is recorded in
  `docs/RISK_REGISTER.md` so the export button is never mistaken for a backup.
- **No push notifications.** Out of scope for every prior phase and this one.

## 12. Human prerequisites

These cannot be done from inside the repository.

| #   | When                  | Action                                                                                                                                                                                                                     |
| --- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | before slice 8 lands  | Create the Neon project; copy **both** connection strings (pooled → `DATABASE_URL`; **direct** → migrations and `pg_dump`). Create the Vercel project with its region matched to Neon's. Generate a `BETTER_AUTH_SECRET` of ≥32 characters. |
| H2  | before slice 8        | **Resend.** Email is a _hard_ dependency here: `requireEmailVerification: true`, and an unverified account cannot sync. Send one test email first. `onboarding@resend.dev` may reach your own address without domain verification — verify that against current Resend terms rather than assuming it. |
| H3  | after the PR merges   | Set the Vercel environment variables (including `SIGNUP_ALLOWED_EMAILS` and `NEXT_PUBLIC_SW_ENABLED`); run the `deploy-migrate` workflow **before** first traffic; register the account and verify the email.               |
| H4  | after slice 12        | **Real-device drill.** Install on iPhone (Share → Add to Home Screen) and on Android Chrome. Airplane mode → open from the home screen → complete a flashcard and an MC session → reconnect → confirm server state. Do the one manual DevTools installability check here. |
| H5  | after slice 13        | Add the secret `PRODUCTION_DATABASE_URL_DIRECT` and the variable `BACKUP_AGE_PUBLIC_KEY`. Keep the `age` **private** key off GitHub entirely, and store it in **two** independent places per §9 (backed-up password manager + one offline copy elsewhere) — one copy is a single point of failure for every backup at once. Run the restore drill and record the output; **repeat quarterly**, and after any non-additive migration. |
| H6  | after the PR merges   | Add the new **"E2E (offline + WebKit)"** job to branch protection on `main`.                                                                                                                                               |

## 13. Verification

- **Gate:** `scripts/quality-gate.ps1` exit 0, all 19 steps including E2E. It is
  run as two foreground calls, because the single full invocation exceeds this
  environment's background-task limit:

  ```powershell
  powershell -File scripts/quality-gate.ps1 -SkipE2E
  $env:CI = "1"; pnpm test:e2e
  ```

  **`CI=1` on the second call is not optional.** The gate script sets it
  internally (`quality-gate.ps1` line 92) precisely because every Playwright
  config reads it: `reuseExistingServer: !process.env.CI` means that without it
  the E2E half can silently attach to a **stale `next dev` server** from another
  checkout and report green for code it never ran — the exact failure the script
  exists to prevent. It also restores `forbidOnly` and the CI retry count.
  Splitting the gate must not quietly drop the semantics that make its E2E step
  meaningful.
- **The identity fix** is proven by `e2e/offline.spec.ts` step 3, not by unit
  tests alone.
- **CI:** the new offline/WebKit job runs **in parallel** with "E2E (Chromium)"
  so wall-clock does not grow. WebKit runs the offline/PWA suite _only_ — it
  does not multiply the other spec files.

## 14. Acceptance criteria

1. An offline cold boot while signed in resolves the **account** owner, renders
   the account's due cards, writes rows stamped `account:<id>`, and does not
   offer a guest merge.
2. The app is installable: manifest, icons and a registered service worker with
   a `fetch` handler, verified by the explicit criteria of §10.
3. A full flashcard and MC session can be completed with no network, survives a
   reload, and syncs on reconnect.
4. `/api/**` is never served from a cache.
5. Sign-out clears the service-worker caches as well as local state.
6. `NEXT_PUBLIC_SW_ENABLED=false` unregisters the worker and clears its caches.
7. Production environment validation fails closed when `SIGNUP_ALLOWED_EMAILS`
   is unset, and rejects rate-limit values above the production ceilings.
8. A daily encrypted backup workflow exists, is size-guarded, and its restore
   path is name-guarded and documented — including the decryption key's own
   redundancy and a **recurring** (quarterly) drill cadence, both recorded in
   `docs/DEPLOYMENT.md` §7 rather than only in this phase doc.
9. `scripts/quality-gate.ps1` exits 0 with E2E included, and the new
   offline/WebKit config is green on both projects.
