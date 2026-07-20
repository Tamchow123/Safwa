# Safwa — Test Strategy

Status: planning baseline (Architecture Plan v4, approved 2026-07-14).

## 1. Pyramid and tooling

| Layer           | Tooling                                                                                  | Scope                                                                         |
| --------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Data validation | Python (`scripts/validate-vocabulary.py`) + Vitest data tests                            | dataset guarantees, content-release integrity                                 |
| Unit            | Vitest                                                                                   | pure-TS modules: study-engine, scheduler, arabic utils, analytics, sync logic |
| Component       | Vitest + Testing Library                                                                 | UI components in isolation                                                    |
| Integration     | Vitest against disposable Postgres (Docker/Neon branch)                                  | DB constraints, auth, ingestion pipeline, merge, admin import                 |
| E2E             | Playwright (chromium + mobile viewport; webkit for the offline/PWA suite where feasible) | user journeys, offline, a11y (axe), dark mode                                 |

Principles: the study engine and scheduler are pure TS with injected clock and
RNG — most product behaviour is unit-testable without a browser. Determinism
is itself a test target (same seed/event set ⇒ identical output). CI runs on
every PR: typecheck, lint, Python data validation, unit + component,
integration; the E2E matrix runs on main and before releases.

## 2. Data-validation suite (Phase 3, rerun every CI)

- Source preservation: 455 entries; enriched == original for all 12 source
  fields (the Python validator's 34,489 checks stay authoritative; the TS
  pipeline re-asserts counts).
- Eligibility counts equal dataset statistics: madi 455 · mudari 454 ·
  masdar 445 · meaning 455 · ism_fail 454 · amr 454 · nahi 454 · bab 455 ·
  verb_type 453 · root 453 · generated 0 · mazid 0.
- Learner release excludes generated additional forms and mazīd candidates;
  assessment manifest includes only learner-approved fields.
- Entries 369/372: root + verb_type ineligible everywhere.
- Duplicate-madi groups (262/275, 297/303, 409/413) present, distinct, with
  distinct muḍāriʿ.
- Bāb distribution: nasara 140 · daraba 127 · fataha 74 · samia 73 ·
  karuma 35 · hasiba 6.
- Import/publish idempotence: two builds ⇒ identical checksums (modulo
  created_at); Phase 21 DB import twice ⇒ identical rows.
- Content-version compatibility: an old release + manifest still validates.

## 3. Arabic integrity suite (Phase 3, rerun every CI)

- Entries 369 and 372 match the immutable original exactly (codepoint
  sequences, via the extraction helper — never string literals typed by
  hand).
- All six `bab_arabic` values match the dataset and are uniform per bāb.
- Duplicate-madi groups match by exact codepoints.
- NFC status asserted on every Arabic source field.
- Normalisation utility: NFC + invisible stripping (U+200B–200F, U+061C,
  U+FEFF, U+2060) + trim only; ḥarakāt/shaddah/hamzah differences preserved
  (table tests with near-miss pairs).
- `pnpm docs:verify`: every `{{entry:…}}`/`{{bab:…}}` placeholder in docs
  resolves and every filled value matches the JSON; fails on unresolved
  placeholders or drifted values (guards against manually reconstructed or
  visually reordered Arabic in documentation).

## 4. Study-engine unit suite (Phase 6)

- Component granularity: māḍī recognition mastered while maṣdar recognition
  stays Learning; Ar→En and En→Ar progress independently; bāb remains one
  component across varied prompt forms; ineligible-field components are never
  created or selected (property test over all entries × skills).
- Question generation: deterministic per seed; regeneration from a recorded
  spec reproduces the identical question; four unique options post-
  normalisation; correct answer present exactly once; no ineligible
  distractors; duplicate-surface-form entries never co-occur ambiguously.
- Session machine: wrong-then-correct ⇒ two attempts, flags
  `is_first_attempt`/`is_reinforcement` correct; repeated incorrect tracked;
  undo removes exactly the last action; timed expiry = incorrect; test mode
  defers feedback.
- Natural-key builder: valid keys round-trip; skill/shape/field/direction
  mismatches rejected; client and server builders byte-identical outputs.

## 5. Scheduler unit suite (Phase 7)

- Rating table: correct→Good; hinted-correct→Hard; incorrect (hinted or
  not)→Again; I-know→Good; I-don't-know→Again; recovery creates **no** event.
- Sequential local chains: 2 and 3 offline reviews all schedule, parents
  linked, `client_component_revision` monotonic.
- Mastery days: only accepted authoritative Good/Easy scheduled reviews on
  distinct stored `local_date_at_event`; Hard never advances; initial
  learning date excluded; three-days rule; reinforcement never advances.
- Event-time dates: DST transitions; near-midnight boundaries; timezone
  change leaves history unchanged and cannot duplicate study days.
- Replay: event list ⇒ card state reproducible bit-for-bit; golden files
  against ts-fsrs reference behaviour.

## 6. Database integrity suite (Phase 15, integration)

- Composite FK: root skill stored as `form_direction` rejected; recognition
  skill as `entry_level` rejected.
- Shape CHECKs: form component with NULL direction rejected; entry-level with
  a source_field rejected; invalid source_field/direction text rejected.
- Partial unique indexes: duplicate form and entry-level components rejected;
  distinct fields/directions coexist.
- Dexie parity: the same fixture set materialises identical component keys in
  both stores.
- An unknown future shape fails safely (insertable into skill_types only with
  an explicit CHECK extension).

## 7. Sync & canonical-correctness suite (Phase 16, integration)

- Idempotency: same `event_id` twice ⇒ stored once, same response.
- Tampering: false `is_correct`; `Good` for a wrong answer; `Hard` without
  hint; option outside the reconstructed set; altered correct-answer ref;
  tampered component key; ineligible target — all corrected/rejected, FSRS
  unchanged, audit-logged, generic client response.
- Reconstruction: server re-derives the honest client's exact result from
  seed + generator version + assessment manifest; Arabic answer refs resolve
  to exact approved values; root/bāb/verb-type correctness server-derived.
- Flashcards: I-know/I-don't-know accepted; `Easy`/arbitrary ratings
  rejected.
- Generator/version: unknown `question_generator_version` rejected
  recoverably; older supported release verifiable; unknown entry / unknown
  content version / revoked release rejected correctly.
- Timezone plausibility: implausible client local date corrected + flagged;
  offline events retain original event-time dates through sync.

## 8. Causal-lineage suite (Phase 19, integration + property tests)

- Sequential single-device chains (2, 3 events) accepted in causal order.
- Two devices branch from one parent ⇒ deterministic pessimistic-rating
  winner; ties by canonical order.
- Losing branch with multiple descendants ⇒ all scheduling descendants
  `conflict_demoted`; winner's descendants preserved; demoted events add no
  mastery days or review counts; attempts remain queryable.
- Pending parent: child held, ingested on parent arrival; parent never
  arrives ⇒ recoverable error after TTL; client chain-resubmission recovers.
- Cycles and impossible lineage rejected; duplicate
  `client_component_revision` handled deterministically.
- Replay determinism: shuffled arrival orders of the same event set ⇒
  identical final state (property test).
- Clock skew: sequential events never reclassified concurrent; stale
  `base_server_revision` alone never demotes.
- Legacy fallback: fires only with invalid/missing lineage AND different
  devices AND ≤10 min AND no intervening revision; logged.

## 9. Merge, progress & long-offline suites

- Merge (Phase 17): idempotent; replay of guest+account union matches
  fixtures; bookmarks/lists union; settings account-wins; guest-only and
  interleaved-history scenarios.
- Progress (Phase 12, implemented in `tests/analytics/`): every §6 formula
  against the real generated release — exact denominators asserted
  programmatically (455 entries, 6,793 eligible / 2,717 essential components,
  per-skill and per-form counts); denominators exclude ineligible components;
  word mastery follows the essential-set policy; component vs word mastery
  divergence cases; ISO-date/DST-safe calendar arithmetic; activity honesty
  rules (revoked/rejected excluded, conflict-demoted attempts still count);
  streak today/yesterday grace; Dexie v1→v3/v2→v3 migration and
  `daily_activity` cache-corruption recovery (missing/extra/incorrect rows,
  undo, cache deletion, atomic rollback, read/write transaction split);
  dashboard/progress component suites in `tests/components/`.
- Weak areas (Phase 13, implemented in `tests/analytics/weakness*.test.ts`,
  `tests/study-session/weak-drill.test.ts`, `tests/components/`): the v2
  heuristic against every documented property (first-attempt-only accuracy,
  reinforcement exclusion, recency decay, the FSRS lapse signal, the
  qualification threshold, mastered/due exclusion, untouched-is-never-weak);
  source-form attribution (`sourceField` for translation components,
  `promptField` for entry-level components, never collapsing two prompt
  forms onto one); group aggregation across all six dimensions with the
  minimum-evidence bar; a cross-consumer agreement suite proving the Weak
  Areas page, the mixed-revision weak tier and the Custom Session `weak`
  filter never disagree under one snapshot; the exact weak-set drill planner
  (entry-level prompt-form eligibility, no silent fallback, deterministic
  ranking); the Weak Areas page and weak-drill session components (empty
  states, priority labels, accessible semantics, no raw component keys).
- Bookmarks & custom lists (Phase 14, implemented in `tests/collections/`,
  `tests/components/`, `tests/study-session/custom-session-url.test.ts`,
  `tests/profile/export.test.ts`, `tests/content/db-migration.test.ts`): pure
  name normalisation/uniqueness and membership canonicalisation (dedupe +
  sort); the Dexie persistence adapter (durable-guest-state request BEFORE
  the transaction, race-safe re-reads inside one transaction); the
  collection-axis filter engine (union within the axis, intersection across
  every other axis, an explicit empty selection matching nothing rather than
  falling back to "all entries"); the direct study URL preset parser
  (rejects arbitrary JSON, comma-separated id payloads, component keys,
  filesystem-like paths, empty/overlong values); component suites for the
  bookmark toggle, Saved Vocabulary, custom-list detail and every
  collections dialog; export round-trip through the real write paths
  (creation, canonical membership, rename, entry removal, list deletion,
  bookmark survival across list deletion); and a fresh-v3/reopen-through-
  the-persistence-module suite proving Phase 14 introduced no new Dexie
  migration.
- Long-offline (Phases 16/19): events from an old supported release accepted
  via retained manifests; old release + new protocol requires client upgrade
  but content stays valid; revoked release ⇒ scheduling rejected, local
  history preserved and exportable.

## 10. E2E suite (Playwright)

Journeys (desktop + mobile viewport, dark mode variants on key flows):
guest completes flashcards; guest completes MC both directions; bāb session
with configured prompt form; root quiz excludes 369/372; ineligible fields
never appear (instrumented assertion); guest registers and merges; same
account on a second context converges; custom session filters; scoped reset
with confirmation; offline study + reconnect sync (Phase 18+); two offline
contexts converge (Phase 19+); settings incl. Arabic font scale; axe scans on
every page; keyboard-only and reduced-motion runs of flashcards + one quiz.

Phase 12 dashboard suite (`e2e/dashboard.spec.ts`, implemented): new-guest
zero state (honest zeros, working actions, axe, 320px); the real
study→dashboard happy path through actual guest persistence (never UI-only
seeding); incorrect-attempt streak honesty incl. reinforcement
non-double-consumption; undo refunding targets and activity; timezone-change
immutability (old rows keep zone/date/source, new rows carry the selected
zone with `user_setting`); a DST streak fixture; due-today seeding (overdue +
later-today count, tomorrow + stale-ineligible excluded); daily-target
settings changing denominators only; the full 320px mobile journey; axe on
empty/populated/dark/mobile dashboard, progress and timezone settings.

Phase 13 weak-areas suite (`e2e/weak-areas.spec.ts`, implemented): the
no-evidence state with a Study action; the full bāb-weakness acceptance
journey through a real session (fail first attempts, complete reinforcement,
see it weak, drill exactly it — no strong/unseen component enters the
drill); prompt-form-varied bāb accuracy attributed from the persisted
`promptField`; entries 369/372 protected from verb-type weakness even with
valid non-verb-type evidence; direction ranking without cross-contamination;
reinforcement never inflating the accuracy denominator; recency and FSRS
lapse ranking; "Study again" recomputing the drill plan and excluding
resolved components; mixed-revision due→weak→new ordering; Custom Session
`weak` filter agreement with the Weak Areas engine under one snapshot; the
full 320px mobile journey; axe on the no-evidence, populated, per-dimension,
drill, mobile and dark-mode states.

Phase 14 bookmarks & lists suite (`e2e/collections.spec.ts`, implemented):
bookmarking from Library and from detail (state, no unintended navigation,
reload persistence, Saved Vocabulary reflection); protected duplicate-māḍī
entries bookmarked independently and distinguished by id/route, never by
meaning text; list creation, membership management, rename and reload
persistence; list deletion preserving bookmarks and study state, a safe
deleted-list route, and Custom Session no longer offering it; session-result
bookmarking with unique-entry dedup across MC and flashcard results;
bookmarked-only and list-only Custom Session runs verifying every question
programmatically against the expected set (list-only also verifying the
combined form filter); collection union/intersection verified against exact
expected sets; a selected-empty-collection guard proving no session ever
starts; "Study again" re-planning against a list's current membership after
a seeded mid-flow edit; an export round-trip through a real download,
including canonical membership and the absence of content artifacts and the
`daily_activity` cache; bookmarks/lists surviving a full browser restart via
a persistent context; the full 320px mobile journey across bookmark, list
and session actions; axe scans across every documented collections surface
(Library, detail, Saved Vocabulary empty/populated, custom-list detail,
add-to-list dialog, delete confirmation, Custom Session collections filter,
session results, mobile and dark-mode Saved Vocabulary).

## 11. Additional testing

- **Accessibility:** axe in component tests + E2E; manual screen-reader pass
  (NVDA + VoiceOver) at Phases 12 and 22; contrast tokens tested in both
  themes.
  - Phase 12 manual screen-reader checklist (dashboard overview and its
    live-updating Today values; progress bars announcing exact
    counts/values; the recent-activity chart's table alternative; the
    timezone picker's label and save announcement). **Status: NOT yet
    performed** — it requires a human operating NVDA/VoiceOver, which the
    automated pipeline cannot honestly claim. Automated coverage in the
    meantime: axe scans on every dashboard/progress/settings state (incl.
    dark mode and 320px) and component tests asserting the progressbar
    ARIA values, the SR value table and the `aria-live` region semantics.
- **Responsive:** Playwright viewports 320/768/1280; no horizontal scroll
  assertions; touch-target size lint on interactive components.
- **Arabic rendering:** visual snapshot of representative entries (incl.
  shaddah + dagger-alif cases like entry 413's muḍāriʿ) at all font scales.
- **Security:** dependency audit in CI; auth/authz integration tests; rate
  limits; sync tampering suite (§7); secrets scanning.
- **Performance:** Lighthouse budgets on key pages at Phase 22; content-load
  timing regression check.

## 12. Minimum per-phase requirements

Every phase must add: (a) unit/component tests for its new logic, (b) its
checkpoint list from `IMPLEMENTATION_PHASES.md`, (c) at least one E2E
happy-path if it ships UI, and (d) keep every prior suite green. A phase
without its checkpoint passing is not done — no exceptions.
