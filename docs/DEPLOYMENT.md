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
| `SENTRY_DSN`                                                             | error monitoring                                                                               | preview/prod                              |
| `CONTENT_SERVER_DIR` / storage binding                                   | assessment+validation manifests location                                                       | all                                       |
| `ADMIN_BOOTSTRAP_EMAIL`                                                  | first admin promotion (one-shot)                                                               | prod                                      |

Secrets live only in Vercel/Neon dashboards and local `.env.local`
(gitignored). `.env.example` documents every variable without values.

**Rate-limit tuning variables — production caveat (Phase 15).** All four
`AUTH_RATE_LIMIT*` variables are validated only for positivity — there is no
upper-bound production sanity check yet. Local development, CI and the E2E
suite each set these to values tuned for their own purposes (e.g. the E2E
suite's main server sets the default bucket to a very permissive `100000`
max so legitimate parallel test traffic never trips it — see
`e2e/helpers/e2e-server-env.ts`). **Never copy an E2E- or CI-tuned `.env`
into a production deployment** — a stray `AUTH_RATE_LIMIT_DEFAULT_MAX=100000`
in production would silently and drastically weaken rate limiting with no
validation error to catch it at deploy time. A future production-hardening
pass should add an explicit ceiling to `modules/env/server.ts`'s
`assertProductionInvariants()`.

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
