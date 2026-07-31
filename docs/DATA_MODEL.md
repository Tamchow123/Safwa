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

## 2a. Better Auth tables (implemented Phase 15)

`users`, `sessions`, `accounts`, `verifications` and `rate_limits` are
**generated and owned by Better Auth's own schema-generation process**
(`@better-auth/drizzle-adapter`, configured in `modules/auth/server.ts`), not
hand-designed here — each is referenced by its Drizzle `modelName` (`users`,
`sessions`, `accounts`, `verifications`, `rate_limits`), which must match the
adapter's schema map exactly or every DB operation fails at runtime with "The
model … was not found in the schema object" (this mismatch is not caught by
constructing the `Auth` instance alone, only by an actual DB call). `role` is
exposed on `users` as a Better Auth `additionalField` with `input: false`, so
Better Auth itself strips any client-supplied `role` from sign-up/update
calls — server-owned by construction, not by a separate check. IDs use
`uuid` generation (`advanced.database.generateId: "uuid"`) to match every
other table's identifier scheme.

Migration authority for these five tables is still **Drizzle**, identical to
every hand-written table below: `drizzle-kit generate` produces the SQL from
the schema definitions in `db/schema/auth.ts`, committed and applied the same
way as any other migration (`DATA_MODEL.md` §12) — Better Auth never runs its
own migration step against a live database in this app.

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
  -- Merge provenance (Phase 17). Set together, by the merge and nothing else,
  -- in the same transaction that admits the imported events. See §4.1.
  merged_at timestamptz NULL,
  merged_from_guest_import_id uuid NULL REFERENCES guest_imports(id),
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

### 4.1 The merge-provenance columns are not the same fact

Three columns carry a guest import's fingerprint and they answer different
questions. Confusing them is how a chain check ends up either too strict or too
generous, so they are set out explicitly (Phase 17, ADR-009).

| Column                                         | On            | Answers                                                                                                                                   |
| ---------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `study_components.merged_at`                   | the component | "has a merge ever united two histories **for this component**?" — the gate that makes a second replay root legitimate rather than corrupt |
| `study_components.merged_from_guest_import_id` | the component | "which import did that" — the provenance behind the gate                                                                                  |
| `review_events.imported_from_guest_import_id`  | an **event**  | "did this individual event arrive by that import?" — how an admitted extra root is told apart from an ordinary one                        |

They are checked at **different moments**, and only one of them is a gate.

`imported_from_guest_import_id` is a property of one **event**, and it decides
**admission**. An arriving event is routed to `classifyMergeLineage` — a
separate entry point from ordinary sync's `classifyLineage`, requiring a
brand-sealed `MergeUnionContext` — only when it carries this id, which only the
authenticated merge coordinator stamps. That routing is where a second root is
permitted or refused, and picking the wrong entry point fails **closed**.

`merged_at` is a property of the component's **shape**, and it governs
**replay**. `allowMergeUnion = merged_at != null` is the whole of replay's
condition: it is a durable record that admission already happened correctly for
this component, and replay trusts it rather than re-deriving it from per-event
provenance it does not load. Every Phase 16 caller passes no mark, so a
never-merged component keeps `partitionScheduling`'s `ChainError` as the loud
detector it has always been.

`merged_from_guest_import_id` is **not a gate at all**. It records which import
did this, for audit and for the rollback ordering in `docs/DEPLOYMENT.md`.
Nothing reads it to make a decision.

The consequence worth stating plainly: **replay is not a second check on
admission**. A bug that let an unstamped root through would not be caught later
by replay, because replay never asks about the event. The defence lives in the
routing, and in the fact that only the merge coordinator can stamp an event —
which is why changes to that path deserve more scrutiny than changes to replay
(RISK_REGISTER #25).

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
device_id · release_id (FK → content_versions, authoritative) · content_version (metadata only)
```

`release_id` — not `content_version` — is the authoritative content identity
(content-hash derived, ADR-003; `modules/study-engine/session.ts`'s own doc
comment): `content_version` is human-readable and MAY REPEAT across a
corrected re-publish, so it cannot by itself disambiguate which release's
manifests generated this attempt. `content_version` is retained purely as
display/debugging metadata.

Answers are stable **references** (entry + field), not copied Arabic text; the
server resolves them via the assessment manifest. Indexes:
`(user_id, occurred_at_utc)`, `(user_id, entry_id)`,
`(user_id, local_date_at_event)`.

Phase 13 weakness attribution reads `is_first_attempt` (reinforcement and
non-first attempts are excluded from evidence), `entry_id`/`skill_type_id`,
and the source form: a `form_direction` component (translation skills)
attributes to its own `source_field`; an entry-level component (bāb/root/
verb-type) has no source field of its own and attributes instead to
`prompt_field`, but only when that field is one of the six source forms —
this is how a bāb attempt prompted with māḍī and a later one prompted with
muḍāriʿ produce separately-attributed evidence instead of collapsing onto
one default form. FSRS lapse counts come from `study_components`, not from
this table.

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
device_id · client_sequence · session_id
release_id (FK → content_versions, authoritative) · content_version (metadata only)
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
  release_id (FK → content_versions, authoritative) + content_version
  (metadata only — see §5's note), started/ended, aggregate results.
- `daily_activity(user_id, local_date, attempts, reviews, new_items,
study_ms)` — **derived cache** rebuilt from attempts/events; unique
  `(user_id, local_date)`.
- `bookmarks(user_id, entry_id)` unique pair;
  `custom_lists(id, user_id, name)` + `custom_list_entries(list_id, entry_id)`
  unique pair. This is the future account-linked mapping; Phase 14 shipped
  only the guest-local Dexie equivalent (§9) with no server component and no
  sync — the eventual account merge for bookmarks/lists is not yet built.
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
  **Registration** (implemented Phase 15, `db/register-content.ts` /
  `pnpm db:register-content`) upserts one row per release id read from the
  built content artifacts (idempotent — re-running for the same release id
  is a no-op) inside a transaction holding a Postgres advisory lock
  (`pg_advisory_xact_lock(hashtext(release_id), 0)`) so concurrent
  registration attempts serialise rather than race; the table's own
  constraint enforces **exactly one** `active` row at a time alongside any
  number of `supported`/`revoked` rows.

## 7a. `api_rate_limits` (request counters, Phase 18.1, migration 0007)

One row per `<bucket>:<account-id>` key, holding a `count` and the
`window_started_at` instant its current fixed window opened. Written by
`modules/http/rate-limit.ts` on every request to `/api/sync/push`,
`/api/sync/pull`, `/api/sync/guest-merge` and `/api/account/settings`.

Three properties are deliberate and worth not "tidying" later:

- **No `user_id` foreign key**, unlike every other table in this document. The
  subject of a limit is a KEY, not necessarily an account — keeping it an opaque
  string means an unauthenticated bucket could be added without a migration, and
  it avoids a cascade delete racing a counter update. This is safe ONLY because
  the rows are ephemeral (at most one window, minutes) and hold no learner data.
  **Do not copy this pattern for a table whose rows outlive a request**; an
  account-owned table without an FK is an orphaned-row problem waiting to
  happen.
- **Not Better Auth's `rate_limits` table** (§2a), despite the near-identical
  shape. Better Auth prunes its own table with a background `deleteMany` whose
  only predicate is `last_request < cutoff` — no key filter — so it deletes rows
  it did not write. Sharing the table would mean these counters silently
  resetting on another component's schedule.
- **Pruned by age, opportunistically**, not by cascade or cron: whoever writes
  next occasionally drops rows older than an hour. A prune that never runs costs
  nothing, because the table is bounded by (buckets × accounts) and an expired
  row is reset by its own next writer.

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

| Store                             | Key                    | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `content_releases`                | `release_id`           | cached learner releases + active pointer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `study_components`                | **natural key string** | same logical identity as Postgres by construction. REBUILDABLE cache, written TWO ways: (a) for genuine on-device study, reprojected from the owner's own `review_events` chain by `writeComponentProjection` (and deleted when that chain empties); (b) for a bootstrapped/anchor-managed component — a device with no complete local chain from revision 1 — overwritten verbatim from the account's authoritative pulled card by `applyPullResponse`, which never reads `review_events`. So a row lost to the §9.1 natural-key claim is recovered by local replay in case (a) and only by the account's NEXT SERVER PULL in case (b) — never from local state alone when anchor-managed. The append-only `review_events` ledger is keyed by unique `event_id` and is never overwritten either way |
| `review_events`                   | `event_id`             | local causal chain; `parent_event_id`, `client_component_revision`, sync status (`local                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | pushed | accepted | demoted | rejected`) |
| `study_attempts`                  | `id`                   | full attempt records pending push                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `daily_activity`                  | `localDate`            | REBUILDABLE derived cache (schema v3, Phase 12): per-local-date attempts/reviews/new items/study ms + `derivedAt`; atomically cleared and rewritten from `study_attempts` + `review_events` on every dashboard/progress load; never authoritative, excluded from export                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `bookmarks`                       | `entryId`              | `{entryId, createdAt}` — the entry id IS the identity, no separate row id. Stores added in schema v2 (SAFWA_DB_VERSION unchanged at 3 for Phase 14 — no migration). Written only via `modules/collections/persistence.ts`, which calls the durable-guest-state request BEFORE its transaction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `lists`                           | `id`                   | `{id (uuidv7), name, entryIds: number[], createdAt, updatedAt}`; `name` is NFC-normalised/trimmed/whitespace-collapsed and case-insensitively unique per guest (1–60 chars, max 50 lists); `entryIds` is always deduplicated and sorted ascending on every write (Phase 14)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `sessions`, `settings`, `profile` | —                      | local equivalents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `mutation_queue`                  | seq                    | ordered outbound mutations with idempotency keys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### 9.1 Local owner scoping (schema v6, Phase 16 R2-F3)

Since Phase 16 a guest's and a signed-in account's private rows can **coexist**
in the same stores — signing in does not require (or trigger) a sign-out wipe
first. Schema **v6** therefore adds a local owner column, `userId`
(`null`/absent = guest, a string = that account), plus owner-scoped indexes to
the five private learner-state stores:

| Store              | Added indexes                                            | Scopes                                             |
| ------------------ | -------------------------------------------------------- | -------------------------------------------------- |
| `review_events`    | `userId`, `[userId+syncStatus]`, `[userId+componentKey]` | push selection + pending count; causal-chain reads |
| `study_components` | `userId`, `[userId+componentKey]`                        | the projected card                                 |
| `bookmarks`        | `userId`, `[userId+entryId]`                             | per-entry lookup                                   |
| `lists`            | `userId`                                                 | the uuid-keyed list rows                           |
| `settings`         | `userId`, `[userId+key]`                                 | account-syncable settings                          |

`study_attempts` carries its owner inside the engine payload
(`attempt.userId`) rather than as a column; `mutation_queue` already had its own
`userId` (v5).

Rules:

- **Reads** are owner-scoped everywhere private learner state is surfaced —
  collections, scheduling selection, the dashboard/progress/weakness analytics
  and "export my data". `modules/content/owner-scope.ts` is the single place
  that implements the comparison (absent and `null` both mean guest) and the
  read split IndexedDB forces (it cannot index `null`, so guest reads scan the
  natural-key index and filter in memory).
- **Login never merges guest rows.** A guest's rows are not uploaded and are not
  visible to the account; the merge is Phase 17 (§10) and requires consent.
- **In v6 primary keys were unchanged** — that release was additive (new
  columns + indexes, no data-moving upgrade), so `userId` scoped reads but was
  _not_ part of a row's identity: a second identity writing the same natural key
  **replaced** the first identity's row. Accepted for Stage A only, and
  superseded by v7 below.
- **Writes resolve the owner at action time** (`useResolveOwner`), never from a
  still-pending session read — a pending read is indistinguishable from
  signed-out and would stamp a signed-in user's row as a guest's.

### 9.2 The owner is part of the key (schema v7, Phase 17 — ADR-009)

v6's read scoping was not enough: the natural key was still the whole identity,
so an account's write physically replaced a guest's row with the same key, and
sign-out had to clear the stores wholesale — destroying a coexisting guest's
rows. That is incompatible with §9.1's promise that declining the merge costs
nothing.

v7 therefore promotes the owner into the **primary key**. Four stores
(`study_components`, `bookmarks`, `settings`, `daily_activity`) are re-keyed to
a compound `[ownerKey+naturalKey]`. `ownerKey` is a total, non-null,
IndexedDB-valid string built by `modules/content/owner-key.ts` — `guest`, or
`account:<user-id>` — because IndexedDB cannot index `null` and a compound key
containing `null` is not a valid key at all, so the nullable `userId` could not
be promoted directly. The value is opaque and branded: a raw user id passed
where an owner key is required is a compile error, not a mis-scoped row.

IndexedDB cannot re-key a store in place, so those four got **new physical
stores** (`study_components_owned`, `bookmarks_owned`, `settings_owned`,
`daily_activity_owned`) with their rows copied forward and the v6 originals
dropped. Specs use the logical names; `e2e/helpers/idb.ts` owns the one map
that knows the difference.

Consequences:

- A guest and one or more accounts **coexist** with no cross-reads and no
  silent overwrites. "Not now" is free, and a deferred merge stays possible.
- Sign-out, account switch and account **deletion** clear rows scoped to one
  owner (`clearAccountLocalState`), never whole stores. Where the departing
  account cannot be resolved the sweep removes every non-guest owner's rows —
  confidentiality does not depend on that lookup succeeding, and the guest's
  rows still survive.
- Deletion is confirmed by an emailed endpoint, so nothing of ours runs when the
  account actually goes. The callback lands on a URL carrying a one-time nonce
  minted when deletion was requested and kept locally; only a matching nonce
  authorises the local clear, so a link with a marker appended cannot wipe a
  live account's unsynced work.
- Current version: **v9** (`SAFWA_DB_VERSION`), which adds the merge's own
  `guest_imports` bookkeeping on top of v7's re-keying.

`study_components` additionally stores a **lineage anchor** written only by a
server pull: `syncedHeadEventId` + `syncedHeadClientRevision`, the authoritative
accepted chain head. A device with no local events for a component (a fresh
bootstrap, or after a sign-out wipe) parents its next review onto that anchor so
it EXTENDS the server chain instead of rooting a branch the server rejects as a
stale-branch conflict.

The published app configuration ships authoritative skill metadata
(`skill_type_id, component_shape, allowed_source_fields, allowed_directions`);
the shared key builder enforces identical component identity on both sides.

## 10. Guest→account merge (data flow, implemented Phase 17)

1. The learner **consents**, after signing in on a device that still holds
   guest data. Nothing is uploaded before that — signing in is not agreement,
   and the prompt states what will move before it asks.
2. The client submits guest attempts + events (original ids, timestamps,
   event-time timezone metadata, lineage) through the **normal ingestion
   pipeline** — dedupe by `event_id`, plausibility checks, canonical clamping,
   DAG construction, conflict policy, replay. A snapshot larger than one
   request is **chunked**, and a chunk's unit is indivisible: an attempt
   travels with every event grading against it, because ingest resolves an
   event's attempt within the request that carries it.
3. Bookmarks/lists: set union (dedupe on entry id / list name). Settings: the
   account's values win and the guest's only fill gaps — a merge must never
   silently replace a preference the learner set while signed in.
4. `guest_imports` records the import under a client-minted import key.
   Resubmitting the same snapshot is a **no-op**, and a _different_ snapshot
   under the same key is refused rather than half-applied.
5. Components that gained an imported history are stamped with `merged_at` +
   `merged_from_guest_import_id`, and the admitted events with
   `imported_from_guest_import_id` (§4.1). Replay for those components accepts
   the resulting **multi-rooted** DAG; everywhere else a second root remains a
   chain error (ADR-009).
6. **Only then**, once the account-owned result is durable, are the guest's
   local source rows dropped and the device's remaining local state re-keyed to
   the account, in one Dexie transaction. Local optimistic state is rebased
   onto the server's replayed result.

**What this is not.** This unites the histories of **two identities** on one
device, once, with consent. Phase 19's device-conflict resolution reconciles
**one identity's** history diverging across devices, continuously and without
asking. They look similar and must not share machinery: the merge's
multi-rooted exemption (§4.1) is scoped to a recorded import and is not
available to a conflict resolver.

### 10.1 Failure, refusal and deferral

- **Refused before anything moves** — an unverified account, a disabled sync
  kill-switch, a snapshot over the ceiling, a mismatched snapshot under a used
  import key, an import key belonging to another account. Each is refused with
  a reason the UI can state, and **no guest row is touched**.
- **Failed mid-flight** — the guest's data is intact by construction, because
  step 6 has not run. The merge is retryable, and the retry is a distinct
  action from a fresh consent: the learner already agreed, and part of the
  import may already be durable.
- **Deferred** — "Not now" uploads nothing and deletes nothing. The offer stays
  reachable from Settings for the rest of the visit and returns on the next
  sign-in, for as long as guest data exists on the device.

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
