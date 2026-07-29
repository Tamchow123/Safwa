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
- **Prefer catching it before the deploy**, with the pre-deploy precondition
  check (added in Phase 18's deploy-readiness slice) rather than in production.

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

| Component               | Choice                                                                                    | Assumption / note                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Web app + API           | **Vercel**                                                                                | Hobby tier suffices pre-launch for a free educational app; upgrade trigger: team members, higher limits, or commercial terms |
| Database                | **Neon Postgres**                                                                         | free tier assumed adequate at low usage; serverless driver from Vercel functions; PITR window per plan                       |
| Static content releases | shipped with the app (`public/content/`) or Vercel Blob later                             | releases are small (hundreds of KB)                                                                                          |
| Server manifests        | bundled server-side at build (Stage 1); DB/Blob after Phase 21                            | must never be publicly served from `public/`                                                                                 |
| Email                   | **Resend**                                                                                | free tier assumed ~100 emails/day — enough for verification/reset at launch scale                                            |
| Scheduled tasks         | none required for MVP; Vercel Cron if needed (pending-parent TTL sweep, activity rollups) |                                                                                                                              |
| Push notifications      | deferred post-MVP; web-push via a small worker + VAPID when added                         | iOS constraints documented in `OFFLINE_AND_SYNC.md`                                                                          |

**Expected low-usage cost: ~~$0–5/month** (assumption). Upgrade points:
Vercel Pro (~$20/mo) for limits/analytics; Neon paid (~~$19/mo) for more
storage/compute/PITR; Resend paid at volume.

**Lock-in assessment:** standard Next.js + Postgres + SQL migrations —
portable to any Node host + managed Postgres. Vercel-specific surface is
limited to config and (if adopted) Cron/Blob; Better Auth and Drizzle are
self-hosted libraries; Resend sits behind the email adapter.

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
