# CLAUDE.md — project instructions for Safwa

Safwa is an Arabic vocabulary-learning web app. The repo currently contains the
vocabulary data foundation plus planning docs; the application is implemented
phase by phase from `docs/IMPLEMENTATION_PHASES.md`. Read the phase you are
implementing, its prerequisites, and its testing checkpoint before writing code.

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
python scripts/validate-vocabulary.py   # data validation — must exit 0
python scripts/enrich-vocabulary.py     # deterministic regeneration of enriched data
```

App commands (once scaffolded): `pnpm dev`, `pnpm test` (Vitest),
`pnpm test:e2e` (Playwright), `pnpm typecheck`, `pnpm lint`.

## Document map

- `docs/PRODUCT_REQUIREMENTS.md` — what to build, learning/quiz rules, acceptance criteria
- `docs/ARCHITECTURE.md` — stack, module boundaries, ADRs
- `docs/DATA_MODEL.md` — Postgres + Dexie schemas, component identity, event model
- `docs/OFFLINE_AND_SYNC.md` — causal sync design, conflict policy, staged rollout
- `docs/IMPLEMENTATION_PHASES.md` — the 23 phases; implement one at a time
- `docs/TEST_STRATEGY.md` — required tests per layer and per phase
- `docs/DEPLOYMENT.md` — environments, hosting, migrations, backups
- `docs/RISK_REGISTER.md` — known risks and mitigations
- `docs/vocabulary-schema.md`, `docs/vocabulary-audit.md`,
  `docs/manual-review-required.md` — existing data-layer docs (do not edit;
  they are maintained by the enrichment tooling)

## Phase implementation workflow (permanent rules)

- **`/phase-loop` is the standard implementation workflow** for every phase:
  branch → implement → quality gate → Claude review → Codex review → draft PR.
  See `.claude/skills/phase-loop/SKILL.md`.
- **Codex is strictly an independent read-only reviewer** (run via
  `scripts/run-codex-review.ps1` in an ephemeral read-only sandbox). It must
  never edit files, fix findings, commit, push, merge or open PRs.
- **Codex findings are fixed only by Claude.** Every finding is either fixed
  or explicitly rebutted with a technical rationale — never silently ignored.
- **No PR until both reviews approve.** A pull request may be created only
  after the quality gate passes AND the `phase-code-reviewer` subagent AND
  Codex both return `APPROVED`. PRs are always created as drafts.
- **Any code change invalidates prior reviewer approvals** — from both
  reviewers. Re-run the quality gate and both reviews after every correction.
- **Never merge a pull request or deploy automatically.** The human reviews
  and merges every PR manually.
- **Never weaken tests.** Never delete, skip, hollow out or loosen a test to
  make a check or review pass.
- **Never hide review failures.** Failed gates, reviewer rejections and
  unresolved findings are reported verbatim, not smoothed over.
- **Never claim success without evidence.** "Done" requires quality-gate
  output showing every check passed (`scripts/quality-gate.ps1` exit 0).
