# Safwa — Data Model

Status: planning baseline (Architecture Plan v4, approved 2026-07-14).
SQL shown is design-level; Drizzle migrations are authored in the phases that
introduce each table. Arabic examples use the programmatic placeholder
mechanism (`CLAUDE.md`).

## 1. Conceptual model

```
Content (immutable, versioned)          Learning state (per user/guest)
────────────────────────────           ─────────────────────────────────
content release ── entries              study_components (FSRS cards)
validation manifest                        ▲ 1:N
assessment manifest (server-only)       review_events (causal DAG, immutable)
skill_types / babs / verb_types            ▲ 1:1 optional
                                        study_attempts (every answer)
                                        study_sessions · daily_activity
                                        bookmarks · custom_lists · settings
```

Principles: content is immutable and versioned; learning state references
content by stable ids + `content_version`; every answer is an attempt; only
scheduling-qualifying attempts create review events; server FSRS state is the
deterministic replay of accepted scheduling events in causal order.

## 2. Identity and component model

**Translation components** `(entry_id, skill_type, source_field, direction)`
— source fields `madi|mudari|masdar|ism_fail|amr|nahi`, directions
`arabic_to_english|english_to_arabic`.
**Entry-level components** `(entry_id, skill_type)` for `bab_identification`,
`root_identification`, `verb_type_identification` (prompt form recorded on
the attempt, not in identity).

**Shared natural key** (one builder function used by client and server; the
builder rejects skill/shape/field/direction mismatches):

```
form:        entry:{entryId}:skill:{skillId}:field:{field}:direction:{direction}
entry-level: entry:{entryId}:skill:{skillId}
```

Components are **materialised lazily on first attempt**. Progress denominators
come from the content release's eligibility matrix, never from row counts.
Ceiling ≈ 455 × 12 form components + 455 × 3 entry-level ≈ 6,800 minus
ineligible fields.

## 3. Lookup tables (no Postgres enums for evolving concepts)

```sql
CREATE TABLE skill_types (
  id text PRIMARY KEY,                      -- 'meaning_recognition', ...
  component_shape text NOT NULL,            -- 'form_direction' | 'entry_level'
  display_name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  CONSTRAINT skill_types_component_shape_check
    CHECK (component_shape IN ('form_direction', 'entry_level')),
  CONSTRAINT skill_types_id_shape_unique UNIQUE (id, component_shape)
);
```

Initial rows: `meaning_recognition`, `meaning_recall` → `form_direction`;
`bab_identification`, `root_identification`, `verb_type_identification` →
`entry_level`. Future skills declare a shape explicitly; genuinely new shapes
(e.g. `form_transformation`, `pronoun_conjugation`) arrive via additive
migrations that extend the CHECK and index set — the two current shapes are
not assumed permanent.

`babs(id text PK, arabic_display text, ...)` and
`verb_types(id text PK, arabic_display text, ...)` are lookup tables seeded
from the content pipeline (ids `nasara…hasiba`, `sahih…lafif_maqrun`); Arabic
display values come from the dataset (e.g. نَصَرَ يَنْصُرُ).
Provenance statuses, sync/attempt/event statuses: constrained text + CHECK,
validated by Zod — additive evolution, no enum migrations.

## 4. `study_components`

```sql
CREATE TABLE study_components (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  entry_id integer NOT NULL,
  skill_type_id text NOT NULL,
  component_shape text NOT NULL,
  source_field text NULL,
  direction text NULL,
  -- FSRS state (authoritative = replay of accepted scheduling events)
  stability double precision, difficulty double precision,
  due_at timestamptz, fsrs_state text,
  reps integer NOT NULL DEFAULT 0, lapses integer NOT NULL DEFAULT 0,
  last_review_at timestamptz,
  revision bigint NOT NULL DEFAULT 0,       -- authoritative server revision
  learner_state text NOT NULL DEFAULT 'not_started',
  CONSTRAINT study_components_skill_shape_fk
    FOREIGN KEY (skill_type_id, component_shape)
    REFERENCES skill_types (id, component_shape),
  CONSTRAINT study_components_shape_check CHECK (
    (component_shape = 'form_direction'
       AND source_field IS NOT NULL AND direction IS NOT NULL)
    OR (component_shape = 'entry_level'
       AND source_field IS NULL AND direction IS NULL)
  ),
  CONSTRAINT study_components_source_field_check
    CHECK (source_field IS NULL OR source_field IN
      ('madi','mudari','masdar','ism_fail','amr','nahi')),
  CONSTRAINT study_components_direction_check
    CHECK (direction IS NULL OR direction IN
      ('arabic_to_english','english_to_arabic'))
);

CREATE UNIQUE INDEX study_components_form_unique
  ON study_components (user_id, entry_id, skill_type_id, source_field, direction)
  WHERE component_shape = 'form_direction';
CREATE UNIQUE INDEX study_components_entry_unique
  ON study_components (user_id, entry_id, skill_type_id)
  WHERE component_shape = 'entry_level';
CREATE INDEX study_components_due ON study_components (user_id, due_at);
```

The composite FK makes PostgreSQL itself guarantee a component's shape matches
its skill type (a duplicated column + local CHECK cannot). Partial unique
indexes are predicated on `component_shape` (clearer than nullability and
robust to NULL-distinctness semantics). The DB validates **structure**; the
validation manifest validates **content eligibility** (whether this field is
eligible for this entry).

## 5. `study_attempts` (every submitted answer)

```
id uuid PK · user_id (or local profile pre-merge) · session_id
study_component_id · entry_id · skill_type_id · source_field · direction
prompt_field · prompt_ref {entry_id, field}
selected_answer_ref {entry_id, field} · correct_answer_ref {entry_id, field}
is_correct boolean            -- server-derived for objective attempts
is_first_attempt · is_reinforcement · hint_used · hint_type
response_time_ms · question_position · mode (flashcard|mc|test|timed|timed_test)
option_count                  -- MC options generated (absent ⇒ 4, pre-Phase-11)
per_question_limit_ms         -- timed grading limit (absent ⇒ 20000 for timed
                              -- modes, pre-Phase-11; null ⇒ untimed)
question_instance_id · question_seed · question_generator_version
occurred_at_utc · timezone_at_event · utc_offset_minutes_at_event
local_date_at_event · timezone_source (browser_detected|user_setting|server_fallback)
device_id · content_version
```

Answers are stable **references** (entry + field), not copied Arabic text; the
server resolves them via the assessment manifest. Indexes:
`(user_id, occurred_at_utc)`, `(user_id, entry_id)`,
`(user_id, local_date_at_event)`.

## 6. `review_events` (immutable causal DAG)

```
event_id uuid PK (client-generated, UUIDv7)
study_component_id · attempt_id · rating (again|hard|good|easy)
status (scheduling | reinforcement | conflict_demoted | revoked | pending_parent)
-- causal lineage
base_server_revision bigint       -- server revision known when the local chain began
parent_event_id uuid NULL         -- preceding scheduling event (server-accepted or
                                  -- local unsynced); NEVER a reinforcement attempt
client_component_revision bigint  -- monotonic within the client's local chain
-- ordering
occurred_at_client timestamptz    -- as submitted, never altered
occurred_at_canonical timestamptz -- clamped once at ingestion (see §8)
server_received_at timestamptz
device_id · client_sequence · session_id · content_version
-- event-time dates (immutable history)
timezone_at_event · utc_offset_minutes_at_event · local_date_at_event · timezone_source
```

Unique on `event_id` (idempotent ingestion). Indexes:
`(study_component_id, occurred_at_canonical)`, `(user_id, server_received_at)`,
partial on `status = 'pending_parent'`.

Event-time date rules: `local_date_at_event` is computed at event creation
from the then-active IANA zone and is **immutable**; the server recomputes it
from `occurred_at_utc` + `timezone_at_event` on ingestion and stores its
corrected value (flag `timezone_corrected`) when the client's claim is
implausible. Changing the user's timezone affects future events only.

## 7. Sessions, activity, lists, settings, audit

- `study_sessions`: id, user_id, mode, config (filters, counts, timed/test),
  content_version, started/ended, aggregate results.
- `daily_activity(user_id, local_date, attempts, reviews, new_items,
study_ms)` — **derived cache** rebuilt from attempts/events; unique
  `(user_id, local_date)`.
- `bookmarks(user_id, entry_id)` unique pair;
  `custom_lists(id, user_id, name)` + `custom_list_entries(list_id, entry_id)`
  unique pair.
- `user_settings(user_id PK, timezone, theme, arabic_font_scale,
daily_new_target, daily_review_target, defaults..., updated_at)`.
- `guest_imports(id, user_id, device_id, imported_at, event_count,
attempt_count, result)` — merge audit + idempotency anchor.
- `admin_audit_log` (phase 21): actor, action, target, before/after refs,
  occurred_at.
- `content_versions(release_id PK, content_version, schema_version,
created_at, checksum_release, checksum_validation, checksum_assessment,
release_status active|supported|revoked, minimum_supported_client_version,
minimum_supported_event_schema)` — manifests retained **indefinitely**;
  releases stay sync-compatible unless explicitly revoked for cause.

## 8. FSRS representation and replay

- One ts-fsrs card per study component; card fields live on
  `study_components` and are **always reproducible** by replaying accepted
  `scheduling` events in causal order.
- Causal order = topological order of the event DAG; independent branches are
  ordered by `(occurred_at_canonical, server_received_at, device_id,
client_sequence, event_id)` — total because `event_id` is unique.
- `occurred_at_canonical` = `occurred_at_client` clamped at ingestion to
  (a) ≤ `server_received_at` (+~2 min jitter tolerance, then capped) and
  (b) ≥ the same device's previous accepted event; missing/absurd client
  times → `server_received_at` + flag `clock_suspect`.
- Concurrency (see `OFFLINE_AND_SYNC.md` §5 for the full policy): two
  scheduling events are concurrent iff neither is an ancestor of the other,
  they branch from the same causal parent/equivalent authoritative state, and
  neither's local history includes the other. Losing branches (pessimistic
  rating wins; ties by canonical order) and their scheduling descendants
  become `conflict_demoted`.
- Learner-state projection (`not_started → learning → mastered ↔
needs_review`) is recomputed from replayed state + distinct qualifying
  mastery dates (stored `local_date_at_event` of accepted authoritative
  Good/Easy scheduled reviews; ≥3 distinct dates ⇒ mastered when not due).

## 9. Dexie (IndexedDB) mirror — guests and offline

| Store                                                   | Key                    | Notes                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `content_releases`                                      | `release_id`           | cached learner releases + active pointer                                                                                                                                                                                                                                |
| `study_components`                                      | **natural key string** | same logical identity as Postgres by construction                                                                                                                                                                                                                       |
| `review_events`                                         | `event_id`             | local causal chain; `parent_event_id`, `client_component_revision`, sync status (`local                                                                                                                                                                                 | pushed | accepted | demoted | rejected`) |
| `study_attempts`                                        | `id`                   | full attempt records pending push                                                                                                                                                                                                                                       |
| `daily_activity`                                        | `localDate`            | REBUILDABLE derived cache (schema v3, Phase 12): per-local-date attempts/reviews/new items/study ms + `derivedAt`; atomically cleared and rewritten from `study_attempts` + `review_events` on every dashboard/progress load; never authoritative, excluded from export |
| `sessions`, `bookmarks`, `lists`, `settings`, `profile` | —                      | local equivalents                                                                                                                                                                                                                                                       |
| `mutation_queue`                                        | seq                    | ordered outbound mutations with idempotency keys                                                                                                                                                                                                                        |

The published app configuration ships authoritative skill metadata
(`skill_type_id, component_shape, allowed_source_fields, allowed_directions`);
the shared key builder enforces identical component identity on both sides.

## 10. Guest→account merge (data flow)

1. User consents to merge after sign-in/registration.
2. Client submits guest attempts + events (original ids, timestamps,
   event-time timezone metadata, lineage) through the **normal ingestion
   pipeline** — dedupe by `event_id`, plausibility checks, canonical
   clamping, DAG construction, conflict policy, replay.
3. Bookmarks/lists: set union (dedupe on entry id / list name). Settings:
   account values win; guest fills gaps.
4. `guest_imports` records the import; resubmitting the same events is a
   no-op (idempotent).
5. Local stores are re-keyed to the account; local optimistic state is rebased
   onto the server's replayed result.

## 11. Content versioning & staged persistence

- **Stage 1 (Phases 3–20):** no vocabulary tables in Postgres. The enriched
  JSON is the authoring authority; the pipeline publishes immutable release
  artifacts; `content_versions` + manifest storage are the server's only
  content knowledge.
- **Stage 2 (Phase 21):** operational tables (`vocabulary_entries` with
  structured source fields + provenance columns
  `source_transcribed | internally_validated | algorithmically_derived |
needs_review | verified | curated`, `entry_field_eligibility`,
  `additional_forms`, `mazid_candidates`, review queue). One-time cutover:
  idempotent import keyed on immutable source ids; from then on the DB is the
  editable authority and publishing flows DB → same pipeline → immutable
  artifacts. The original JSON remains untouched evidence forever.
- Example flow: enrichment scripts → validated JSON → publish release N →
  clients study pinned to N → events reference N → (later) admin edits DB →
  publish release N+1 → clients upgrade at next session; events from N remain
  valid indefinitely unless N is revoked for cause.

## 12. Migration approach

Drizzle SQL migrations, additive-first (new lookup rows, new columns with
defaults, new tables) — destructive changes require an explicit migration
note + backup verification. Schema versioning of sync payloads via
`minimum_supported_event_schema`. Every migration lands with its phase and is
exercised in CI against a disposable Postgres.
