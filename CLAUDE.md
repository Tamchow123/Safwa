# CLAUDE.md — project instructions for Safwa

Safwa is an Arabic vocabulary-learning web app (Next.js 16 App Router + React
19 + TypeScript, Tailwind v4 + shadcn/ui, Zod, ts-fsrs, Dexie/IndexedDB,
Postgres + Drizzle, Better Auth, pnpm, Vitest, Playwright). It is built phase
by phase from `docs/phases/IMPLEMENTATION_PHASES.md` (23 phases, 0–22). Read
the phase you are implementing, its prerequisites, and its testing checkpoint
before writing code.

**Current state:** Phases 0–17 are implemented and merged to `main` (most
recently Phase 17 — Guest→account merge, PR #23); the Core MVP is complete.
**Phase 18 — PWA, offline & first production deploy** is in progress and is
the **last** implementation phase: it delivers the Offline-capable Beta
milestone (Serwist service worker, offline study, queued sync) and absorbs
Phase 22's deploy, backup and security-header slices. Phases 19–21 and the
rest of 22 are deferred, each with the condition that reopens it recorded in
`docs/phases/IMPLEMENTATION_PHASES.md` ("Deliberately deferred after Phase
18") and `docs/phases/phases-18.md` §3 — notably, **acquiring a second study
device reopens Phase 19**.

## Hard rules

1. **Never modify `data/safwa-mujarrad.original.json`.** It is the immutable
   transcription of the printed source. It is read, compared against, and
   nothing else.
2. **Quiz eligibility is mandatory.** Never select a quiz target, distractor or
   study-component field whose `quiz_eligibility` boolean is not `true`. The
   presence of a value is not permission to teach it. Generated
   `additional_forms` and all mazīd fīh candidates are quiz-ineligible until
   independently verified (`status: "verified"` + `verification_source`).
3. **Arabic data-handling rule.** Never copy Arabic strings from visually
   rendered terminal output, and never manually type an Arabic value that must
   match the source. Terminal display reorders and corrupts Arabic; it is not
   evidence of correctness. Instead:
   - Read the exact value programmatically from the JSON by entry ID + field.
   - Verify with codepoint sequences / `\uXXXX` escapes (ASCII-safe), NFC
     status, and comparison against the immutable original.
   - Documentation uses `{{entry:ID:field}}` / `{{bab:NAME:bab_arabic}}`
     placeholders filled by the doc-generation step (Phase 0/3 tooling), never
     hand-typed source values.
   - Never write normalised or "fixed" strings back to any data file.
4. **Arabic comparison policy** (from `docs/vocabulary-schema.md`): NFC
   normalise, strip invisible formatting characters (U+200B–U+200F, U+061C,
   U+FEFF, U+2060), trim — and nothing else. ḥarakāt, shaddah and hamzah seat
   differences are meaningful and preserved. Split maṣdar alternatives on
   `" / "`.
5. **The six mujarrad bābs are not Forms I–VI.** They are six patterns within
   thulāthī mujarrad (Form I). Display a bāb as its Arabic pair (māḍī + muḍāriʿ
   from `bab_arabic`), never as a number.
6. **Separate content from learning state.** Vocabulary content ships as
   immutable versioned content releases; user learning state lives in
   IndexedDB on the device (guests and accounts alike, owner-keyed) and, for
   accounts, authoritatively in Postgres. Never mix editable copies.
7. **Server-side trust boundaries.** The server derives correctness and FSRS
   ratings for objective questions from the assessment manifest; it never
   trusts client `is_correct`/`rating`. Review events form a causal DAG
   (`parent_event_id`); scheduling state is produced by deterministic replay.
   A component has exactly one chain root, except after a guest→account
   merge: the second root is admitted only by `classifyMergeLineage`
   (`modules/sync/server/lineage.ts` — brand-sealed, lint-fenced to
   `ingest.ts`). Replay only consults `study_components.merged_at` and
   re-checks nothing, so admission is the whole defence (ADR-009).
8. **Local learner state is owner-keyed.** A guest and one or more accounts
   coexist in one Dexie database, so every private store carries an
   `ownerKey` (`guest` / `account:<user-id>`) built only by `toOwnerKey`
   (`modules/content/owner-key.ts`), and every written row must be stamped
   with it. Read and delete through `readOwnedRows` / `deleteOwnedRows`, and
   key every `get`/`delete` with `ownedKey`
   (`modules/content/owner-scope.ts`) — never a bare table query, and never
   `clear()` an owner-scoped store (that destroys a coexisting guest's
   deferred merge). A new private store must be listed in `ownerScopedTables`
   (`modules/content/db.ts`) or it escapes both the sign-out sweep and the
   merge (ADR-009).

## Naming

- Project name: **Safwa**. Older files/strings may say "SarfMaster" — update
  text references when touching them, but never rename data files, JSON keys,
  or IDs without an explicit migration decision.
- The enriched dataset on disk is `data/safwa-vocabulary.v2.json`. The Python
  scripts' `V2_FILE` constants must point at this name (fixed in Phase 0).

## Code layout

- `app/` — App Router: `(auth)` and `(shell)` route groups, `api/`
  (`auth/`, `account/`, `health/`, and `sync/*` — push, pull, guest-merge),
  plus `serwist/[path]` (Phase 18 — a `force-static` handler that emits the
  service worker at build time) and `~offline` (Phase 18 — the offline
  fallback page, deliberately outside `(shell)` so it depends on no provider).
- `modules/` — feature modules: `analytics`, `auth`, `collections`, `content`,
  `email`, `env`, `http`, `profile`, `pwa`, `scheduler`, `study-engine`,
  `study-session`, `sync` (`sync/client`, `sync/server`, `sync/protocol`).
  `http` (Phase 18.1) is the exception to "feature module": it holds
  request-shaping infrastructure used by routes across several features —
  the per-account rate limiter (`api_rate_limits`, migration 0007), the
  same-origin assertion, and the one 429 response shape. Something belongs
  there only if it shapes an HTTP request/response for more than one
  feature's routes AND carries no domain knowledge; see its `README.md`.
  Modules with non-obvious boundaries carry a `README.md` (`analytics`,
  `content`, `http`, `pwa`, `scheduler`, `study-engine`, `sync`, plus
  `shared/arabic`)
  — read it before changing that module, and update it in the same phase.
  `modules/pwa/sw.ts` is the one file compiled for a **worker** global scope:
  it is excluded from the root `tsconfig.json` and checked by
  `tsconfig.sw.json`, which `pnpm typecheck` also runs. Nothing in it is
  reachable from the unit suite, so it stays wiring-only — the cache rules and
  the Cache Storage operations live in sibling files that are.
- `components/` — UI foldered by feature, with a few app-wide components at
  the root; `components/ui` holds the generated shadcn primitives. Client
  flow providers live here (`components/sync/*-provider.tsx`, mounted in
  `app/(shell)/layout.tsx`) while the logic they drive stays in
  `modules/*/client`.
- `lib/`, `shared/` — client helpers, boundary-shared code (`shared/arabic`).
- `db/` — Drizzle `schema/`, `migrations/`, `rollback/`, and the
  migrate/register-content/reset entry points; `compose.yaml` + `docker/`
  provision local Postgres. Every migration ships a matching hand-written
  `db/rollback/<n>_*_down.sql` — nothing checks this, and
  `docs/DEPLOYMENT.md` records the app-before-schema rollback ordering it
  implies.
- `data/` → `public/content` + `content-server/` — source vocabulary JSON and
  the generated content-release artifacts. The artifacts are regenerated by
  `pnpm content:build` and must be committed fresh; never hand-edit them.
- `assets/brand/` → `public/icons/` — the hand-authored master mark
  (`safwa-mark.svg`) and `icons.lock.json`, plus the PWA icon set generated
  from them by `pnpm icons:build`. Same rule as the content artifacts: the
  PNGs are derived, committed, and never hand-edited.
- `tests/` — Vitest unit tests mirroring the source tree, plus
  `tests/integration/` (Postgres, its own `vitest.integration.config.ts`).
  The other convention is colocated `*.test.ts` beside the source, used by
  all of `modules/sync/**` and `lib/preferences/`; `vitest.config.ts` picks
  those up only under `tests/`, `modules/`, `shared/` and `lib/`. Follow
  whichever convention the code under test already uses.
- `e2e/` — Playwright specs plus shared `e2e/helpers/` (auth flows, quiz
  driving, IndexedDB and DB probes); reuse a helper, never reimplement one.
- `scripts/` — Python data tooling and the PowerShell quality gate, git guard,
  workspace fingerprint and (Phase 18) `backup-restore-drill.ps1`, which
  restores an `age`-encrypted `pg_dump` artifact and is name-guarded exactly
  like `db/reset-test-database.ts` — `NODE_ENV=test` plus a
  `safwa_test(_\w+)?` database name, no override. Both guards ship a
  table-driven `test-*.ps1` self-test that the gate runs (steps 16–17).
  `tools/` — `docs-verify.ts`.

## Commands

```bash
python scripts/enrich-vocabulary.py     # deterministic regeneration of enriched data (no pnpm wrapper)
```

App: `pnpm dev`, `pnpm build`, `pnpm test` (Vitest unit tests),
`pnpm test:integration` (Vitest against Postgres — constraints, content
registration, Better Auth, manifest loader, sync ingest/pull/revoke, guest
merge; one config picks up every `tests/integration/**/*.test.ts`, so a new
suite needs no config change), `pnpm test:e2e` (Playwright, runs the
default + auth-disabled + auth-rate-limit + sync-disabled + signup-closed
configs — all five run `next dev`, so **none of them has a service worker**;
`e2e/global-setup.ts` resets `safwa_test` and registers a content
release, so Postgres must be up for E2E too), `pnpm test:e2e:offline`
(Phase 18 — `playwright.offline.config.ts` on port 3105, the only config that
runs a real `next build && next start` and therefore the only one where the
service worker exists; Pixel 7 + iPhone WebKit projects, and it needs the
WebKit browser installed. Deliberately outside `test:e2e` so that script keeps
meaning "the dev-server configs" — but it is part of the gate and of CI, and
`docs/phases/phases-18.md` §8.1 records which proofs each engine can and cannot
carry), `pnpm typecheck`,
`pnpm lint`, `pnpm format:check`, `pnpm validate:data`
(`scripts/validate-vocabulary.py`, must exit 0), `pnpm verify:arabic`
(`scripts/arabic-extract.py --verify-known`), `pnpm content:build`
(regenerates `public/content`/`content-server` from the vocabulary data),
`pnpm docs:verify` (checks doc Arabic placeholders), `pnpm content:verify`
(content:build + docs:verify), `pnpm icons:build` / `pnpm icons:verify`
(rasterises `assets/brand/safwa-mark.svg` into the committed `public/icons`
set and rewrites `assets/brand/icons.lock.json`; `icons:verify` re-renders and
compares bytes, and is authoritative only on the platform the icons were
authored on — the portable freshness check is `scripts/icons-lock.ts`, run by
the unit suite and therefore by CI, and `icons:build` refuses to rewrite the
set from a platform the lock does not name unless passed
`--allow-foreign-platform`), `pnpm deploy:verify` (Phase 18 — checks a
production environment before it is deployed; the rules it shares with the
runtime validator live in `modules/env/rules.ts`), `pnpm routes:verify`
(Phase 18 — checks `next.config.ts`'s `outputFileTracingIncludes` keys against
`.next`'s own app-paths manifest; **must run after `pnpm build`**),
`pnpm sw:verify` (Phase 18 — checks the four service-worker adoption criteria
of `docs/phases/phases-18.md` §6 against the build output, plus three checks
that are not §6 criteria: the route serves nothing beyond the worker and its
source map, every runtime cache rule reached the worker bundle, and no
content-release artifact is precached; **must run after `pnpm build`**),
`pnpm check` (typecheck + lint + format:check + test + build).

Server/database (added Phase 15 — Postgres, Drizzle, Better Auth, email):
`docker compose up -d db` starts the local `postgres:17-alpine` container
(`compose.yaml`) providing both the `safwa_dev` and disposable `safwa_test`
databases; `pnpm db:generate` / `pnpm db:check` (Drizzle Kit schema
generation/check), `pnpm db:migrate`, `pnpm db:register-content`, `pnpm
db:test:reset` (hard-gated to `safwa_test(_\w+)?` + `NODE_ENV=test`),
`pnpm email:clear-outbox`. See `docs/DEPLOYMENT.md` for env var setup
(`.env.local` from `.env.example`, `DATABASE_URL`). `.env*` files are
read-blocked to Claude's file tools by `.claude/settings.json`; the quality
gate reads them internally as a subprocess.

Feature flags (`.env.example`): `AUTH_ENABLED` and `SYNC_ENABLED` (Phase 16).
`SYNC_ENABLED=false` degrades the app to local-only study without affecting
auth or local guest study; the guest→account merge has no flag of its own and
is refused with a 503 by the same guard as push/pull. In production
`SYNC_ENABLED=true` with `AUTH_ENABLED=false` is rejected. Each flag has its
own Playwright config + spec (`playwright.auth-disabled.config.ts`,
`playwright.sync-disabled.config.ts`).

`SIGNUP_ALLOWED_EMAILS` (Phase 18) is not a flag but a policy: production
**fails closed** without it, and a `hooks.before` middleware in
`modules/auth/server.ts` refuses `/sign-up/email` for anything not on the list.
It also has its own config + spec (`playwright.signup-closed.config.ts`), since
every other E2E server leaves it unset so its specs can register freely. The
four `AUTH_RATE_LIMIT_*` variables carry production bounds
(`docs/DEPLOYMENT.md` §2) so an E2E-tuned `.env` cannot reach production.

`scripts/quality-gate.ps1` runs the full CI-equivalent check sequence
locally in 25 steps (21 with `-SkipE2E`): dependency/data/Arabic checks,
content-artifact freshness (build + `git diff`/untracked checks), icon
byte-identity (the one step deliberately _not_ mirrored in CI — see step 7's
own note), docs verification, disposable-Postgres reachability + migrations +
content-version registration + `test:integration` (against `safwa_test`,
derived from `.env.local`'s `DATABASE_URL`), typecheck/lint/format, the
push-guard and restore-drill guard self-tests, unit tests, build,
`routes:verify` and `sw:verify`
(both must follow the build — they read `.next`'s own output), and E2E — the
four dev-server configs (step 23) and then, on its own WebKit install and its
own real `next build && next start`, the offline/PWA suite (steps 24–25).
`-SkipE2E` skips only the E2E steps (22–25) for fast inner-loop iteration — the
full gate (E2E included) must still pass before review.

## Document map

- `docs/PRODUCT_REQUIREMENTS.md` — what to build, learning/quiz rules, acceptance criteria
- `docs/ARCHITECTURE.md` — stack, module boundaries; the numbered decision
  records themselves live in `docs/adr/` (001–009). §5's "As built (Phase 18)"
  is the map of the PWA/service-worker layer and the offline identity contract
- `docs/DATA_MODEL.md` — Postgres + Dexie schemas, component identity, event model
- `docs/OFFLINE_AND_SYNC.md` — causal sync design, conflict policy, staged
  rollout; the "As built" sections record what Phases 16–18 shipped and what
  they still do not claim. Phase 18's section is the authority on the **offline
  identity contract** and on the list of things offline study explicitly does
  **not** guarantee — read that list before promising any of them
- `docs/phases/IMPLEMENTATION_PHASES.md` — the 23 phases (0–22); implement one
  at a time. Later phases have expanded detail docs alongside it
  (`docs/phases/phases-12.md` through `-18.md` so far) — read the matching
  detail doc for a phase if one exists. Implementation stops after 18; the
  same file records what reopens each deferred phase.
- `docs/TEST_STRATEGY.md` — required tests per layer and per phase
- `docs/DEPLOYMENT.md` — environments, hosting, migrations, backups
- `docs/RISK_REGISTER.md` — known risks and mitigations
- `docs/vocabulary-schema.md`, `docs/vocabulary-audit.md`,
  `docs/manual-review-required.md` — existing data-layer docs (do not edit;
  `manual-review-required.md` is generated by `scripts/enrich-vocabulary.py`
  and `pnpm validate:data` asserts it is an exact render)
- `docs/.arabic-placeholders.json` — the registry behind the
  `{{entry:ID:field}}` / `{{bab:NAME:bab_arabic}}` doc placeholders;
  `pnpm docs:verify` checks every record against both datasets, and `--write`
  fills unresolved placeholders in the recorded files from the JSON data

## Phase implementation workflow (permanent rules)

- **`/run-phase` is the standard implementation workflow** for every phase:
  branch → implement in reviewed slices → per-commit review → quality gate →
  full-phase council → draft PR. It is a user-level skill
  (`~/.claude/skills/run-phase/`), as are its reviewer agents
  (`~/.claude/agents/phase-council/` — this repo's `.claude/agents/` holds
  only `phase-code-reviewer`); `/resume-phase` recovers an interrupted
  run from `.claude/review/runtime/active-phase.json`. Run state and reports
  live under `.claude/review/` (untracked). The older single-reviewer
  `/phase-loop` skill (`.claude/skills/phase-loop/SKILL.md`, reviewed by the
  `phase-code-reviewer` subagent) is still available but superseded.
- **Review is done by read-only subagents only.** Every commit gets the
  lightweight `commit-reviewer` plus any specialists the risk router selects
  (`architecture-`, `reliability-`, `security-`, `testing-`,
  `clean-code-reviewer`); the final integrated review runs the full
  council — `functionality-`, `testing-` and `clean-code-reviewer` always,
  the other three risk-routed — with `council-chair` consolidating the
  verdict. Reviewers use Read/Grep/Glob only (chair adds Bash) — they
  never edit, commit, push, merge or open PRs.
- **Reviewer findings are fixed only by Claude.** Every finding is either
  fixed or explicitly rebutted with a technical rationale — never silently
  ignored. External/human review findings outrank a prior council approval:
  Phase 16 reached `PR_READY` twice and was reopened both times.
- **No PR until the review approves.** A pull request may be created only
  after the quality gate passes AND the final council returns an approval.
  PRs are always created as drafts.
- **Any code change invalidates the prior approval.** Re-run the quality gate
  and the review after every correction.
- **Never merge a pull request or deploy automatically.** The human reviews
  and merges every PR manually.
- **Never weaken tests.** Never delete, skip, hollow out or loosen a test to
  make a check or review pass.
- **Never hide review failures.** Failed gates, reviewer rejections and
  unresolved findings are reported verbatim, not smoothed over.
- **Never claim success without evidence.** "Done" requires quality-gate
  output showing every check passed (`scripts/quality-gate.ps1` exit 0).
- **No force-push, `reset --hard`, `clean`, branch deletion, or `gh pr
merge`.** Also enforced mechanically by the `scripts/guard-git-push.ps1`
  PreToolUse hook (self-tested by `scripts/test-guard-git-push.ps1`, gate
  step 15), which blocks these in any argument position; the
  `.claude/settings.json` deny list matches only command prefixes, so it is
  a first-position backstop only. The guard parses every token after `git
push` as a ref, so run pushes bare — no `2>&1`/`| tail` redirection.
- **Branch protection on `main`:** required checks "Quality & build" and
  "E2E (Chromium)"; force pushes and deletions blocked. Phase branches are
  `phase/<n>-<kebab-description>`; post-merge corrections use
  `phase/<n>.<x>-…` and go through the same full workflow.

# Compact instructions

When compacting, preserve:

- The current phase requirements and acceptance criteria
- Architectural and implementation decisions
- Every modified or newly created file
- Completed and remaining work
- Test commands, failures and final results
- Unresolved defects and reviewer findings
- Important user corrections and constraints
- The precise next action

Discard repetitive command output, superseded plans, failed exploratory approaches,
and information that can be recovered directly from the repository.
