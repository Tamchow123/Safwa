# CLAUDE.md — project instructions for Safwa

Safwa is an Arabic vocabulary-learning web app (Next.js App Router + React +
TypeScript, Tailwind, Dexie/IndexedDB, pnpm, Vitest, Playwright). It is built
phase by phase from `docs/phases/IMPLEMENTATION_PHASES.md` (23 phases,
0–22). Read the phase you are implementing, its prerequisites, and its
testing checkpoint before writing code.

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
   IndexedDB (guests) and Postgres (accounts). Never mix editable copies.
7. **Server-side trust boundaries.** The server derives correctness and FSRS
   ratings for objective questions from the assessment manifest; it never
   trusts client `is_correct`/`rating`. Review events form a causal DAG
   (`parent_event_id`); scheduling state is produced by deterministic replay.

## Naming

- Project name: **Safwa**. Older files/strings may say "SarfMaster" — update
  text references when touching them, but never rename data files, JSON keys,
  or IDs without an explicit migration decision.
- The enriched dataset on disk is `data/safwa-vocabulary.v2.json`. The Python
  scripts' `V2_FILE` constants must point at this name (fixed in Phase 0).

## Commands

```bash
python scripts/enrich-vocabulary.py     # deterministic regeneration of enriched data (no pnpm wrapper)
```

App: `pnpm dev`, `pnpm build`, `pnpm test` (Vitest unit tests),
`pnpm test:integration` (Vitest against Postgres — constraints, content
registration, Better Auth, manifest loader), `pnpm test:e2e` (Playwright,
runs the default + auth-disabled + auth-rate-limit configs), `pnpm typecheck`,
`pnpm lint`, `pnpm format:check`, `pnpm validate:data`
(`scripts/validate-vocabulary.py`, must exit 0), `pnpm verify:arabic`
(`scripts/arabic-extract.py --verify-known`), `pnpm content:build`
(regenerates `public/content`/`content-server` from the vocabulary data),
`pnpm docs:verify` (checks doc Arabic placeholders), `pnpm content:verify`
(content:build + docs:verify), `pnpm check` (typecheck + lint + format:check
+ test + build).

Server/database (added Phase 15 — Postgres, Drizzle, Better Auth, email):
`docker compose up -d db` starts the local `postgres:17-alpine` container
(`compose.yaml`) providing both the `safwa_dev` and disposable `safwa_test`
databases; `pnpm db:generate` / `pnpm db:check` (Drizzle Kit schema
generation/check), `pnpm db:migrate`, `pnpm db:register-content`, `pnpm
db:test:reset` (hard-gated to `safwa_test(_\w+)?` + `NODE_ENV=test`),
`pnpm email:clear-outbox`. See `docs/DEPLOYMENT.md` for env var setup
(`.env.local` from `.env.example`, `DATABASE_URL`).

`scripts/quality-gate.ps1` runs the full CI-equivalent check sequence
locally: dependency/data/Arabic checks, content-artifact freshness, docs
verification, disposable-Postgres reachability + migrations +
content-version registration + `test:integration` (against `safwa_test`,
derived from `.env.local`'s `DATABASE_URL`), typecheck/lint/format, the
push-guard hook self-tests, unit tests, build, and E2E. `-SkipE2E` skips
only the E2E step for fast inner-loop iteration — the full gate (E2E
included) must still pass before review.

## Document map

- `docs/PRODUCT_REQUIREMENTS.md` — what to build, learning/quiz rules, acceptance criteria
- `docs/ARCHITECTURE.md` — stack, module boundaries, ADRs
- `docs/DATA_MODEL.md` — Postgres + Dexie schemas, component identity, event model
- `docs/OFFLINE_AND_SYNC.md` — causal sync design, conflict policy, staged rollout
- `docs/phases/IMPLEMENTATION_PHASES.md` — the 23 phases (0–22); implement one
  at a time. Later phases have expanded detail docs alongside it
  (`docs/phases/phases-12.md`, `-13.md`, `-14.md`, `-15.md`, ...) — read the
  matching detail doc for a phase if one exists.
- `docs/TEST_STRATEGY.md` — required tests per layer and per phase
- `docs/DEPLOYMENT.md` — environments, hosting, migrations, backups
- `docs/RISK_REGISTER.md` — known risks and mitigations
- `docs/vocabulary-schema.md`, `docs/vocabulary-audit.md`,
  `docs/manual-review-required.md` — existing data-layer docs (do not edit;
  they are maintained by the enrichment tooling)

## Phase implementation workflow (permanent rules)

- **`/phase-loop` is the standard implementation workflow** for every phase:
  branch → implement → quality gate → Claude review → draft PR. See
  `.claude/skills/phase-loop/SKILL.md`.
- **Review is done by the `phase-code-reviewer` subagent** — a strictly
  read-only reviewer (Read/Grep/Glob/Bash/PowerShell only; never edits,
  commits, pushes, merges or opens PRs).
- **Reviewer findings are fixed only by Claude.** Every finding is either
  fixed or explicitly rebutted with a technical rationale — never silently
  ignored.
- **No PR until the review approves.** A pull request may be created only
  after the quality gate passes AND the `phase-code-reviewer` subagent
  returns `APPROVED`. PRs are always created as drafts.
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
  PreToolUse hook, which blocks these regardless of argument position.
