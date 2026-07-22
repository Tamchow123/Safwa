 Phase 16 — Online Sync (Stage A): Server-Authoritative Learning State

Implement **Phase 16 — Online sync (Stage A)** for Safwa.

Use the established `/phase-loop` workflow:

```text
/phase-loop Phase 16 — Online sync (Stage A). Implement exactly the Phase 16 requirements in docs/phases/IMPLEMENTATION_PHASES.md and the ingestion, validation, replay, pull/rebase and collection-sync contracts in docs/OFFLINE_AND_SYNC.md, docs/DATA_MODEL.md, docs/ARCHITECTURE.md and docs/TEST_STRATEGY.md. Build authenticated server-authoritative learning-state sync using the existing Phase 15 PostgreSQL, Drizzle, Better Auth and content-manifest foundation. Reconstruct and grade objective questions server-side using the shared study engine and assessment manifests; never trust client correctness or ratings. Add per-item push results, deterministic replay, revisions, pull/rebase, post-sync undo revocations, sync status UI, rejection audit logs and bookmarks/lists/settings sync. Preserve complete guest functionality and local study. Do not begin Phase 17 guest merge, Phase 18 durable offline/PWA queue guarantees or Phase 19 concurrent-branch demotion.
```

Work only on Phase 16.

Do not begin guest-to-account merge, PWA/service-worker work, durable offline queue guarantees, full multi-device offline conflict resolution, concurrent-branch demotion or later production phases.

---

## 1. Required prerequisite

Phase 15 PR **#20** must be:

- Reviewed
- Merged into `main`
- Green in GitHub Actions

Before implementation, confirm `origin/main` contains the merged Phase 15 work:

```text
Phase 15: add server, database and account foundation
```

The Phase 15 foundation that must already exist includes:

- PostgreSQL development/test setup
- Drizzle schema and committed migration
- Better Auth email/password authentication
- Mandatory email verification
- Login, logout and password reset
- Account settings and deletion
- Server learning-state tables
- `content_versions` registration
- Checksummed server validation and assessment manifests
- Disposable-Postgres integration-test infrastructure
- `AUTH_ENABLED` feature flag
- Guest independence and local-only guest state
- `/api/health`
- CI and `scripts/quality-gate.ps1` server checks

Do not build Phase 16 directly on `phase/15-server-foundation`.

Stop and report if Phase 15 is not merged or the current `origin/main` quality gate is red.

---

## 2. Required branch

Create:

```text
phase/16-online-sync-stage-a
```

from the latest merged `origin/main`.

Do not reuse an older phase branch.

Do not stack Phase 16 on an unmerged pull request.

---

## 3. Read the repository before planning

Read all repository instructions and current architecture before editing:

```text
CLAUDE.md
README.md

docs/PRODUCT_REQUIREMENTS.md
docs/ARCHITECTURE.md
docs/DATA_MODEL.md
docs/OFFLINE_AND_SYNC.md
docs/TEST_STRATEGY.md
docs/DEPLOYMENT.md
docs/RISK_REGISTER.md

docs/phases/IMPLEMENTATION_PHASES.md
docs/phases/phases-13.md
docs/phases/phases-14.md
docs/phases/phases-15.md

docs/adr/*
```

Inspect the current implementation, especially:

```text
package.json
pnpm-lock.yaml
tsconfig.json
next.config.*
vitest.config.*
playwright.config.ts
.github/workflows/ci.yml
scripts/quality-gate.ps1

compose.yaml
drizzle.config.ts
db/schema/*
db/migrations/*
db/register-content.ts
db/rollback/*
tests/integration/*

content-server/README.md
content-server/release-registry.json
content-server/releases/*/validation.json
content-server/releases/*/assessment.json
content-server/releases/*/checksums.json
public/content/active.json
public/content/releases/*/learner.json

modules/auth/*
modules/email/*
modules/env/*
modules/content/server-manifests.ts
modules/content/server-release-registry.ts
modules/content/schema.ts
modules/content/constants.ts

modules/study-engine/*
modules/scheduler/*
modules/profile/*
modules/collections/*
modules/analytics/*
modules/study-session/*

components/study/*
components/nav/*
components/account/*
app/api/*
app/(shell)/account/*
```

Pay particular attention to the exact existing wire shapes for:

- attempt records
- review events
- question specifications
- component natural keys
- skill, shape, source-field and direction combinations
- generator versions
- FSRS ratings
- hint recording
- timed/test delivery modes
- option counts
- timezone metadata
- session identifiers
- Dexie stores
- bookmarks, lists and settings
- account/session retrieval

Search the repository for:

```text
event_id
attempt_id
review_event
parent_event_id
base_server_revision
client_component_revision
question_instance_id
question_seed
question_generator_version
allowed_answer_refs
correct_answer_ref
selected_answer_ref
is_correct
rating
hint_used
hint_type
occurred_at
occurred_at_canonical
local_date_at_event
timezone
clock_suspect
revision
pending_parent
conflict_demoted
revoked
mutation_queue
sync
rebase
AUTH_ENABLED
content_versions
assessment manifest
validation manifest
```

The merged implementation is authoritative where it is stricter or more developed than the original planning baseline. Do not overwrite established contracts merely to match older prose.

---

## 4. Verify current official library contracts

Before writing route handlers, database transactions or auth/session code, verify the current official documentation for the versions pinned in the repository:

- Next.js App Router route handlers
- asynchronous cookies/headers APIs
- server-only module boundaries
- Better Auth server-session retrieval and route protection
- Drizzle ORM PostgreSQL transactions, conflict clauses, locking and constraints
- PostgreSQL recursive CTEs or alternative safe cycle-detection approaches, if needed
- Zod parsing and discriminated unions
- Dexie transactions and live-query behaviour
- Vitest integration testing
- Playwright multi-context/browser-context testing

Use primary official documentation only.

Do not upgrade dependencies unless Phase 16 genuinely requires it. Any upgrade must be minimal, stable, pinned and justified.

Do not install a second validation, state-management, queueing or API framework when the current stack can implement the requirement cleanly.

---

## 5. Preflight

Run:

```powershell
git status --porcelain
git branch --show-current
git fetch origin
git log --oneline -20 origin/main

node --version
pnpm --version
python --version
docker --version
docker compose version

pnpm install --frozen-lockfile

docker compose up -d db
pnpm db:migrate
pnpm db:register-content

powershell -ExecutionPolicy Bypass -File scripts/quality-gate.ps1
```

Confirm:

- The working tree is clean.
- Phase 15 is merged into `origin/main`.
- The new branch starts from current `origin/main`.
- The repository’s Node and pnpm requirements are satisfied.
- PostgreSQL is reachable.
- The full migration chain succeeds from an empty database.
- Content registration succeeds.
- All Phase 0–15 checks pass before editing.
- Generated content artifacts are current.
- The active learner release still contains 455 entries.
- Nothing under `data/` is changed.
- Guests can still study with `AUTH_ENABLED=false`.
- Signed-in study is currently local-only before this phase.

Stop rather than stashing, resetting, deleting or overwriting user work.

Record preflight evidence and assumptions in the phase-loop state.

---

## 6. Phase objective

Deliver authenticated, online, server-authoritative learning-state synchronisation.

A signed-in learner must be able to:

1. Complete a local study session using the existing client engine.
2. Push attempts and scheduling events to the authenticated server.
3. Receive a per-item result for every submitted item.
4. Have objective questions reconstructed and graded by the server.
5. Have accepted scheduling events replayed into authoritative component state.
6. Pull authoritative changes since a known revision.
7. Rebase local optimistic state onto server state.
8. Undo an already-synced scheduling event through a revocation mutation.
9. See an honest sync-status indicator.
10. See the same accepted progress in another browser context after synchronisation.
11. Synchronise bookmarks, custom lists and account settings with the documented conflict semantics.

The server must be the authority for:

- objective correctness
- derived rating
- accepted scheduling history
- component revision
- replayed FSRS state
- event status
- canonical event time
- collection/account sync state

The client remains responsible for:

- local immediate study interaction
- optimistic local persistence
- deterministic question specifications
- initiating sync
- applying server reconciliation
- retaining complete local attempts
- displaying sync status

---

## 7. Hard phase boundaries

### In scope

- Authenticated push ingestion
- Authenticated pull/rebase
- Per-item API results
- Event/attempt idempotency
- Server-side manifest validation
- Server-side deterministic question reconstruction
- Server-derived correctness and rating
- Timezone plausibility checks and canonical timestamp clamping
- Serial causal-chain acceptance
- Unknown-parent holding
- Cycle/impossible-lineage rejection
- Deterministic replay
- Component revision bumps
- Post-sync undo revocations
- Server rejection audit logging
- Client sync orchestration while online
- Session-end and active-interval push
- Honest sync-status UI
- Bookmarks, lists and settings sync
- Cross-browser online-sync E2E proof
- Feature flag / kill switch for sync
- Documentation and full tests

### Explicitly out of scope

- Phase 17 guest-to-account merge
- Uploading pre-registration guest history automatically
- `guest_imports` workflow beyond preserving the Phase 15 schema
- Service worker or installable PWA
- Background Sync API
- Guaranteed durable offline mutation queue behaviour
- Exponential backoff/dead-letter UX required by Phase 18
- Full concurrent offline branch resolution
- Pessimistic winner selection between concurrent branches
- Descendant demotion to `conflict_demoted`
- Legacy 10-minute concurrency fallback
- Multi-device offline correctness claims
- Content authoring or vocabulary changes
- New quiz types
- Changes to natural-key identity
- OAuth, passkeys, magic links or 2FA
- Admin dashboard

Phase 16 may preserve schema/status support for later states, but must not pretend later-stage behaviour is implemented.

---

## 8. Trust boundaries and non-negotiable rules

### 8.1 Never trust client grading

For objective attempts, do not trust client-provided:

- `is_correct`
- `rating`
- correct answer
- allowed option set
- target value
- entry metadata
- eligibility
- component shape
- natural-key decomposition

The server must reconstruct and derive these values independently.

Client values may be retained for diagnostics only where safe and explicitly named as claims.

### 8.2 Use the shared study engine

The server must reuse the same pure modules already used by the client for:

- natural-key parsing/building
- component derivation
- question generation
- answer references
- correctness
- rating mapping
- FSRS/replay logic

Do not create a parallel “server version” of study logic.

Refactor shared pure functions only where needed, preserving client behaviour and exhaustive regression tests.

No React, browser, Dexie or client-only imports may leak into server reconstruction/replay code.

### 8.3 Manifests are authoritative

Validate submitted events against the exact referenced release’s retained:

- validation manifest
- assessment manifest
- checksums
- release identity
- generator/version support

Do not validate historical events against only the currently active release.

A supported older release must remain ingestible.

A revoked or unavailable release must produce a safe, recoverable per-item rejection.

### 8.4 Authentication and ownership

Every sync endpoint must:

- require an authenticated, verified account
- derive `user_id` from the server session
- ignore/reject any client-supplied user id
- scope every read/write to that user
- prevent cross-account event, component, collection or revision access
- use enumeration-safe errors
- avoid exposing raw database errors

Guests must never call the server merely to continue local study.

### 8.5 Idempotency

- `event_id` is the idempotency key for scheduling events.
- Attempt ids must also be deduplicated under the documented identity.
- Duplicate delivery must return the prior canonical result.
- Repeating the same successful batch must not duplicate rows, rerun FSRS twice or bump revisions twice.
- Conflicting reuse of an existing id with different immutable payload must be rejected and audited.

### 8.6 Transactional integrity

For one ingested scheduling event, the database operation that determines status, stores canonical fields, replays affected state and bumps revision must be atomic.

Do not leave accepted events without corresponding authoritative state, or state advances without their accepted event.

Use deterministic locking/serialization at the component level where needed to prevent two online requests from corrupting one component’s chain.

Avoid global locks.

---

## 9. API design

Design small, versioned authenticated endpoints under a coherent route structure, for example:

```text
POST /api/sync/push
GET  /api/sync/pull?since=<revision-or-cursor>
```

A separate bootstrap/status route is acceptable only when justified.

Follow existing repository API conventions.

### 9.1 Push request

Use a strict versioned request schema. A batch should contain bounded arrays of relevant mutation types, such as:

- attempts
- scheduling/review events
- revocations
- bookmark upserts/deletes
- list upserts/deletes or canonical membership snapshots
- settings updates

Do not accept arbitrary nested blobs.

Enforce:

- maximum request size
- maximum batch-item count
- maximum string lengths
- UUID/id formats
- supported schema versions
- supported generator versions
- valid enum values
- bounded timestamps
- bounded option counts
- bounded answer-reference arrays

Return HTTP-level success for a syntactically valid batch even when individual items are rejected; the response must include a result for every input item.

Use appropriate HTTP errors for:

- unauthenticated access
- malformed top-level payload
- unsupported protocol requiring client upgrade
- oversized request
- unavailable server dependencies

### 9.2 Per-item result

Every submitted item must receive a stable result containing enough information for deterministic retry/rebase, for example:

- item id
- item kind
- outcome/status
- duplicate indicator
- recoverable/non-recoverable classification
- safe reason code
- canonical stored values where relevant
- affected component key
- server component revision
- reconciled component state where relevant
- clock-correction flags
- server-known current release id
- resubmission guidance for pending/unknown-parent cases

Do not return stack traces, SQL, internal file paths, assessment answers or secrets.

### 9.3 Pull/rebase request

Support pulling changes since a client-known server cursor/revision.

The exact cursor design may be:

- account-wide monotonically increasing sync revision, or
- a documented equivalent cursor that safely captures changes across components and collections.

Do not assume one component revision alone can represent an account-wide pull.

The pull response must be bounded and paginatable if it can grow.

Return:

- changed authoritative component states
- relevant event status updates
- collection/settings changes
- current server cursor
- current active release id
- whether more pages remain
- safe notices requiring local rebase or client upgrade

A full bootstrap path for a newly signed-in second browser context must exist.

---

## 10. Objective attempt reconstruction

For each objective attempt:

1. Load the referenced registered content release.
2. Verify release status and protocol support.
3. Parse the component natural key.
4. Validate entry existence.
5. Validate skill type.
6. Validate component shape.
7. Validate source field.
8. Validate direction.
9. Validate quiz eligibility.
10. Validate the key matches the submitted structured fields.
11. Validate the question generator version.
12. Re-run the shared deterministic generator using the recorded:
    - question seed
    - generator version
    - content/release version
    - component key
    - prompt/source-field selection
    - option count where part of the recorded specification
13. Verify the reconstructed question identity/specification.
14. Verify the selected answer reference belongs to the reconstructed allowed set.
15. Derive correctness using the assessment manifest/shared correctness logic.
16. Derive the scheduling rating from correctness, hint state and current documented mapping.
17. Store canonical values.
18. Audit any material mismatch between client claims and canonical values.

Required behaviours include:

- A false client `is_correct` claim must be corrected without affecting canonical FSRS outcome.
- A client `Good` claim for a wrong answer must become `Again`.
- A client `Hard` claim without the hint condition required by the current mapping must be corrected.
- A selected option not in the reconstructed set must be rejected.
- A tampered natural key must be rejected.
- A mismatched option set or question id must be rejected.
- An unknown generator version must be rejected recoverably.
- Ineligible fields must never be accepted as targets.
- Duplicate-māḍī ambiguity protections must remain intact.
- Bāb answers remain Arabic pattern pairs derived from data/manifests, never hand-authored strings.

Do not leak the assessment manifest or correct answer references to unauthorised client paths beyond what the learner already saw in their own reconstructed question.

---

## 11. Flashcard validation

Flashcards are self-rated and cannot be objectively regraded in the same way.

For flashcard attempts/events:

- Validate release, entry, component, shape, field, direction and eligibility.
- Validate question/spec identity structurally where applicable.
- Accept only the Phase 16-supported self-ratings:
  - `Again`
  - `Good`
- Reject `Hard` and `Easy` for flashcards unless the current merged product contract explicitly supports them.
- Validate hint fields and delivery mode consistency.
- Preserve the distinction between an attempt and its scheduling event.
- Never infer objective correctness when no objective answer exists.

Keep this rule aligned with the merged repository’s actual flashcard UI and scheduler contracts.

---

## 12. Attempt versus scheduling-event handling

Preserve the existing semantic distinction:

- Every learner response may produce an attempt record.
- Only scheduling-authoritative first attempts/reviews produce scheduling events.
- Reinforcement attempts remain analytics/history but must not advance FSRS.
- Undo/revocation affects the scheduling event and replay, not historical attempt existence.
- Conflict-demoted events are Phase 19 behaviour and must not be invented here.

Validate and test:

- wrong first attempt + correct reinforcement stores both attempts
- only the intended scheduling event affects replay
- resending either attempt is idempotent
- client claims cannot turn reinforcement into an authoritative scheduling event
- event-to-attempt relationships are ownership-safe and structurally valid

---

## 13. Timezone and canonical-time validation

Use the event-time metadata already recorded by the client.

Validate:

- `occurred_at`
- IANA timezone name
- offset at event
- local date at event
- device id
- relationship to prior accepted event on the same device/component chain

Compute `occurred_at_canonical` using the documented policy:

- allow a small future tolerance of approximately two minutes
- never canonicalise later than a safe server-received bound
- do not allow canonical time to move backwards before the same device’s previous accepted event in that chain
- missing, absurd or internally inconsistent metadata falls back safely to server receipt time
- mark a `clock_suspect` or equivalent correction flag
- preserve the submitted local study date when plausible
- never use timestamps to infer causal concurrency

Return correction metadata to the client without exposing sensitive details.

Add exact boundary tests around:

- valid timezone metadata
- DST transition
- future timestamp within tolerance
- future timestamp outside tolerance
- impossible offset
- unknown timezone
- backwards device clock
- malformed local date
- server fallback

---

## 14. Causal lineage — Stage A behaviour

Implement the Phase 16 subset of the causal DAG.

Each scheduling event carries:

- `base_server_revision`
- `parent_event_id`
- `client_component_revision`
- device id
- component key

### 14.1 Accept serial chains

Accept a valid event when it extends the component’s accepted authoritative chain.

A second event whose parent is the first event must be accepted as sequential even when both were created from the same stale base revision.

Replay the accepted chain deterministically.

### 14.2 Unknown parent

When the parent is not yet present:

- store the event as `pending_parent`
- do not apply it to FSRS
- return a recoverable per-item result
- reprocess it when its parent later arrives
- preserve enough metadata for later Phase 18/19 handling

A simple bounded pending reprocessor is in scope.

The full 14-day TTL/dead-letter/resubmission UX may remain documented for Phase 18/19 unless the current schema already requires a basic expiry field.

### 14.3 Cycles and impossible lineage

Reject:

- self-parenting
- direct cycles
- indirect cycles
- parent belonging to another user
- parent belonging to another component
- impossible component revision progression
- invalid client revision regressions under the documented rules
- immutable id reused with changed lineage

Rejections must be recoverable where the client can repair/resubmit and must be audit logged.

### 14.4 Concurrent stale branches

Do not silently treat a genuine stale branch as sequential.

Phase 16 must not implement Phase 19’s pessimistic-winner/demotion algorithm.

Choose and document the Stage A-safe behaviour already intended by the plan:

- hold the stale branch behind a feature/status such as pending conflict, or
- reject it recoverably with a required pull/rebase/resubmit response.

Single-device serial online use must work fully.

The UI and documentation must not claim full offline multi-device conflict resolution.

---

## 15. Deterministic replay and authoritative component state

Implement a pure or near-pure replay service using the shared scheduler.

Replay must:

- start from the correct initial component state
- select only scheduling-authoritative accepted events
- exclude reinforcement attempts
- exclude pending events
- exclude rejected events
- exclude revoked events
- preserve deterministic ordering
- apply canonical ratings
- use canonical times
- recompute FSRS state
- recompute learner state
- recompute mastery-related fields/dates from accepted events
- produce the same result every time for the same stored event set

Persist authoritative component state into the Phase 15 `study_components` table.

Revision rules:

- bump only when authoritative scheduling state changes
- duplicate submissions do not bump
- rejected/pending attempts do not bump
- accepted scheduling events bump deterministically
- revocation followed by replay bumps deterministically
- repeated replay with no event-set change is idempotent

Add a replay-invariant test that compares persisted component state with a fresh replay from accepted events.

---

## 16. Revocation and post-sync undo

The existing client supports single-step undo.

For an unsynced local event, retain current local undo behaviour.

For an already accepted server event:

- create/send a revocation mutation
- authenticate and validate ownership
- make revocation idempotent
- mark the event revoked rather than deleting history
- replay the component without the revoked event
- update component state and revision
- return reconciliation
- preserve associated attempts for history/analytics
- update local event status
- rebase local optimistic state

Reject or safely handle revocation when:

- event is unknown
- event belongs to another account
- event is already revoked
- event is not scheduling-authoritative
- revocation would target an invalid child-chain situation

Define the Stage A rule for descendants explicitly. Prefer a safe documented behaviour over silently producing a broken chain. If descendant revocation semantics are already specified in current docs/code, follow them exactly.

---

## 17. Server audit log

Add a bounded server-side audit trail for ingestion anomalies and rejections.

Record safe structured fields such as:

- audit id
- user id
- event/attempt id
- item kind
- reason code
- severity
- release id
- component key where safe
- received timestamp
- canonical correction flags
- request correlation id
- redacted metadata required for diagnosis

Do not log:

- passwords
- auth tokens
- verification/reset tokens
- cookies
- full request bodies
- unnecessary learner answer content
- raw database errors
- assessment-manifest contents

Required audit cases include:

- client correctness mismatch
- client rating mismatch
- invalid option
- natural-key tampering
- unsupported generator version
- invalid release
- clock correction
- impossible lineage
- cross-user ownership attempt
- idempotency-key payload conflict

No admin UI is required.

---

## 18. Client sync module

Create a focused `modules/sync` boundary.

Separate:

- pure wire schemas/types
- API client
- local data selection
- push orchestration
- pull orchestration
- reconciliation/rebase
- status derivation
- collection/settings mapping

Do not put sync logic directly into study UI components.

### Required triggers

For authenticated users with sync enabled:

- push at successful session end
- pull/reconcile after push
- periodic sync while the app is active
- sync on account/bootstrap page load or application bootstrap
- manual retry from an attention state

Phase 16 does not need to guarantee durable offline retries. When offline or the request fails:

- local study continues
- local data remains intact
- status becomes pending/offline
- no attempt is silently discarded
- retry can occur on a later online trigger

Reuse the existing Dexie mutation/event data. Avoid creating two unrelated sources of truth.

### Prevent duplicate loops

Ensure:

- only one active sync run per account/device
- overlapping triggers coalesce
- stale responses cannot overwrite newer reconciliation
- logout/account switch cancels or invalidates the prior user’s sync context
- guest records are not silently uploaded in Phase 16
- login alone does not merge guest history

---

## 19. Local reconciliation/rebase

On a successful push/pull:

- update local server-sync metadata
- apply authoritative component states
- mark local events by canonical server status
- retain all local attempts
- preserve local unsynced events
- do not overwrite a newer unsynced local chain blindly
- update known account cursor/revision
- apply canonical clock/rating/correctness corrections
- handle pending/rejected items visibly but safely
- refresh dashboard/progress views
- avoid interrupting an active study question

A live session must remain pinned to its starting content version and question plan.

Do not remount or destroy an in-progress session merely because background sync completes.

When scheduling changes due to server rebase, show a quiet notice such as:

```text
Your study schedule was updated.
```

Do not claim “updated from another device” unless the server result actually supports that conclusion; full concurrent multi-device reconciliation is Phase 19.

---

## 20. Sync-status UI

Add an unobtrusive authenticated-only status indicator with states equivalent to:

- Synced
- Syncing
- Pending N
- Offline
- Attention needed
- Sync unavailable/disabled

Provide an accessible detail view for recoverable issues.

Requirements:

- honest wording
- no raw ids, stack traces or SQL errors
- keyboard accessible
- screen-reader status announcements without excessive noise
- dark-mode support
- 320px mobile support
- does not appear for guests unless explaining that account sync is available
- does not block local study
- manual retry for recoverable failures
- status updates after session-end sync
- account page copy updated to remove the Phase 15 “no sync yet” limitation only after Phase 16 works

Do not claim offline durability or full multi-device offline conflict resolution.

---

## 21. Bookmarks sync

Use authenticated idempotent upserts/deletes.

Required semantics:

- bookmark identity is the entry id
- server ownership comes from session
- repeated add/remove is idempotent
- unknown entry ids are rejected safely
- release-independent identity remains compatible with supported content
- account bootstrap can restore bookmarks to a second browser
- local guest bookmarks are not automatically merged on login in Phase 16

Choose and document a clear online account precedence strategy. For normal signed-in use, server state is authoritative after reconciliation.

Preserve guest-local bookmarks when logged out.

---

## 22. Custom-list sync

Synchronise:

- list id
- normalised name
- display name
- canonical sorted/deduplicated entry membership
- created/updated metadata required by the schema
- deletion/tombstone state if needed for safe pull

Required semantics:

- idempotent upserts
- ownership enforcement
- name validation
- duplicate normalised-name constraints per user
- membership entry validation
- deterministic canonical membership
- no cross-user list access
- second-browser restoration
- no guest merge in Phase 16

Use documented union semantics only where the current Phase 16 plan requires it. Do not invent guest/account union before Phase 17.

Resolve same-account online updates deterministically and document the rule.

---

## 23. Settings sync

Synchronise only account-safe learner settings intended for server persistence.

Use **account-wins** semantics.

Do not sync:

- secrets
- auth/session data
- device-specific ephemeral UI state
- live session state
- unsupported browser capability state
- guest profile identity

Validate setting keys and values on both client and server.

Unknown keys must not be blindly persisted.

A second browser context must receive the account settings after bootstrap/pull.

Preserve sensible device-specific exceptions where the existing product contract requires them.

---

## 24. Feature flags and rollback

Add a sync kill switch separate from auth, for example:

```text
SYNC_ENABLED=false
```

Follow current environment-module conventions.

When disabled:

- authentication still works
- guests still work
- signed-in users continue local study
- sync endpoints return a safe unavailable response
- UI states that progress is stored on this device only
- no local data is deleted
- no misleading “synced” state appears

Document operational rollback:

1. Disable sync with the feature flag.
2. Preserve all server data.
3. Continue local-only study.
4. Diagnose using bounded audit logs.
5. Re-enable without requiring destructive migration.

Any new migration must include a dependency-safe rollback script or a documented forward-only justification consistent with repository practice.

---

## 25. Database work

Inspect the Phase 15 schema before adding anything.

Prefer using existing tables/columns when they already model the required state correctly.

Add migration `0002` only for genuine gaps, such as:

- account-wide sync cursor/revision
- event canonical/status/audit fields
- revocation metadata
- idempotency payload hash
- rejection audit table
- collection tombstones/change cursor
- safe pending-parent metadata

Do not create vocabulary-content tables.

Do not duplicate the assessment manifest in PostgreSQL.

Database constraints should enforce stable invariants where practical:

- user ownership
- unique ids
- valid status enums/checks
- valid revision ranges
- unique component per user/natural key
- idempotency uniqueness
- collection uniqueness
- safe foreign-key relationships

Application validation remains required even with DB constraints.

Update integration-test migration setup and CI if a migration is added.

---

## 26. Suggested implementation order

Claude Code must first produce a concrete task plan based on actual repository discovery. A sensible dependency order is:

1. Repository discovery and contract inventory
2. Phase 16 wire schemas and safe error codes
3. DB gap analysis and migration, if needed
4. Authenticated sync route/session boundary
5. Server manifest lookup and release validation
6. Natural-key/component validation
7. Objective question reconstruction and canonical grading
8. Flashcard structural validation
9. Idempotent attempt/event persistence
10. Canonical-time validation
11. Stage A lineage classification
12. Deterministic replay and revision service
13. Per-item push response
14. Pull/bootstrap cursor and response
15. Revocation/post-sync undo
16. Audit logging
17. Client sync API/orchestrator
18. Dexie reconciliation
19. Bookmarks/lists/settings sync
20. Sync-status UI/account copy
21. Unit/integration/component tests
22. Cross-context E2E
23. CI/quality-gate updates
24. Documentation
25. Full-phase council and PR

Keep commits small and dependency-ordered.

Do not combine the entire server pipeline, client orchestration and UI into one commit.

---

## 27. Required testing

This is a high-risk correctness and security phase. Tests must exercise real shared modules and real PostgreSQL transactions, not mocked happy paths only.

### 27.1 Pure unit tests

Cover:

- wire-schema parsing
- safe error-code mapping
- natural-key validation
- manifest eligibility validation
- objective reconstruction
- selected-answer membership
- correctness derivation
- rating derivation
- flashcard allowed ratings
- timestamp plausibility and clamping
- Stage A lineage classification
- cycle detection
- deterministic replay
- revision rules
- status derivation
- collection canonicalisation
- settings allowlist
- rebase merging rules
- sync-trigger coalescing

### 27.2 PostgreSQL integration tests

Use the disposable test database and real migrations.

Required cases:

1. Duplicate event id is stored once.
2. Exact duplicate returns prior canonical result.
3. Same id with altered immutable payload is rejected and audited.
4. False client `is_correct` is corrected.
5. Wrong answer claiming `Good` becomes `Again`.
6. `Hard` without the required hint condition is corrected.
7. Selected option outside reconstructed set is rejected.
8. Tampered natural key is rejected.
9. Entry/skill/shape/field/direction mismatch is rejected.
10. Ineligible field is rejected.
11. Unknown generator version is recoverably rejected.
12. Unsupported/revoked release is handled safely.
13. Supported older release validates against its own manifests.
14. Flashcard `Again` accepted.
15. Flashcard `Good` accepted.
16. Flashcard unsupported ratings rejected.
17. Reinforcement attempt does not advance FSRS.
18. Sequential two-event chain is accepted.
19. Both events with same stale base revision remain sequential when parented.
20. Unknown parent becomes pending and does not affect state.
21. Parent arrival reprocesses pending child.
22. Self-cycle rejected.
23. Indirect cycle rejected.
24. Cross-component parent rejected.
25. Cross-user parent rejected.
26. Invalid client revision rejected.
27. Future clock within tolerance accepted.
28. Absurd clock corrected and flagged.
29. Backwards same-device clock clamped safely.
30. Replay produces persisted state exactly.
31. Repeating replay is idempotent.
32. Revocation removes scheduling effect but preserves attempts.
33. Duplicate revocation is idempotent.
34. Cross-user revocation rejected.
35. Revision bumps only on authoritative change.
36. Pull since cursor returns only relevant changes.
37. Pull pagination/cursor has no gaps or duplicates.
38. Account A can never read Account B state.
39. Bookmark upsert/delete idempotent.
40. List membership canonical and ownership-safe.
41. Settings unknown keys rejected.
42. Account deletion still cascades all new Phase 16 data.
43. Audit records contain no secrets/raw body.

### 27.3 API tests

Cover:

- unauthenticated push/pull
- unverified-account behaviour according to current auth policy
- malformed top-level request
- oversized batch
- one result per submitted item
- mixed accepted/rejected/pending batch
- safe error responses
- feature-flag disabled
- active release id returned
- stale cursor/bootstrap behaviour
- request correlation id
- no client-supplied user id accepted

### 27.4 Client/component tests

Cover:

- sync after session completion
- local study success when sync request fails
- one active sync run despite overlapping triggers
- pending count
- offline state
- attention state
- manual retry
- server corrections applied locally
- authoritative component rebase
- attempts retained
- active session not interrupted
- synced undo sends revocation
- unsynced undo remains local
- logout invalidates sync context
- login does not upload guest history
- sync disabled copy
- account page copy after successful Phase 16
- keyboard and screen-reader behaviour
- dark mode
- 320px layout

### 27.5 E2E

Add a dedicated authenticated sync suite using real PostgreSQL and the repository’s real auth/dev-email flow.

At minimum:

1. Register, verify and sign in.
2. Complete an objective study session.
3. Confirm session-end sync succeeds.
4. Open/sign in to a second isolated browser context.
5. Pull/bootstrap.
6. Confirm authoritative progress/component state is visible there.
7. Add a bookmark in context A and confirm it appears in context B after sync.
8. Create/update a custom list and confirm it appears in context B.
9. Change a syncable account setting and confirm it appears in context B.
10. Submit a deliberately tampered API payload and verify rejection/audit behaviour without corrupting state.
11. Undo an already-synced event and confirm both contexts rebase.
12. Disable sync and prove local study remains functional.
13. Run mobile 320px journey.
14. Run axe scans on status/detail/account surfaces.
15. Confirm no guest history is uploaded merely by signing in.

Do not rely on two tabs sharing the same IndexedDB when proving cross-device behaviour. Use isolated browser contexts/profiles with separate local storage.

---

## 28. Quality gate

Update `scripts/quality-gate.ps1` and CI only as needed.

The final gate must include:

```text
pnpm install --frozen-lockfile
Python vocabulary validation
Arabic integrity verification
content build
generated-artifact freshness
docs verification
full migration chain on disposable PostgreSQL
content registration
Phase 16 DB integration tests
typecheck
lint
format check
unit/component tests
production build
authenticated sync E2E
existing auth E2E
guest regression E2E
AUTH_ENABLED=false E2E
SYNC_ENABLED=false E2E
```

Do not weaken, skip or globally increase timeouts to conceal failures.

Target deterministic tests. Pin clocks and seeds where timing matters.

Preserve every pre-existing Phase 0–15 test.

---

## 29. Security review requirements

Treat this phase as security-sensitive.

Verify explicitly:

- authenticated ownership on every query
- no horizontal privilege escalation
- no client user-id trust
- strict schemas at every boundary
- request-size and batch-size limits
- no raw error leakage
- no assessment-manifest leakage
- no secrets in audit logs
- no arbitrary settings keys
- no prototype-pollution-style object merging
- no SQL built from request strings
- no unsafe dynamic imports from release ids
- safe release/path lookup
- idempotency conflict detection
- replay locking cannot be used for broad denial of service
- cycle checks are bounded
- pull pagination is bounded
- status UI does not expose internal ids
- account deletion covers new tables
- logout/account switch cannot sync into the wrong account
- CSRF/origin expectations follow the established Better Auth/route-handler architecture
- rate limiting is considered for sync endpoints without breaking legitimate session batches

Document any accepted residual risk.

---

## 30. Performance and reliability constraints

- Bound push batch size.
- Bound pull page size.
- Avoid N+1 manifest/database queries.
- Cache immutable parsed manifests safely server-side.
- Lock at user/component granularity rather than globally.
- Do not replay every component on every sync.
- Replay only affected components.
- Make duplicate delivery cheap.
- Make polling/interval sync unobtrusive.
- Pause or reduce periodic work when the document is hidden if consistent with current architecture.
- Clean up timers/listeners on unmount/logout.
- Do not block study completion UI indefinitely on network sync.
- Use bounded server/database operations.
- Preserve local progress on every network/server failure.
- Never silently discard rejected items.

Add targeted tests for concurrency or overlapping online requests against the same component.

---

## 31. Documentation updates

Update at least:

```text
docs/PRODUCT_REQUIREMENTS.md
docs/ARCHITECTURE.md
docs/DATA_MODEL.md
docs/OFFLINE_AND_SYNC.md
docs/TEST_STRATEGY.md
docs/DEPLOYMENT.md
docs/RISK_REGISTER.md
docs/phases/IMPLEMENTATION_PHASES.md
docs/phases/phases-16.md
README.md
.env.example
```

Document:

- Phase 16 guarantees
- Stage A limitations
- API contracts
- trust boundaries
- canonical grading
- replay/revision model
- Stage A lineage behaviour
- pending/rejected states
- revocation
- account-wide pull cursor
- sync status meanings
- collection/settings semantics
- feature flag
- operational rollback
- database migration
- local development commands
- test setup
- distinction between online sync and later offline guarantees

Do not state that the Core MVP is complete; that milestone is after Phase 17.

Do not state that full offline or concurrent multi-device sync is complete.

---

## 32. Acceptance criteria

Phase 16 is complete only when all of the following are true:

- [ ] Phase 15 is merged and the branch starts from current `origin/main`.
- [ ] Guests remain fully functional and local-only.
- [ ] Signed-in study works locally before/during network operations.
- [ ] Authenticated push returns a result per item.
- [ ] Duplicate event delivery is idempotent.
- [ ] Conflicting id reuse is rejected.
- [ ] Objective questions are reconstructed server-side.
- [ ] Objective correctness is server-derived.
- [ ] Scheduling rating is server-derived.
- [ ] Client correctness/rating claims cannot alter authoritative replay.
- [ ] Manifest release, entry, skill, shape, field, direction and eligibility are validated.
- [ ] Unknown generator versions fail recoverably.
- [ ] Flashcards are structurally validated with only supported self-ratings.
- [ ] Canonical time is computed and clock correction is surfaced.
- [ ] Valid serial causal chains are accepted.
- [ ] Unknown parents are held without affecting FSRS.
- [ ] Cycles/impossible lineage are rejected.
- [ ] Genuine stale branches are not silently accepted as serial.
- [ ] Authoritative component state equals deterministic replay.
- [ ] Revision rules are deterministic and idempotent.
- [ ] Pull/bootstrap restores state in a second isolated browser context.
- [ ] Client rebase preserves attempts and unsynced local work.
- [ ] Post-sync undo uses revocation and replay.
- [ ] Rejections/corrections are audit logged safely.
- [ ] Bookmarks sync.
- [ ] Custom lists sync.
- [ ] Account settings sync with account-wins semantics.
- [ ] Login does not automatically merge/upload guest history.
- [ ] Sync status UI is honest, accessible and responsive.
- [ ] `SYNC_ENABLED=false` cleanly restores local-only operation.
- [ ] Account deletion cascades all Phase 16 server data.
- [ ] No vocabulary data changes.
- [ ] No Phase 17, 18 or 19 functionality is implemented prematurely.
- [ ] Full quality gate passes.
- [ ] Full-phase reviewer council approves the exact final bytes.
- [ ] PR is opened with complete evidence.

---

## 33. Required demonstration

Demonstrate all of the following:

### Demonstration A — cross-browser authoritative sync

1. Register and verify an account.
2. Sign in in browser context A.
3. Complete an objective session.
4. Show local immediate results.
5. Show sync status transition to Synced.
6. Sign in in isolated browser context B.
7. Pull/bootstrap.
8. Show the same authoritative progress/component state.

### Demonstration B — server trust

1. Submit a tampered attempt claiming a wrong answer is correct/Good.
2. Show the server reconstructs the question.
3. Show the canonical result is incorrect/Again.
4. Show the audit entry.
5. Show authoritative FSRS state remains correct.

### Demonstration C — idempotency

1. Resend the same accepted event.
2. Show no duplicate row.
3. Show no second revision bump.
4. Show the same prior canonical result.

### Demonstration D — revocation

1. Undo an already-synced review.
2. Show a revocation mutation.
3. Show replayed state.
4. Show attempts remain in history.
5. Show context B receives the rebase.

### Demonstration E — account collections

1. Bookmark an entry in context A.
2. Create a custom list.
3. Change a syncable setting.
4. Sync context B.
5. Show all three account states restored there.

### Demonstration F — kill switch and guest regression

1. Set `SYNC_ENABLED=false`.
2. Show auth remains available.
3. Show signed-in study remains local.
4. Show guests remain fully functional.
5. Show UI does not claim data is synced.

---

## 34. Commit and review workflow

Use the repository’s current `/phase-loop` workflow exactly.

Before each commit:

- stage only the intended task
- run the task’s focused tests
- run required deterministic checks
- run the per-commit reviewer council
- fix or explicitly rebut every finding with evidence
- commit only after the council decision permits it

Risk routing for this phase should frequently include:

- security
- architecture
- reliability
- testing

Do not reduce review coverage merely because Phase 16 is large.

At phase end:

- run the entire quality gate
- capture final workspace fingerprint
- run the full-phase council on the exact final bytes
- resolve all P0/P1/P2 findings
- record accepted P3 debt explicitly
- re-run affected tests after every correction
- ensure approvals are not stale
- create the PR only after the workflow permits it

Do not push directly to `main`.

---

## 35. Required final report and PR body

The final response and pull-request body must include:

1. Summary
2. Phase boundary and non-goals
3. Architecture decisions
4. API contracts
5. Trust-boundary explanation
6. Server reconstruction/grading flow
7. Lineage/replay/revision behaviour
8. Pull/rebase behaviour
9. Revocation behaviour
10. Collections/settings sync semantics
11. Database migration details
12. Feature flags and rollback
13. Files changed
14. Commit list
15. Acceptance-criteria evidence table
16. Test and quality-gate results
17. Security review
18. Reliability/concurrency review
19. Full-phase council decision
20. Findings fixed/rebutted
21. Remaining P3 technical debt
22. Known Stage A limitations
23. Manual verification guidance
24. Review-artifact locations
25. Token/reviewer telemetry where the workflow provides it

State clearly that:

- Phase 16 provides online authenticated sync.
- Guest merge is still Phase 17.
- Durable offline queue/PWA is still Phase 18.
- Full concurrent offline branch resolution is still Phase 19.
- Core MVP is not complete until Phase 17.

---

## 36. Final instruction to Claude Code

Begin by performing discovery and preflight only.

Then present a detailed, dependency-ordered implementation plan with:

- tasks/commit boundaries
- exact expected files
- migrations
- API schemas
- test coverage per task
- key risks
- assumptions
- explicit Phase 17–19 exclusions

After recording the plan through the phase-loop workflow, proceed with implementation.

Do not ask for routine confirmation when the repository and documentation already answer the question. Make the safest reasonable decision, record it, and continue.

Stop only for a genuine blocker such as:

- Phase 15 not merged
- dirty working tree containing user work
- failing baseline quality gate
- missing required local infrastructure
- irreconcilable contradiction in authoritative current repository contracts
