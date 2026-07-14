# Safwa — Deployment & Operations

Status: planning baseline (Architecture Plan v4, approved 2026-07-14).
**All pricing/free-tier statements below are assumptions as of planning time
(2026-07) — verify current terms at Phase 22 before relying on them.**

## 1. Local development setup

- Node LTS + pnpm; Python 3.10+ for the data scripts.
- Postgres: either Docker (`docker compose up db`) or a Neon development
  branch. Integration tests use a disposable database.
- `pnpm install` → `pnpm db:migrate` → `pnpm content:build` → `pnpm dev`.
- Email in development uses the console/file transport (no external sends);
  optionally Mailpit for a real inbox UI.
- `python scripts/validate-vocabulary.py` must pass before building content.

## 2. Environment variables

| Variable                                  | Purpose                                       | Envs                                      |
| ----------------------------------------- | --------------------------------------------- | ----------------------------------------- |
| `DATABASE_URL`                            | Postgres connection (Neon pooled URL in prod) | all                                       |
| `BETTER_AUTH_SECRET`                      | session/token signing                         | all (unique per env)                      |
| `BETTER_AUTH_URL` / `NEXT_PUBLIC_APP_URL` | canonical origin                              | all                                       |
| `RESEND_API_KEY`                          | transactional email                           | preview/prod (dev uses console transport) |
| `EMAIL_FROM`                              | verified sender                               | preview/prod                              |
| `SENTRY_DSN`                              | error monitoring                              | preview/prod                              |
| `CONTENT_SERVER_DIR` / storage binding    | assessment+validation manifests location      | all                                       |
| `ADMIN_BOOTSTRAP_EMAIL`                   | first admin promotion (one-shot)              | prod                                      |

Secrets live only in Vercel/Neon dashboards and local `.env.local`
(gitignored). `.env.example` documents every variable without values.

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
- CI runs the full migration chain against a disposable Postgres on every PR.
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
  `/api/health` (DB reachability + active release id) for uptime checks.
- Sync-health signals: rejection counts by reason, fallback-conflict count,
  pending-parent backlog — reviewed weekly at launch; alert thresholds via
  Sentry metrics or a simple cron report.
- Privacy-conscious analytics (Vercel Analytics or self-hosted Plausible):
  page views + a handful of product events (session completed, merge
  completed); no PII, no cross-site tracking; documented in a privacy page.
