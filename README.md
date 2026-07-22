# Safwa

Safwa is a responsive Arabic vocabulary-learning web application built on the
thulāthī mujarrad vocabulary of the _Safwa-tul-Maṣādir_ / _Cream of Arabic_
material. It helps learners memorise verb meanings, the supplied forms of each
verb (māḍī, muḍāriʿ, maṣdar, ism al-fāʿil, amr, nahī), three-letter roots, the
bāb of each verb, and its morphological category — through flashcards,
multiple-choice quizzes, focused ṣarf quizzes, spaced repetition (FSRS),
progress tracking and weak-area analysis. Guests can study immediately;
optional accounts add cross-device synchronisation.

> The project was earlier developed under the working name **SarfMaster**; the
> name is now **Safwa**. Phase 0 resolved the naming drift (text references
> only — data files, JSON keys and IDs were never renamed).

## Repository layout

| Path                                | Purpose                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `data/safwa-mujarrad.original.json` | **Immutable** transcription of the printed source (455 entries). Never modified.                                         |
| `data/safwa-vocabulary.v2.json`     | Enriched application dataset (schema 2.2.0): roots, provenance, field-level quiz eligibility, derived forms, statistics. |
| `data/mazid-fih-patterns.json`      | Forms II–X pattern templates (educational patterns, no lexical claims).                                                  |
| `data/mazid-fih-candidates.json`    | 21 unverified mazīd fīh seed candidates — **not** production-ready, quiz-ineligible.                                     |
| `data/.review-rows.json`            | Machine-readable manual-review queue (64 rows).                                                                          |
| `scripts/enrich-vocabulary.py`      | Regenerates the enriched dataset from the original (deterministic, idempotent).                                          |
| `scripts/validate-vocabulary.py`    | Validates preservation, provenance, eligibility and review integrity (34,489 checks).                                    |
| `docs/vocabulary-schema.md`         | Field-by-field data schema and safety rules.                                                                             |
| `docs/vocabulary-audit.md`          | Audit of the data foundation.                                                                                            |
| `docs/manual-review-required.md`    | Human-readable review queue (byte-synced with `.review-rows.json`).                                                      |

## Planning documents

| Document                                                                     | Contents                                                                                                                                      |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [docs/PRODUCT_REQUIREMENTS.md](docs/PRODUCT_REQUIREMENTS.md)                 | Vision, MVP/post-MVP scope, learning & quiz rules, progress definitions, acceptance criteria                                                  |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                                 | Stack, rationale, module boundaries, auth, PWA, security, ADRs                                                                                |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md)                                     | Conceptual model, tables, constraints, FSRS representation, content versioning, merge model                                                   |
| [docs/OFFLINE_AND_SYNC.md](docs/OFFLINE_AND_SYNC.md)                         | Guest persistence, mutation queue, causal event graph, conflict resolution, staged rollout                                                    |
| [docs/phases/IMPLEMENTATION_PHASES.md](docs/phases/IMPLEMENTATION_PHASES.md) | 23 small, individually testable phases with milestones (later phases have expanded detail docs alongside it, e.g. `docs/phases/phases-15.md`) |
| [docs/TEST_STRATEGY.md](docs/TEST_STRATEGY.md)                               | Testing pyramid, required suites, per-phase minimums, CI gates                                                                                |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)                                     | Local setup, hosting, migrations, backups, rollback, cost assumptions                                                                         |
| [docs/RISK_REGISTER.md](docs/RISK_REGISTER.md)                               | Project risks with likelihood, impact, mitigation                                                                                             |

## Data-safety principles (non-negotiable)

1. **The original source file is immutable.** `data/safwa-mujarrad.original.json`
   is source evidence; it is never edited or regenerated.
2. **Quiz eligibility is mandatory metadata.** The presence of a value never
   means it may be taught. Application code must check the per-field
   `quiz_eligibility` booleans; generated forms and mazīd candidates are
   quiz-ineligible until independently verified.
3. **Arabic strings are never hand-copied.** Any Arabic value that must match
   the source is extracted programmatically from the JSON (see
   [CLAUDE.md](CLAUDE.md) for the full rule). Visually rendered terminal output
   is never trusted as evidence of correctness.
4. **Provenance is preserved.** Source-transcribed, internally-validated,
   algorithmically-derived, needs-review and (future) independently-verified
   values are always distinguishable.

## Data maintenance

```bash
python scripts/enrich-vocabulary.py    # regenerate enriched dataset (never touches the original)
python scripts/validate-vocabulary.py  # must exit 0 — 34,489 checks
pnpm content:build                     # regenerate the immutable content-release artifacts
pnpm docs:verify                       # verify documentation Arabic against the datasets
```

Content releases (`public/content/`, `content-server/`) are **generated,
committed and deterministic** — never edit them by hand; CI fails if they
drift from the source data. `content-server/` is a server trust boundary
and must never be served publicly (see `content-server/README.md`).

> Note: the scripts' path constants were corrected in Phase 0 from the old
> `sarfmaster-vocabulary.v2.json` working name to the actual
> `safwa-vocabulary.v2.json`.

## Source attribution

The vocabulary is transcribed from published learning material
(_Safwa-tul-Maṣādir_ / _Cream of Arabic_). See
[docs/RISK_REGISTER.md](docs/RISK_REGISTER.md) for redistribution
considerations. This project claims no official affiliation with the source
material's publishers.
