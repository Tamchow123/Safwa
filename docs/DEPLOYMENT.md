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

| Variable                                                                 | Purpose                                                                                        | Envs                                      |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `DATABASE_URL`                                                           | Postgres connection (Neon pooled URL in prod)                                                  | all                                       |
| `NODE_ENV`                                                               | `development \| test \| production`                                                            | all (set by tooling, rarely by hand)      |
| `BETTER_AUTH_SECRET`                                                     | session/token signing                                                                          | all (unique per env)                      |
| `BETTER_AUTH_URL` / `NEXT_PUBLIC_APP_URL`                                | canonical origin                                                                               | all                                       |
| `AUTH_ENABLED`                                                           | auth feature-flag kill-switch (default `true`)                                                 | all                                       |
| `AUTH_RATE_LIMIT_WINDOW_SECONDS` / `AUTH_RATE_LIMIT_MAX`                 | sensitive-endpoint rate-limit tuning (default 60s/5)                                           | all — see caveat below                    |
| `AUTH_RATE_LIMIT_DEFAULT_WINDOW_SECONDS` / `AUTH_RATE_LIMIT_DEFAULT_MAX` | default rate-limit bucket tuning (default 10s/100, matches Better Auth's own built-in default) | all — see caveat below                    |
| `EMAIL_TRANSPORT`                                                        | `console-file` (dev/test) \| `resend` (preview/prod)                                           | all                                       |
| `EMAIL_OUTBOX_DIR`                                                       | console-file transport's output dir (default `.local/email-outbox`)                            | dev/test only                             |
| `RESEND_API_KEY`                                                         | transactional email                                                                            | preview/prod (dev uses console transport) |
| `EMAIL_FROM`                                                             | verified sender                                                                                | preview/prod                              |
| `ALLOW_DEV_EMAIL_TRANSPORT_IN_PRODUCTION`                                | explicit escape hatch for `console-file` in production (default `false`)                       | prod only, exceptional                    |
| `SIGNUP_ALLOWED_EMAILS`                                                  | comma-separated addresses permitted to register — **required in production**                   | all (unset outside prod = sign-up open)   |
| `SENTRY_DSN`                                                             | error monitoring                                                                               | preview/prod                              |
| `CONTENT_SERVER_DIR` / storage binding                                   | assessment+validation manifests location                                                       | all                                       |
| `ADMIN_BOOTSTRAP_EMAIL`                                                  | first admin promotion (one-shot)                                                               | prod                                      |

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

## 6. Content seed / import process

- Stage 1: `pnpm content:build` runs in CI/build from the validated JSON;
  artifacts are versioned and immutable; the Python validator gates the
  build.
- Stage 2 (post-Phase 21): admin import CLI seeds Postgres content tables
  idempotently; publishing generates new immutable releases + manifests via
  the same pipeline. Old manifests are retained indefinitely
  (`OFFLINE_AND_SYNC.md` §8).

## 7. Backups & restore

- Neon PITR within plan limits (assumption: 24h–7d depending on tier) plus a
  scheduled logical dump (`pg_dump`) to external storage (GitHub Actions cron
  → encrypted artifact or object storage) — daily at launch.
- Independently of both, **every production migration takes its own restore
  point first** and refuses to run without one — a Neon branch named
  `pre-migrate-<run-id>-<attempt>` (§5). That covers the single most dangerous
  operation; it is not a substitute for the scheduled dump, which is what
  survives losing the Neon project itself.
- Content releases are reproducible from git-tracked JSON — no separate
  backup needed; the original dataset is the canonical evidence.
- **Restore drill at Phase 22** (documented): restore a dump into a fresh
  branch, run the app against it, verify a known user's state.

## 8. Production deployment & rollback

- Deploy: merge to main → CI (full matrix) → migrations → promote.
- Rollback: redeploy the previous Vercel build (instant); DB rollback via
  down-migration only for additive changes, otherwise restore-from-backup
  path; a rollback rehearsal is part of the Phase 22 checkpoint.
- Feature flags for risky subsystems (sync, SW) act as kill-switches without
  redeploys.

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
