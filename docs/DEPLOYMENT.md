# Safwa — Deployment & Operations

Status: planning baseline (Architecture Plan v4, approved 2026-07-14).
**All pricing/free-tier statements below are assumptions as of planning time
(2026-07) — verify current terms at Phase 22 before relying on them.**

## 1. Local development setup

- Node LTS + pnpm; Python 3.10+ for the data scripts.
- Postgres (implemented Phase 15): `docker compose up -d db` starts a pinned
  `postgres:17-alpine` container (`compose.yaml`) with a `safwa_dev` database
  for `pnpm dev` and a sibling disposable `safwa_test` database (created once,
  on first container init, by `docker/init-test-db.sql`) that integration
  tests and `scripts/quality-gate.ps1` reset freely. A Neon development
  branch works equally well for `safwa_dev` — only `safwa_test`'s local
  reset/truncate path requires the exact-name safety pattern below.
- `pnpm install` → `pnpm db:migrate` → `pnpm content:build` → `pnpm dev`.
- Email in development uses the console/file transport (writes JSON files to
  `EMAIL_OUTBOX_DIR`, default `.local/email-outbox` — no external sends);
  `pnpm email:clear-outbox` clears it (refuses in production).
- `python scripts/validate-vocabulary.py` must pass before building content.
- `scripts/quality-gate.ps1` (Phase 15, T22) runs every check CI runs,
  locally, in the same order — including the disposable-Postgres steps
  below — and is the recommended pre-review/pre-commit gate; `-SkipE2E` is
  for fast inner-loop iteration only, the full gate (including E2E) must
  still pass before review.

## 2. Environment variables

| Variable                                                                 | Purpose                                                                                                        | Envs                                      |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `DATABASE_URL`                                                           | Postgres connection (Neon pooled URL in prod)                                                                  | all                                       |
| `NODE_ENV`                                                               | `development \| test \| production`                                                                            | all (set by tooling, rarely by hand)      |
| `BETTER_AUTH_SECRET`                                                     | session/token signing                                                                                          | all (unique per env)                      |
| `BETTER_AUTH_URL` / `NEXT_PUBLIC_APP_URL`                                | canonical origin                                                                                               | all                                       |
| `NEXT_PUBLIC_SW_ENABLED`                                                 | service-worker kill switch — unset = on in production builds only; `false` unregisters and clears caches (§8a) | all (normally unset)                      |
| `AUTH_ENABLED`                                                           | auth feature-flag kill-switch (default `true`)                                                                 | all                                       |
| `AUTH_RATE_LIMIT_WINDOW_SECONDS` / `AUTH_RATE_LIMIT_MAX`                 | sensitive-endpoint rate-limit tuning (default 60s/5)                                                           | all — see caveat below                    |
| `AUTH_RATE_LIMIT_DEFAULT_WINDOW_SECONDS` / `AUTH_RATE_LIMIT_DEFAULT_MAX` | default rate-limit bucket tuning (default 10s/100, matches Better Auth's own built-in default)                 | all — see caveat below                    |
| `EMAIL_TRANSPORT`                                                        | `console-file` (dev/test) \| `resend` (preview/prod)                                                           | all                                       |
| `EMAIL_OUTBOX_DIR`                                                       | console-file transport's output dir (default `.local/email-outbox`)                                            | dev/test only                             |
| `RESEND_API_KEY`                                                         | transactional email                                                                                            | preview/prod (dev uses console transport) |
| `EMAIL_FROM`                                                             | verified sender                                                                                                | preview/prod                              |
| `ALLOW_DEV_EMAIL_TRANSPORT_IN_PRODUCTION`                                | explicit escape hatch for `console-file` in production (default `false`)                                       | prod only, exceptional                    |
| `SIGNUP_ALLOWED_EMAILS`                                                  | comma-separated addresses permitted to register — **required in production**                                   | all (unset outside prod = sign-up open)   |
| `SENTRY_DSN`                                                             | error monitoring                                                                                               | preview/prod                              |
| `CONTENT_SERVER_DIR` / storage binding                                   | assessment+validation manifests location                                                                       | all                                       |
| `ADMIN_BOOTSTRAP_EMAIL`                                                  | first admin promotion (one-shot)                                                                               | prod                                      |

Secrets live only in Vercel/Neon dashboards and local `.env.local`
(gitignored). `.env.example` documents every variable without values.

**Rate-limit tuning variables — production bounds (Phase 15, enforced in
Phase 18).** Local development, CI and the E2E suite each tune these for their
own purposes; the E2E suite's main server really does set the default bucket to
a very permissive `100000` max so legitimate parallel test traffic never trips
it (`e2e/helpers/e2e-server-env.ts`). Phase 15 could only warn about that in
prose. `modules/env/server.ts`'s `assertProductionInvariants()` now enforces it:
with `NODE_ENV=production`, each variable must fall inside its bound or
validation throws, so an E2E- or CI-tuned `.env` is structurally unable to reach
production rather than merely discouraged from it.

| Variable                                 | Production bound | Default | What the bound is for                                                                                                     |
| ---------------------------------------- | ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_RATE_LIMIT_MAX`                    | 1–20             | 5       | security — the sensitive-endpoint bucket (sign-in, sign-up, reset, delete)                                                |
| `AUTH_RATE_LIMIT_WINDOW_SECONDS`         | 30–3600          | 60      | floor is security (a 1s window empties faster than an attacker is slowed); ceiling is availability (an hour-long lockout) |
| `AUTH_RATE_LIMIT_DEFAULT_MAX`            | 1–1000           | 100     | security — the read-mostly bucket (get-session and friends), which needs real headroom                                    |
| `AUTH_RATE_LIMIT_DEFAULT_WINDOW_SECONDS` | 5–3600           | 10      | as above; Better Auth's own default window is 10s                                                                         |

The shipped defaults sit inside every bound, so a production deployment that
sets none of these four variables starts normally.

**When these checks actually run — and what that means for a deploy.**
`getServerEnv()` validates LAZILY, on first use, not at process boot
(`modules/env/server.ts`'s own docblock explains why: guest-only pages must
never pay for or fail on server-env validation). So a misconfigured production
deployment does **not** refuse to start in the conventional sense. It comes up,
and the first request that touches auth/db/email throws. Two consequences:

- **Gate the rollout on `GET /api/health`**, which already wraps
  `getServerEnv()` and reports 503/unhealthy on exactly this failure. That is
  the runtime signal that a config is bad, and it is only useful if the
  platform's traffic cutover waits for it.
- **Prefer catching it before the deploy**, with `pnpm deploy:verify`
  (`scripts/verify-deploy-preconditions.ts`, Phase 18) rather than in
  production. It reads the same variables production will see and reports
  every problem at once: missing required variables, a non-https origin, a
  short signing secret, an unset sign-up allowlist, any of the four rate
  limits outside its production bound, and an email transport that would
  write verification links to a local directory instead of sending them. It
  opens no connection and sends no email, so it is safe to run anywhere, and
  it never echoes a value — only the name of the variable and what is wrong
  with it. It is wired into `vercel.json`'s `buildCommand`, so a
  misconfigured deployment fails at build rather than on first request, and
  into `deploy-migrate.yml` before any migration runs.

  The rules it enforces are not a second copy: `modules/env/rules.ts` holds
  the bounds, the minimum secret length, the Postgres URL shape and the
  boolean-parsing rule once, and both this script and `modules/env/server.ts`
  import it. That module is dependency-free and carries no `server-only`
  marker precisely so a script that must run _without_ a valid environment can
  still read it. `tests/unit/deploy-preconditions.test.ts` goes further and
  drives the **real** runtime validator over a table of environments,
  asserting the pre-deploy check is never the more permissive of the two — so
  a variable that becomes required in the schema cannot silently stop being
  checked here.

  It distinguishes **failures** from **warnings**. Failures fail the build.
  The one warning today is `ALLOW_DEV_EMAIL_TRANSPORT_IN_PRODUCTION=true`,
  which the runtime permits outright: making it fatal here would mean the
  documented escape hatch could never get a build through the gate — an escape
  hatch that blocks the thing it exists to allow. It is printed loudly and
  does not stop the deploy.

  Note that preview deployments run the same check, and that is intended: a
  preview with sign-up open is the same bug as production with sign-up open.
  Give the preview environment its own values, not none.

**Sign-up is closed by default in production (Phase 18).**
`SIGNUP_ALLOWED_EMAILS` must list at least one address when
`NODE_ENV=production`; an unset or blank value is refused by the same
validation. Safwa is a personal instance whose production URL is reachable by
anyone who finds it, so an unset allowlist would mean "anyone may create an
account", and every account costs metered Neon rows and Resend sends. The
requirement holds even with `AUTH_ENABLED=false` — that kill-switch is a
temporary rollback position, and flipping it back on must not be the moment
sign-up silently opens.

Matching is case-insensitive and exact: `owner+tag@example.com` does **not**
match an allowlisted `owner@example.com`, so list any alias you actually use.
A refused registration gets a 403 whose body is identical for every refused
address, so the response cannot be used to probe the list. Registration is the
only gated action — existing accounts sign in normally, including one whose
address you later remove from the list.

One thing the allowlist deliberately does **not** hide: an address that IS on
the list and already has an account gets Better Auth's ordinary "an account
with that email already exists", not the uniform refusal. Someone who has
already guessed the exact allowlisted address can therefore learn whether it is
registered. That is accepted rather than overlooked — unifying the two would
mean the legitimate owner is told "not accepting new accounts" when the real
answer is "you already have one, sign in" — and it is narrower than the
pre-Phase-18 behaviour, where the same signal was available for every address
rather than only the listed ones.

## 3. Hosting recommendation

| Component               | Choice                                                                                    | Assumption / note                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Web app + API           | **Vercel**                                                                                | Hobby tier suffices pre-launch for a free educational app; upgrade trigger: team members, higher limits, or commercial terms      |
| Database                | **Neon Postgres**                                                                         | free tier assumed adequate at low usage; **`pg` Pool over TCP, not the Neon serverless driver** (see below); PITR window per plan |
| Static content releases | shipped with the app (`public/content/`) or Vercel Blob later                             | releases are small (hundreds of KB)                                                                                               |
| Server manifests        | bundled server-side at build (Stage 1); DB/Blob after Phase 21                            | must never be publicly served from `public/`                                                                                      |
| Email                   | **Resend**                                                                                | free tier assumed ~100 emails/day — enough for verification/reset at launch scale                                                 |
| Scheduled tasks         | none required for MVP; Vercel Cron if needed (pending-parent TTL sweep, activity rollups) |                                                                                                                                   |
| Push notifications      | deferred post-MVP; web-push via a small worker + VAPID when added                         | iOS constraints documented in `OFFLINE_AND_SYNC.md`                                                                               |

**Expected low-usage cost: ~~$0–5/month** (assumption). Upgrade points:
Vercel Pro (~$20/mo) for limits/analytics; Neon paid (~~$19/mo) for more
storage/compute/PITR; Resend paid at volume.

**Lock-in assessment:** standard Next.js + Postgres + SQL migrations —
portable to any Node host + managed Postgres. Vercel-specific surface is
limited to config and (if adopted) Cron/Blob; Better Auth and Drizzle are
self-hosted libraries; Resend sits behind the email adapter.

**Database driver — corrected in Phase 18.** This table claimed the app talks
to Neon through its serverless (HTTP/WebSocket) driver. It does not, and never
has: `db/client.ts` uses `drizzle-orm/node-postgres` over a `pg` Pool on a
plain TCP connection, which is the choice ADR-008 records and the reason the
pooled and direct Neon endpoints are different URLs with different uses. Two
things follow, and both were left implicit while the claim stood:

- **`DATABASE_URL` must be Neon's POOLED endpoint** for the app. A `pg` Pool
  per serverless instance, multiplied by concurrent instances, is exactly the
  connection-exhaustion shape PgBouncer exists to absorb.
- **Migrations and `pg_dump` must use the DIRECT endpoint.** PgBouncer in
  transaction mode does not support session-level state, some DDL, or advisory
  locks, and the resulting failure is partial rather than clean.
  `.github/workflows/deploy-migrate.yml` therefore reads
  `PRODUCTION_DATABASE_URL_DIRECT`, not the pooled URL the app uses.

**Region.** Set the Vercel function region to match the Neon project's region
when creating the project (H1). It is deliberately not pinned in `vercel.json`:
a wrong hardcoded region is worse than an unset one, since it silently adds a
round trip to every query. Record the chosen region here once it exists.

## 4. Environments

- **development** — local; console email; local/branch DB.
- **preview** — per-PR Vercel deployments; Neon branch per preview (or a
  shared preview DB with migration gating); dev email transport or Resend
  test mode; noindex.
- **production** — protected branch deploys only; migrations applied before
  traffic (see §5).

## 5. Database migrations

- Drizzle SQL migrations committed with the phase that introduces them;
  additive-first policy (`DATA_MODEL.md` §12).
- CI runs the full migration chain against a disposable Postgres on every PR
  (implemented Phase 15, T21): `.github/workflows/ci.yml`'s `quality` and
  `e2e` jobs each run their own pinned `postgres:17-alpine` service
  container with test-only, disposable credentials (never reused from any
  real deployment secret) and a health check gating job start; `quality`
  applies the full migration chain and registers content versions before
  running the database-constraint + auth-integration suite.
  `scripts/quality-gate.ps1` (T22) runs the equivalent sequence locally
  against a developer's own `docker compose`-provisioned `safwa_test`
  database. **`compose.yaml` (local dev) and the CI service container
  (`ci.yml`) must be kept manually in sync** — there is no shared
  single-source-of-truth for the Postgres version/config between the two;
  a future refactor could extract a shared compose/service definition if
  this drifts in practice.
- Production: apply migrations as a deploy step _before_ promoting the build;
  destructive migrations require a documented plan + fresh backup + rollback
  note.
- **How, concretely (Phase 18):** run the **Deploy migrations** workflow
  (`.github/workflows/deploy-migrate.yml`) by hand from the Actions tab, typing
  the confirmation phrase. It is `workflow_dispatch` only — an automatic
  migration on push means a schema change ships whenever someone merges, at
  whatever moment CI finishes, with nobody deciding that now is a good time to
  alter the database holding the only copy of a learner's history. It runs
  `pnpm deploy:verify` first, then takes a **restore point** (below), then
  `pnpm db:migrate`, then (by default)
  `pnpm db:register-content`, all against the **direct** Neon endpoint from
  `PRODUCTION_DATABASE_URL_DIRECT`. Its concurrency group has
  `cancel-in-progress: false`: making a second run wait is always better than
  interrupting a migration mid-transaction.
  Content registration is not optional before first traffic — every session
  the server stores carries a `release_id` foreign key into `content_versions`,
  so without it the first authenticated push fails at the database and
  presents to the user as "sync is broken".
- **The restore point is taken by the workflow, and it fails closed.** Before
  `pnpm db:migrate` runs, the workflow creates a Neon branch named
  `pre-migrate-<run-id>-<attempt>` through the Neon API. Without `NEON_API_KEY`
  (secret), `NEON_PROJECT_ID` and `NEON_PRODUCTION_BRANCH_ID` (variables)
  configured on the `production` environment, the run stops there and nothing
  is migrated — recoverability is not left resting on an unenforced note in
  this document, nor on Neon's plan-dependent PITR window.

  A branch rather than a `pg_dump` uploaded as a workflow artifact: branches
  are copy-on-write, so it costs seconds and moves no data, and a dump of this
  database contains verified email addresses, password hashes and live session
  tokens — not something to place in artifact storage every repository reader
  can download. To recover, point `DATABASE_URL` at the branch's endpoint, or
  restore it over the primary from the Neon console.

  **`NEON_PRODUCTION_BRANCH_ID` is not optional and not cosmetic.** Neon's API
  documents that a branch created without a parent forks from _the project's
  default branch_, which is not necessarily the one
  `PRODUCTION_DATABASE_URL_DIRECT` addresses. Unpinned, the call would still
  return 201 and the run would still print a restore-point line, having
  snapshotted the wrong database — a failure nothing in the run's output could
  reveal. Take the id from the Neon console (Branches → the production branch →
  `br-…`).

  **The branch expires after 14 days**, set on the branch itself via Neon's
  `expires_at`, so copies of production do not accumulate in the project one
  per migration. Long enough that a bad migration found a week later is still
  recoverable; past that horizon the scheduled encrypted dump (§7) is the
  backup. If the API rejects the expiry — most likely the plan not offering the
  feature — the run **warns and continues**, because the restore point itself
  already exists and blocking a migration over housekeeping would trade a real
  guarantee for a lesser one. In that case the job summary says
  `NO EXPIRY SET`, and deleting the branch is manual. Either way both the
  success summary and the failure runbook name the branch, because the run an
  operator is already looking at is the only reliable place to be reminded.

- **What it needs configured**, all on the `production` GitHub Environment
  (Settings → Environments → production), not as bare repository secrets — the
  environment binding is what makes required reviewers possible at all:

  | Kind     | Name                               | Value                                                          |
  | -------- | ---------------------------------- | -------------------------------------------------------------- |
  | secret   | `PRODUCTION_DATABASE_URL_DIRECT`   | Neon **direct** endpoint (§3)                                  |
  | secret   | `PRODUCTION_BETTER_AUTH_SECRET`    | the production signing secret                                  |
  | secret   | `PRODUCTION_SIGNUP_ALLOWED_EMAILS` | comma-separated allowlist (§2)                                 |
  | secret   | `PRODUCTION_RESEND_API_KEY`        | Resend API key                                                 |
  | secret   | `NEON_API_KEY`                     | Neon personal/project API key, for the restore point           |
  | variable | `NEON_PROJECT_ID`                  | Neon project id the branch is created in                       |
  | variable | `NEON_PRODUCTION_BRANCH_ID`        | `br-…`, the branch the snapshot forks FROM (see above)         |
  | variable | `PRODUCTION_APP_URL`               | `https://…` — both `BETTER_AUTH_URL` and `NEXT_PUBLIC_APP_URL` |
  | variable | `PRODUCTION_EMAIL_FROM`            | e.g. `Safwa <noreply@…>`                                       |

  The allowlist is a secret rather than a variable because it is a list of
  personal email addresses, and repository variables are readable by anyone
  with read access.

- **The guardrail this workflow cannot give itself.** The typed confirmation
  phrase protects against a misclick and nothing else: its required text is
  printed in its own input description, so anyone who can run workflows can
  type it. **Configure "required reviewers" on the `production` GitHub
  Environment** (Settings → Environments → production). That is the only real
  second pair of eyes, and it lives in repository settings where no file in
  this repo can assert it. If a second approver is impractical for a single
  maintainer, set a wait timer instead and record that here as the accepted
  compensating control.

### 5a. Response headers (Phase 18)

`next.config.ts` applies five headers to every response. Four are new in Phase
18; `Referrer-Policy` predates it.

| Header                      | Value                              | Why                                                                                                      |
| --------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `Referrer-Policy`           | `strict-origin-when-cross-origin`  | verification / password-reset / delete-account links carry a single-use secret in the URL (Phase 17 §11) |
| `X-Content-Type-Options`    | `nosniff`                          | `/content/*.json` is same-origin learner data; a sniffed JSON response is the classic path to script     |
| `X-Frame-Options`           | `DENY`                             | nothing here is meant to be framed, and the authenticated surfaces are what clickjacking targets         |
| `Permissions-Policy`        | capabilities denied (see the file) | the app uses no camera/mic/geolocation; deny them so a future dependency cannot quietly start asking     |
| `Strict-Transport-Security` | `max-age=63072000`                 | two years, **no `preload`, no `includeSubDomains`** — see below                                          |

**No Content-Security-Policy, deliberately.** A correct CSP for the App Router
needs a per-request nonce threaded through middleware (Next inlines a bootstrap
script and streams RSC payloads) plus a `worker-src` that survives the service
worker arriving in slice 9. Without that work the only policies that "work" are
ones asserting nothing — `unsafe-inline` everywhere — which is worse than none,
because it looks like coverage. Phase 22 owns it. This is recorded rather than
silently omitted so no future reader assumes protection that was never there.

**HSTS is not preloaded, and that is a decision.** Preloading is effectively
irreversible: browsers ship the list in their binaries, and removal takes
months. Committing the apex and every future subdomain to HTTPS-only before a
single production request has been served is a promise made too early. The
`max-age` is the protection; the list can be joined later, deliberately.

`tests/unit/next-config.test.ts` asserts all of the above, including the two
absences — adding a CSP or a `preload` directive fails a test whose comment
explains what to reconsider first.

### 5b. Serverless file tracing (Phase 18)

Four routes read content-release artifacts from the filesystem at request time:
`/api/health`, `/api/sync/push`, `/api/sync/pull`, `/api/sync/guest-merge`.
They read `content-server/release-registry.json`, each release's
`validation.json` / `assessment.json` / `checksums.json`, and the public
`learner.json` — every path built at **runtime** from a release id, never a
static import, so `@vercel/nft` has nothing in the module graph to infer them
from.

It has worked so far only because the tracer is generous. When it stops being
generous the failure is not a build error: the deploy succeeds and the route
answers 503 to real traffic. `next.config.ts`'s `outputFileTracingIncludes`
pins `content-server/**` and `public/content/**` onto those four routes.

`public/**` needs pinning despite being served by the CDN. Vercel uploads it as
static assets, which is a different thing from placing it inside a function's
bundle where `readFile(process.cwd() + "/public/content/...")` can reach it.

**A fifth route that reaches those loaders must be added to that list.** That
obligation is enforced, not merely written down, by three checks that fail in
different ways:

1. `scripts/content-route-graph.ts` walks the import graph from every `app/**`
   route and page — through barrels, dynamic imports and the layout chain — to
   the modules that touch the filesystem, and `tests/unit/next-config.test.ts`
   fails if the derived set and the committed config disagree in either
   direction.
2. The same file's `findFilesystemReaders()` scans the tree for filesystem
   reads — any read, not reads of a recognised content path — and the test
   asserts the result matches the leaf list the walk searches for. Deriving
   the routes would otherwise just move the hand-maintained list one level
   down: a third loader module nobody registered would make a route reaching
   only it invisible to both sides. Keying on the read rather than the path
   is deliberate, so a loader that receives its directory through a
   generically-named parameter cannot slip past. The CLI trees (`scripts/`,
   `tools/`, `db/`) are skipped wholesale; a file that reads from disk without
   touching content and lives anywhere else goes in
   `NON_CONTENT_FILESYSTEM_READERS` with its reason — there is one today, the
   content builder, which sits in the same directory as the real loaders.
3. `pnpm routes:verify` (`scripts/verify-route-manifest.ts`) runs **after
   `pnpm build`**, in CI and as quality-gate step 19, and checks the config's
   keys against `.next/server/app-paths-manifest.json` — Next's own output.
   The first two checks compare two of our derivations with each other; only
   this one can catch both agreeing on a key Next does not recognise, which
   would pin nothing and produce no error at build time.

### 5c. The service worker's build dependency (Phase 18)

`pnpm sw:verify` is the second post-build check, quality-gate step 20 and a CI
step, and `modules/pwa/README.md` explains what it asserts. One deployment
consequence belongs here rather than there:

**The build now requires a native `esbuild` binary.**
`app/serwist/[path]/route.ts` pins `useNativeEsbuild: true` rather than taking
the package default, which is native on Windows and WebAssembly everywhere
else — a default that would have the worker bundled by one tool on the
authoring machine and a different one in CI and on Vercel. The cost of pinning
is that the whole build, not just the worker, fails on any platform with no
matching prebuilt binary for the resolved `esbuild` version.

That is the right failure (loud, at build time, on a platform change nobody
would otherwise notice), and both current build platforms — GitHub Actions
`ubuntu-latest` and Vercel — are well supported. **If the build platform ever
changes** — a different base image, an unusual architecture, a musl/Alpine
runner — check this first: the remedy is either an `esbuild` version with a
binary for that platform, or dropping the pin and accepting `esbuild-wasm`
there.

### 5d. The `Cache-Control` contract the service worker depends on (Phase 18)

Unlike §5a's headers, these are not set by `next.config.ts` — Next emits them
per route, and the service worker's confidentiality guarantee rests on them.
`modules/pwa/cache-policy.ts` stores a document or RSC response unless its
`Cache-Control` says `private` or `no-store`, which is what keeps
`/account`'s server-rendered name and email out of Cache Storage. Measured
against `pnpm start` on this build:

| Route class                       | `Cache-Control`                                           |
| --------------------------------- | --------------------------------------------------------- |
| prerendered (`/study`)            | `s-maxage=31536000` (plus `x-nextjs-prerender: 1`)        |
| dynamically rendered (`/account`) | `private, no-cache, no-store, max-age=0, must-revalidate` |

A missing header is treated as "no claim" and still caches — deliberately, with
the reasoning recorded at `isPrivateResponse`. `SERVER_RENDERED_CACHE_MAX_AGE_SECONDS`
(30 days) bounds whatever slips through.

**Verify this on the first production deploy, and after any change of host or
edge configuration.** The offline E2E asserts it against a local server; only
this checks the CDN in front of it, which is what can normalise a header away:

```bash
curl -sI https://<host>/account | grep -i '^cache-control'   # must contain private/no-store
curl -sI https://<host>/study   | grep -i '^cache-control'   # must NOT
```

If a signed-out `/account` redirects before rendering, sign in first and repeat
with the session cookie — the header on the redirect is not the one that
matters. If the dynamic route ever comes back cacheable, the service worker is
storing account markup: treat it as a live incident, not a docs drift.

## 6. Content seed / import process

- Stage 1: `pnpm content:build` runs in CI/build from the validated JSON;
  artifacts are versioned and immutable; the Python validator gates the
  build.
- Stage 2 (post-Phase 21): admin import CLI seeds Postgres content tables
  idempotently; publishing generates new immutable releases + manifests via
  the same pipeline. Old manifests are retained indefinitely
  (`OFFLINE_AND_SYNC.md` §8).

## 7. Backups & restore

Three independent mechanisms, covering three different losses. None of them
substitutes for another, and that is the point of listing them separately.

| Mechanism                                      | Covers                               | Does **not** cover                                               |
| ---------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------- |
| Neon PITR, within plan limits (assume 24h–7d)  | "I ran the wrong UPDATE an hour ago" | Losing the Neon project or account                               |
| Pre-migration Neon branch (§5, automatic)      | A bad migration                      | Anything not caused by a migration; it lives in the same project |
| **Daily encrypted `pg_dump` artifact** (below) | Losing the Neon project entirely     | Losing the GitHub account — see "not offsite"                    |

Content releases need no backup: they are reproducible from git-tracked JSON, and
the original transcription is the canonical evidence.

### The daily dump

`.github/workflows/backup.yml`, 03:17 UTC daily plus `workflow_dispatch`:

- `pg_dump --format=custom` against the **direct** Neon endpoint. The pooled
  endpoint does not support everything a dump needs and fails partially rather
  than cleanly (§2 records which URL goes where). Custom format because
  `pg_restore` can be selective with it during an incident — one table, schema
  only, reordered — which a plain SQL dump forecloses.
- A **PostgreSQL 17** client, installed from PGDG and version-asserted. `pg_dump`
  refuses to dump a server newer than itself, and the runner image ships an
  older client.
- **`age`-encrypted to a public key** (`BACKUP_AGE_PUBLIC_KEY`) before the file
  is uploaded anywhere; the plaintext is shredded in the same step. This is what
  makes an artifact acceptable at all: a dump holds verified email addresses,
  password hashes and live session tokens, and an artifact is downloadable by
  anyone with repository read access. A compromised Actions token gets
  ciphertext. The workflow refuses to run without a recipient key, and refuses
  outright if the variable holds a _private_ key (repository variables are not
  secrets).
- **Guarded against a silently empty dump** two ways: a byte floor, and a
  `pg_restore --list` check that the archive's table of contents actually
  contains `users`, `sessions`, `review_events`, `study_components` and
  `content_versions`. If either fails the run fails and keeps nothing — do not
  raise the floor to make it pass.
- Retained **30 days**.

**Until H5 (phases-18.md §12) is done, this workflow fails every night.** That is
deliberate. A backup that is not configured should be visible, and a run that
skipped itself quietly is indistinguishable from one that worked.

It runs against its own `production-backup` GitHub Environment, **not** the
`production` one §5 tells you to put required reviewers on. That is why: an
approval rule applies to scheduled runs too, so sharing the environment would
leave the 03:17 run waiting for an approval nobody is awake to give — and a
pending run is neither a failure nor a cancellation, so nothing would report it.
The consequence to keep in mind: **`PRODUCTION_DATABASE_URL_DIRECT` now exists in
two environments, and a rotation must update both.** Updating only `production`
leaves the backup on the old credential — still working if the old one was merely
rotated rather than revoked, and otherwise failing for a reason none of the
troubleshooting steps below name.

### An artifact is not offsite

The artifacts live in the same GitHub account as the repository that produced
them. A backup that shares a blast radius with the thing it backs up is a partial
backup. So: **once a month, download the latest encrypted artifact and store it
somewhere that is not GitHub and not the laptop that runs the app.** This is a
human step; nothing here can do it, and nothing will remind you.

**While you are on that screen, check the schedule is still alive.** GitHub
disables a scheduled workflow after **60 days with no repository activity** and
does not re-enable it. A disabled schedule produces no run, so there is no failed
check to notice — the one way this workflow goes silent rather than red. It is a
live risk here rather than a theoretical one: Phase 18 is the last implementation
phase, so long quiet stretches are the expected steady state, and with 30-day
retention 60 days of silence leaves no usable backup at all. So the monthly step
is really two:

1. Download the newest artifact and put it somewhere that is not GitHub.
2. Confirm there are successful runs from the **last few days**. If the newest run
   is weeks old, the schedule was disabled — re-enable it in the Actions tab and
   run it once by hand.

### Who can change where the backups go

`BACKUP_AGE_PUBLIC_KEY` is a repository **variable**, not a secret. Anyone who can
edit repository variables can point every future night's backup at a key **they**
hold, and the workflow will report success — it validates the key's shape, not its
identity. That is a lower bar than reading the database secret itself, so it is
worth naming: the encryption guarantee is "unreadable by whoever holds the
artifact", and it depends on the recipient being who you think it is.

Two things follow. Keep the set of people who can edit Actions variables as small
as the set who can read production secrets. And treat the **quarterly drill as the
detector**: a re-keyed backup is indistinguishable from a good one until someone
tries to decrypt it with the real private key, which is precisely what the drill
does. (Pinning the expected key in a reviewed file was considered and rejected for
now: it converts routine key rotation into a code change, and the drill already
closes the loop within a quarter.)

### The decryption key needs the redundancy the dumps get

Every retained artifact is encrypted to **one** keypair. A lost private key voids
all 30 days at once, silently, and you discover it during the incident that
needed the restore.

- The private key lives in a password manager that is **itself** backed up,
  **plus** one independent offline copy kept physically elsewhere.
- Encrypting to two recipients is an acceptable alternative.
- What is **not** acceptable: a single copy, on the laptop that runs the app.
- It must never be committed, and never placed in a repository _variable_ —
  variables are readable by anyone with read access. The backup workflow rejects
  an `AGE-SECRET-KEY-` value outright for exactly this reason.

### Restoring — the drill

`scripts/backup-restore-drill.ps1` decrypts an artifact and restores it. It is
**name-guarded exactly like `db/reset-test-database.ts`**: it refuses unless
`NODE_ENV=test` _and_ the target database name matches `safwa_test` or
`safwa_test_<worker>`. There is no override. A drill that can overwrite the
database it was copied from is not a drill.
`scripts/test-backup-restore-drill.ps1` asserts those refusals as gate step 17,
so the guard cannot rot unnoticed.

```powershell
$env:NODE_ENV = "test"
./scripts/backup-restore-drill.ps1 `
    -DumpPath ./safwa-20260730T031700Z.dump.age `
    -IdentityFile $HOME/.config/safwa/backup-age.key `
    -TargetDatabaseUrl "postgres://.../safwa_test?sslmode=require"
```

Restoring is only the first half. The drill is finished when you have:

1. Checked row counts for `users`, `review_events` and `study_components` are
   non-zero and plausible against production.
2. Pointed the app at the restored database and signed in as a known account —
   its due cards and history should be there.
3. Recorded the date, which artifact you restored, and the outcome.
4. **Dropped the scratch database.** It is a full copy of production.
5. **Checked your temp directory for stray `safwa-restore-*.dump` files.** The
   script deletes the decrypted copy on a normal failure and on a graceful
   Ctrl-C, but nothing runs after a forced kill, a closed console window or a
   crash — and what survives is plaintext production data, password hashes and
   session tokens included.

If the restore fails part-way, the target is neither its old self nor a complete
copy: `--clean --if-exists` has already dropped objects by then. Do not read row
counts from a partially restored database — drop and recreate it first. The script
says so on that path too.

**Cadence: quarterly, and additionally after any migration that is not purely
additive.** A restore proved once is not a restore path — H5 proves it at t=0
against the schema of that day, while migrations accumulate and the
`pg_dump`/`pg_restore`/`age`/PG17 toolchain drifts underneath it. The drill is
what turns "we have backups" into "we can restore", and those are different
claims.

**Nothing tracks or enforces that cadence.** No CI check, no reminder, no file in
this repository knows when the last drill happened — it is a calendar commitment
exactly like the monthly offsite pull above, and it lapses the same silent way.
Gate step 17 proves the restore script still _refuses the wrong database_; it
cannot prove anyone ran a drill.

## 8. Production deployment & rollback

- Deploy: merge to main → CI (full matrix) → migrations → promote.
- Rollback: redeploy the previous Vercel build (instant); DB rollback via
  down-migration only for additive changes, otherwise the restore-from-backup
  path — which is drilled **quarterly** from Phase 18 onward (§7), not deferred.
  What is still deferred to Phase 22 is a rehearsal of the **app-redeploy**
  rollback itself; the two are separate exercises and only the second is
  outstanding.
- Feature flags for risky subsystems act as kill-switches: `AUTH_ENABLED` and
  `SYNC_ENABLED` are server-side and take effect on the next request; the
  service worker's is **not**, and that difference matters — see below.

### 8a. Rolling back the service worker (Phase 18)

**Redeploying the previous build does not remove a service worker.** A worker
is installed on the device, not shipped with the page: it keeps controlling
every navigation and serving its own caches until something explicitly
unregisters it. So the rollback is a deploy with the switch turned off, not a
deploy of an older build:

1. Set `NEXT_PUBLIC_SW_ENABLED=false` in the Vercel environment and redeploy.
   It is a `NEXT_PUBLIC_*` variable, so it is inlined at **build** time —
   changing it without a rebuild changes nothing.
2. On their next load, every device runs
   `components/pwa/service-worker-provider.tsx`, which unregisters **every**
   registration for the origin (not only the scope this build knows about) and
   deletes **every cache on the origin** (not only the seven this app names) —
   Serwist's precache included.
3. A device that never loads the app again keeps its worker. There is no way
   around that from the server, and it is the reason the switch is worth
   deploying promptly rather than treated as a background cleanup. If a device
   is known to be affected and cannot be reached, the only remaining lever is
   the browser's own "Clear site data" for the origin, performed by whoever
   holds the device.

Leave it at `false` until the cause is fixed, then remove the variable — unset
means "on in a production build", so deleting it is what turns the worker back
on.

**The cache sweep is a separate step because unregistration does not do it.**
`ServiceWorkerRegistration.unregister()` removes the registration and nothing
else: Cache Storage belongs to the **origin**, not to the registration, and is
otherwise pruned only by a _new_ worker's activate-time cleanup — which a
rollback never runs, because it installs no replacement. Without the sweep, a
rollback would leave every cache the worker ever wrote on the device, inert and
unreclaimable, until the worker was turned back on.

The two steps are run independently rather than in sequence, so an
unregistration that stalls cannot prevent the sweep.

**A sign-out is not a rollback and does not do this.** It clears only the two
caches that can hold account-specific markup (`OWNER_SENSITIVE_CACHE_NAMES`);
the app shell, build assets and downloaded vocabulary are deliberately kept, so
the next learner on that device is not made to re-download the whole app.

## 9. Monitoring & operations

- Sentry (client + server) for errors; structured JSON logs on API routes;
  `/api/health` (implemented Phase 15 — DB reachability with a 4s internal
  Postgres statement timeout under a 5s overall check timeout, active
  release id, `AUTH_ENABLED` status) for uptime checks. **Any external
  load balancer, orchestrator or uptime monitor polling this endpoint must
  configure its own request timeout above 5 seconds** — a shorter external
  timeout can spuriously mark the app unhealthy while the endpoint's own
  internal timeout is still legitimately in flight.
- Sync-health signals: rejection counts by reason, fallback-conflict count,
  pending-parent backlog — reviewed weekly at launch; alert thresholds via
  Sentry metrics or a simple cron report.
- Privacy-conscious analytics (Vercel Analytics or self-hosted Plausible):
  page views + a handful of product events (session completed, merge
  completed); no PII, no cross-site tracking; documented in a privacy page.

## 10. Auth rate-limit client-IP assumption

Better Auth's database-backed rate limiter (modules/auth/server.ts, Phase
15 §43) keys each sensitive-endpoint counter by client IP + path, resolved
from the `x-forwarded-for` header. No `advanced.ipAddress.trustedProxies`
is configured, so Better Auth only trusts a **single-value**
`x-forwarded-for` header — deliberately, per phases-15.md §43's "no
trusted-client IP derived from arbitrary untrusted forwarded-header
positions" requirement, rather than guessing at proxy IP ranges we cannot
verify from inside this repository.

This assumes the deployment topology in §3: Vercel serverless functions
sit directly behind Vercel's own edge network with **no additional
CDN/WAF in front**, so `x-forwarded-for` should arrive single-valued (the
original client's IP). If that topology changes (e.g. Cloudflare or
another CDN is added in front of Vercel), `x-forwarded-for` becomes
multi-hop and Better Auth's `getIp()` returns `null` for every request —
rate-limit keys then collapse onto one shared `no-trusted-ip|<path>`
bucket per sensitive endpoint (fails closed to a coarser, shared limit;
never bypasses rate limiting entirely, but ordinary traffic can exhaust
the shared bucket and 429 unrelated users).

If a proxy/CDN is ever added in front of Vercel, `advanced.ipAddress.trustedProxies`
in `modules/auth/server.ts` must be updated to name that proxy's real
egress IPs/CIDR ranges (not a broad range that could also cover clients)
before that change ships.

### 10a. The app's own API rate limits (Phase 18.1)

Section 10 covers Better Auth's limiter, which guards **only** Better
Auth's own endpoints. It knows nothing about this app's routes, so
`/api/sync/push`, `/api/sync/pull`, `/api/sync/guest-merge` and
`/api/account/settings` had no ceiling until Phase 18.1. They now share a
second, separate limiter: `modules/sync/server/rate-limit.ts`, counters in
`api_rate_limits` (migration 0007).

Three operational facts about it:

- **It is keyed by account, not by IP**, so §10's whole `x-forwarded-for`
  discussion does not apply to it. The subject is the session-derived user
  id, which cannot be spoofed. The cost of that choice is stated plainly:
  it does not limit an unauthenticated flood, because these routes reject
  unauthenticated callers before the limiter runs.
- **It fails OPEN.** If the counter's statement throws, the request is
  allowed and a `[rate-limit] counter unavailable` line is logged. A
  database blip must not become a total outage of study sync. If you see
  those lines in production, the ceiling is off — the routes are still
  authenticated, but cost is unbounded until the database recovers.
- **It does not use Better Auth's `rate_limits` table**, deliberately.
  Better Auth prunes that table with a background `deleteMany` keyed only
  on `lastRequest < cutoff`, with no key filter — it deletes every row it
  finds, including rows it did not write. Sharing it would mean these
  counters resetting on another component's schedule. Do not "consolidate"
  the two tables without re-reading `db/schema/rate-limit.ts`.

The limits themselves are constants, not environment variables. That is
deliberate and is the opposite of the `AUTH_RATE_LIMIT_*` decision in §2:
those needed production bounds precisely because an E2E-tuned `.env` could
otherwise reach production. Constants cannot. They are generous ceilings on
runaway cost, not traffic shaping — no legitimate client should ever meet
one.

### 10b. Cross-origin posture (Phase 18.1)

**Safwa sets no `Access-Control-Allow-Origin` header on any route, and must
not start.** This is the control, not an omission: a browser will not let
foreign script read a response that has not opted in. If a future change
needs a cross-origin consumer, that is a design decision requiring its own
review — not a header to add in passing.

Request forgery is handled separately, by the session cookie's
`SameSite=Lax` (Better Auth's default, unmodified). That is what makes a
cross-site POST arrive with no cookie, which is why this app has no CSRF
token. `tests/integration/auth-login-logout.test.ts` asserts the attribute
so a dependency upgrade cannot change it silently.

`Lax` still sends the cookie on a top-level GET navigation, so the sync
routes and `/api/account/settings` additionally assert same-origin
(`modules/auth/request-origin.ts`). Both signals refuse only on positive
evidence and allow on absence — see that file for why the fail-safe
direction is correct rather than lax.

## Online sync (Phase 16, Stage A)

Server-authoritative learning-state sync is gated by the `SYNC_ENABLED`
environment flag (a kill-switch):

- `SYNC_ENABLED=true` (default) turns on the `POST /api/sync/push` and
  `GET /api/sync/pull` endpoints. It **requires `AUTH_ENABLED=true`**;
  `SYNC_ENABLED=true` with `AUTH_ENABLED=false` is rejected at env-parse time
  (`modules/env/server.ts`), since sync derives the account from the session.
- `SYNC_ENABLED=false` disables sync at the server: both endpoints return a
  clean `503` **before** any session read (the flag is checked first in
  `modules/sync/server/auth-guard.ts`), and the client degrades gracefully —
  local study is unaffected, the status indicator reads "Sync off". Flip this
  to instantly stop all sync traffic without a code change; guests and local
  study are never affected either way.

No new infrastructure beyond the Phase 15 Postgres database: sync tables
(`user_sync_state`, `sync_audit_log`, and the `last_sync_seq`/lineage columns on
the learner tables) ship in the same Drizzle migration set (`pnpm db:migrate`).
The account-wide monotonic sync cursor lives in `user_sync_state.sync_revision`.

Local verification uses the disposable `safwa_test` database (see the Commands
section in `CLAUDE.md`): `pnpm test:integration` covers ingest/pull/revoke
against real Postgres; `pnpm test:e2e` includes the `SYNC_ENABLED=false`
kill-switch config (`playwright.sync-disabled.config.ts`).

## Guest→account merge (Phase 17)

The merge rides on the same infrastructure and the same kill-switch as sync —
there is nothing new to provision, and nothing new to turn on.

- **Endpoint:** `POST /api/sync/guest-merge`, authenticated and
  email-verified, behind the identical guard as push/pull. `SYNC_ENABLED=false`
  makes it return a clean `503` **before** any session read, exactly as the
  other two do; a guest is then never prompted, and no guest row is touched.
  There is no separate merge flag: a deployment that has turned sync off has
  turned the merge off, which is the honest coupling — the merge has nowhere
  to put anything.
- **Migrations:** `0003`–`0006` add `guest_imports`, the merge-marker columns
  on `study_components` / `review_events`, the refusal-reason column and the
  import's list-id mappings. They ship in the same set (`pnpm db:migrate`) and
  each has a matching `db/rollback/*_down.sql`.
- **Rollback:** the down migrations drop the merge's own tables and columns.
  They are safe to run on a database where merges have happened, in the sense
  that no imported learning state is deleted — the imported attempts and events
  are ordinary rows in the ordinary tables and stay. What is lost is the
  **provenance**: without `merged_at` / `merged_from_guest_import_id`, a
  component whose history was united has a DAG the older replay refuses as
  multi-rooted. So a rollback past `0004` must be paired with rolling the
  application back to a build whose replay predates the merge, or those
  components will fail to project. Roll the app back first, then the schema.
- **Client schema:** Dexie **v9** (owner-keyed primary keys since v7, ADR-009).
  The upgrade copies rows into new physical stores and drops the old ones;
  IndexedDB cannot re-key in place. It is forward-only — an older build opening
  a v9 database will not find the stores it expects, so a client rollback past
  v7 means a learner's local guest state is not readable by the older build.
  Server-backed account state is unaffected and re-pulls.
- **Local verification:** `pnpm test:integration` covers the merge coordinator,
  collections union and end-to-end import against real Postgres;
  `pnpm test:e2e` runs the full journey including the second-device proof, and
  the `SYNC_ENABLED=false` refusal in the sync-disabled config. The E2E global
  setup registers a content release (`pnpm db:register-content`) — every stored
  study session carries a `release_id` foreign key, so an authenticated push or
  merge fails at the database without it.
