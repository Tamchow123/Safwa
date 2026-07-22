# Phase 15 — Server Foundation: PostgreSQL, Drizzle, Authentication and Email

Implement **Phase 15 — Server foundation: Postgres, Drizzle, auth, email** for Safwa.

Use the established `/phase-loop` workflow:

```text
/phase-loop Phase 15 — Server foundation: PostgreSQL, Drizzle, authentication and email. Implement exactly the Phase 15 requirements in docs/phases/IMPLEMENTATION_PHASES.md and the server schema constraints in docs/DATA_MODEL.md. Add the first PostgreSQL migration, checksummed server-manifest loading, Better Auth email/password accounts, verification, password reset, logout, account settings and account deletion. Guests must remain fully functional and local-only. Do not begin Phase 16 sync or Phase 17 guest merge.
```

Work only on Phase 15.

Do not begin online sync, guest-account merge, server-side study ingestion or Phase 16.

---

## 1. Required prerequisite

Phase 14 PR #19 must be:

* Reviewed
* Marked ready
* Merged into `main`
* Green in GitHub Actions

Before implementation, confirm `origin/main` contains:

```text
Phase 14: add bookmarks and custom lists
```

Phase 15 must include the completed guest-local:

* Bookmarks
* Custom lists
* Saved Vocabulary routes
* Collection-filtered Custom Sessions
* Collection export
* Phase 14 tests and documentation

Do not build Phase 15 directly on `phase/14-bookmarks-custom-lists`.

Stop and report when Phase 14 is not merged.

---

## 2. Required branch

Create:

```text
phase/15-server-foundation
```

from the latest merged `origin/main`.

Do not reuse an older phase branch.

Do not stack Phase 15 on an unmerged PR.

---

## 3. Read the current repository first

Read:

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
docs/phases/phases-12.md
docs/phases/phases-13.md
docs/phases/phases-14.md

docs/adr/*
```

Inspect the current implementation, especially:

```text
package.json
pnpm-lock.yaml
tsconfig.json
next.config.*
eslint.config.mjs
vitest.config.*
playwright.config.ts
.github/workflows/ci.yml
scripts/quality-gate.ps1

content-server/README.md
content-server/release-registry.json
content-server/releases/*/validation.json
content-server/releases/*/assessment.json
content-server/releases/*/checksums.json
public/content/active.json
public/content/releases/*/learner.json

modules/content/build.ts
modules/content/schema.ts
modules/content/constants.ts
modules/content/checksum.ts
modules/content/stable-json.ts

modules/profile/settings.ts
modules/profile/session-defaults.ts
modules/profile/timezone.ts
modules/profile/export.ts

modules/collections/*
modules/study-engine/*
modules/scheduler/*
modules/analytics/*
modules/study-session/*
```

Search the repository for:

```text
DATABASE_URL
BETTER_AUTH
RESEND
drizzle
postgres
server-only
user_settings
content_versions
study_components
study_attempts
review_events
guest_imports
AUTH_ENABLED
api/health
```

Follow the current merged repository when it is stricter or more developed than the planning baseline.

---

## 4. Verify current official library contracts

Before selecting package versions or writing integration code, consult the current official documentation for:

* Better Auth

  * Next.js 16 integration
  * Drizzle adapter
  * Email/password
  * Email verification
  * Password reset
  * Database UUID IDs
  * Account deletion
  * Database-backed rate limiting
  * Current CLI schema generation
* Drizzle ORM

  * PostgreSQL connection options
  * Migrations
  * Composite foreign keys
  * CHECK constraints
  * Partial unique indexes
* Resend

  * Node.js SDK
  * Sending-domain requirements
  * Idempotency keys
* Next.js

  * App Router route handlers
  * Server-only modules
  * Current asynchronous cookie/header APIs

Do not copy examples for outdated Next.js or Better Auth versions.

Do not install prerelease packages.

Pin compatible stable versions through `package.json` and `pnpm-lock.yaml`.

---

## 5. Preflight

Run:

```powershell
git status --porcelain
git branch --show-current
git fetch origin
git log --oneline -15 origin/main

node --version
pnpm --version
python --version
docker --version
docker compose version

pnpm install --frozen-lockfile

powershell -ExecutionPolicy Bypass -File scripts/quality-gate.ps1
```

Confirm:

* Working tree is clean.
* Phase 14 is merged.
* The branch starts from current `origin/main`.
* Node satisfies the repository’s Node 24+ requirement.
* Docker is available for disposable PostgreSQL integration tests.
* All Phase 0–14 tests pass before editing.
* Nothing under `data/` changed.
* Generated content artifacts are current.
* The active learner release still contains 455 entries.

Stop rather than stashing, resetting or discarding user work.

---

## 6. Phase objective

Phase 15 establishes the server trust and account foundations required by Phases 16–22.

Deliver:

* PostgreSQL development and test setup
* Drizzle ORM configuration
* Initial committed SQL migration
* Full server learning-state schema
* Database-enforced component-shape constraints
* Better Auth email/password accounts
* Mandatory email verification
* Login and logout
* Password-reset request and completion
* Provider-neutral email adapter
* Console/file email transport for local development and tests
* Resend production transport
* Enumeration-safe account flows
* Database-backed rate limiting
* Account settings CRUD
* Self-service account deletion
* Checksummed server-manifest loading
* `content_versions` registry persistence
* Database and content health endpoint
* Disposable-Postgres integration tests
* Registration-to-verification E2E
* Guest functionality that remains completely independent of the server

This phase gives Safwa accounts.

It does not yet give accounts server-backed learning progress.

---

## 7. Critical product boundary

After Phase 15:

* Guests continue studying entirely through Dexie.
* Signed-in learners also continue using local study state.
* No attempts, events, FSRS cards, bookmarks or lists are uploaded yet.
* Signing in must not clear, replace or silently upload guest data.
* Account learning-state sync begins in Phase 16.
* Guest-to-account merge begins in Phase 17.

A signed-in learner may see an honest notice such as:

```text
Your study progress is still stored on this device. Account syncing arrives in the next stage.
```

Do not falsely claim that progress is backed up or available cross-device.

---

## 8. Non-goals

Do not implement:

* Attempt ingestion
* Review-event ingestion
* Server-derived objective correctness
* Server-side FSRS replay
* Component pull/rebase
* Sync-status UI
* Mutation-queue flushing
* Bookmark/list synchronisation
* Local/account settings reconciliation
* Guest-data upload
* Guest-to-account merge
* Cross-device progress
* Offline mutation durability
* Multi-device conflict resolution
* PWA work
* OAuth providers
* Magic links
* Passkeys
* Two-factor authentication
* Organisations
* Admin UI
* Vocabulary tables in PostgreSQL
* Bāb or verb-type content tables
* Content editing
* Phase 16 or later work

Do not expose the assessment manifest to browser code.

---

## 9. Expected architecture

Create a cohesive server structure such as:

```text
db/
  client.ts
  schema.ts
  schema/
    auth.ts
    learning.ts
    collections.ts
    settings.ts
    content.ts
  migrate.ts
  register-content.ts
  reset-test-database.ts
  migrations/
    <first-drizzle-migration>.sql
    meta/*
  rollback/
    0001_server_foundation_down.sql

modules/
  auth/
    server.ts
    client.ts
    session.ts
    validation.ts
    redirects.ts
    account-settings.ts
    errors.ts

  email/
    types.ts
    send-email.ts
    templates.ts
    transports/
      console-file.ts
      resend.ts

  content/
    server-manifests.ts
    server-release-registry.ts

  env/
    server.ts
    client.ts

app/
  api/
    auth/
      [...all]/
        route.ts
    account/
      settings/
        route.ts
      delete/
        route.ts
    health/
      route.ts

  (auth)/
    login/
      page.tsx
    register/
      page.tsx
    verify-email/
      page.tsx
    forgot-password/
      page.tsx
    reset-password/
      page.tsx

  (shell)/
    account/
      page.tsx
      settings/
        page.tsx
```

Exact filenames may differ.

Required boundaries:

* Database modules are server-only.
* Better Auth server configuration is server-only.
* Resend is server-only.
* Assessment/validation manifest loaders are server-only.
* Auth client code contains no secret or database imports.
* Shared Zod schemas may be imported on both sides only when they contain no secret/server dependency.
* No root learner layout performs a required database query.

---

## 10. Dependencies

Add only the dependencies required for this phase.

Expected categories include:

```text
better-auth
Better Auth Drizzle adapter
drizzle-orm
drizzle-kit
PostgreSQL driver
resend
server-only
PostgreSQL TypeScript types when required
```

Use the current official Better Auth package layout rather than assuming an outdated adapter import path.

Requirements:

* No prereleases.
* No second ORM.
* No second authentication library.
* No separate Express/Hono server.
* No React email framework unless it provides demonstrated value.
* No Redis dependency.
* No external rate-limit service.
* No external test-email provider.
* Lockfile updated intentionally.

Document every added dependency.

---

## 11. PostgreSQL connection

Create one server-only database connection module.

Requirements:

* Validated `DATABASE_URL`
* One reusable pool/client per process
* No new connection per request
* Safe development hot-reload singleton
* Lazy initialisation
* No database connection during client imports
* No database connection merely to render guest learner pages
* Explicit connection close support for integration tests
* Query timeout where supported
* SSL behaviour configurable by environment
* No TLS verification disabling in production
* No secret logging

Select one documented Drizzle PostgreSQL driver that works with:

* Local Docker PostgreSQL
* Disposable CI PostgreSQL
* Neon pooled PostgreSQL URL
* Vercel Node runtime

Document the driver decision in `ARCHITECTURE.md` or an ADR.

Do not create separate production and test ORM implementations.

---

## 12. Local PostgreSQL setup

Add a pinned local PostgreSQL service through:

```text
compose.yaml
```

or the repository’s chosen Docker Compose filename.

Provide:

* Database
* User
* Password intended only for local development
* Health check
* Persistent local volume
* Explicit port
* No production secrets

Suggested development database names:

```text
safwa_dev
safwa_test
```

Add commands or documentation for:

```powershell
docker compose up -d db
docker compose down
docker compose down -v
```

Do not automatically delete the development database.

---

## 13. Environment validation

Create strict server-environment validation with Zod.

Document variables through:

```text
.env.example
```

At minimum:

```text
DATABASE_URL
BETTER_AUTH_SECRET
BETTER_AUTH_URL
NEXT_PUBLIC_APP_URL
AUTH_ENABLED
EMAIL_TRANSPORT
RESEND_API_KEY
EMAIL_FROM
EMAIL_OUTBOX_DIR
CONTENT_SERVER_DIR
```

Rules:

* Secrets never use `NEXT_PUBLIC_`.
* Production requires a strong `BETTER_AUTH_SECRET`.
* Production requires HTTPS origins.
* Production Resend transport requires `RESEND_API_KEY` and `EMAIL_FROM`.
* Development defaults to console/file transport.
* Test defaults to deterministic file/in-memory transport.
* Console/file email transport must be rejected in production unless an explicit safe test environment is detected.
* `CONTENT_SERVER_DIR` defaults to the repository’s server-manifest directory where safe.
* Invalid environment configuration fails early with a concise server-side error.
* Client bundles never receive server validation output or secrets.

Do not commit `.env.local`.

---

## 14. Drizzle configuration

Add:

```text
drizzle.config.ts
```

and scripts such as:

```json
{
  "db:generate": "...",
  "db:check": "...",
  "db:migrate": "...",
  "db:register-content": "...",
  "db:test:reset": "...",
  "test:integration": "..."
}
```

Requirements:

* SQL migrations are committed.
* Production does not use schema push.
* `drizzle-kit push` is not the deployment path.
* Migration generation is reproducible.
* Migration application is explicit.
* Application startup does not automatically migrate production.
* CI applies migrations to a fresh disposable database.
* Migration drift is detectable.
* The generated Drizzle journal/snapshot is committed where required.

The phase describes migration 0001 logically.

When Drizzle internally names the first migration `0000_*`, do not manually rename files in a way that corrupts its journal. Document that it is Safwa’s logical migration 0001.

---

## 15. Better Auth schema source of truth

Use the current Better Auth CLI/schema-generation flow for the installed Better Auth version.

Requirements:

1. Configure Better Auth first.
2. Generate its required Drizzle schema using the compatible CLI.
3. Inspect every generated table and column.
4. Integrate it into Safwa’s schema modules.
5. Generate one coherent Drizzle migration containing auth and Safwa tables.
6. Do not separately run Better Auth migrations in production.
7. Drizzle migration files remain the sole database migration authority.

Configure UUID database IDs in a way supported by the installed Better Auth version and PostgreSQL.

Application table `user_id` columns must use the exact same database type as the Better Auth user ID.

Do not mix UUID and text user IDs.

---

## 16. Better Auth tables

Include all tables required by the configured current Better Auth version.

Expected core models include:

```text
users
sessions
accounts
verifications
```

Include a database-backed rate-limit table because in-memory rate limiting is not reliable across serverless instances.

Use consistent plural names where practical and configure Better Auth’s schema/model mappings explicitly.

The user model should include:

* UUID ID
* Name
* Normalised email
* Email-verified state
* Optional image
* Created timestamp
* Updated timestamp
* Role with learner default

Role is server-owned.

Allowed initial roles:

```text
learner
admin
```

Do not expose a client-controlled role field during registration or profile updates.

Add a CHECK constraint for allowed roles.

Email uniqueness must be case-insensitive in effective behaviour.

Add an integration test showing that differing email casing cannot create two accounts.

---

## 17. `skill_types`

Create:

```text
skill_types
```

with:

```text
id text PRIMARY KEY
component_shape text NOT NULL
display_name text NOT NULL
is_active boolean NOT NULL DEFAULT true
UNIQUE (id, component_shape)
CHECK component_shape IN ('form_direction', 'entry_level')
```

Seed exactly the current five skill types:

```text
meaning_recognition → form_direction
meaning_recall → form_direction
bab_identification → entry_level
root_identification → entry_level
verb_type_identification → entry_level
```

Use a migration or an idempotent database seed that CI runs.

Do not infer shape from naming conventions.

Do not create a PostgreSQL enum.

---

## 18. `study_components`

Create the table according to `DATA_MODEL.md`.

Required fields include:

```text
id
user_id
entry_id
skill_type_id
component_shape
source_field
direction

stability
difficulty
due_at
fsrs_state
reps
lapses
last_review_at
revision
learner_state
```

Required integrity:

### User ownership

```text
user_id → users.id ON DELETE CASCADE
```

### Composite skill/shape FK

```text
(skill_type_id, component_shape)
→ skill_types(id, component_shape)
```

This composite FK is load-bearing.

### Shape CHECK

Valid `form_direction`:

```text
component_shape = form_direction
source_field IS NOT NULL
direction IS NOT NULL
```

Valid `entry_level`:

```text
component_shape = entry_level
source_field IS NULL
direction IS NULL
```

No other shape is valid in migration 0001.

### Source-field CHECK

Only:

```text
madi
mudari
masdar
ism_fail
amr
nahi
```

or NULL.

### Direction CHECK

Only:

```text
arabic_to_english
english_to_arabic
```

or NULL.

### Learner-state CHECK

Use the current learner states implemented by the client.

Do not invent a PostgreSQL enum.

### FSRS checks

At minimum enforce:

* `reps >= 0`
* `lapses >= 0`
* `revision >= 0`
* finite/valid numeric values where PostgreSQL constraints can enforce them safely

### Partial unique indexes

For form components:

```text
UNIQUE (
  user_id,
  entry_id,
  skill_type_id,
  source_field,
  direction
)
WHERE component_shape = 'form_direction'
```

For entry-level components:

```text
UNIQUE (
  user_id,
  entry_id,
  skill_type_id
)
WHERE component_shape = 'entry_level'
```

Add due lookup index:

```text
(user_id, due_at)
```

Do not use one nullable global unique constraint as a substitute for the two shape-predicated indexes.

---

## 19. `study_sessions`

Create `study_sessions` with sufficient fields for Phase 16 ingestion:

```text
id uuid PRIMARY KEY
user_id uuid NOT NULL
mode text NOT NULL
config jsonb NOT NULL
content_version text NOT NULL
started_at timestamptz NOT NULL
ended_at timestamptz NULL
question_count integer
first_attempt_correct integer
recovered integer
hinted integer
created_at timestamptz
updated_at timestamptz
```

Add:

* User FK with cascade
* Non-negative aggregate checks
* Allowed mode CHECK covering current session modes
* Index by user and start time

Do not upload local sessions in this phase.

---

## 20. `study_attempts`

Create the complete schema required for future authoritative ingestion.

Include the fields documented in `DATA_MODEL.md`, including:

```text
id
user_id
session_id
study_component_id

entry_id
skill_type_id
source_field
direction
prompt_field

prompt_ref
selected_answer_ref
correct_answer_ref

is_correct
is_first_attempt
is_reinforcement
hint_used
hint_type
response_time_ms
question_position
mode

option_count
per_question_limit_ms
question_instance_id
question_seed
question_generator_version

occurred_at_utc
timezone_at_event
utc_offset_minutes_at_event
local_date_at_event
timezone_source

device_id
content_version

created_at
```

Requirements:

* UUID primary key supports client-generated UUIDv7 values.
* User FK cascades.
* Session/component FKs use the appropriate delete policy.
* Stable answer references are structured data, never copied Arabic.
* Reference JSON structures are validated at the Phase 16 API boundary.
* Text values receive structural CHECKs where appropriate.
* `response_time_ms >= 0`.
* `question_position >= 0`.
* Option count respects the current generator’s global bounds when present.
* Time limit is non-negative when present.
* Source-field and direction checks match `study_components`.
* Timezone source matches current client values.
* Indexes:

  * `(user_id, occurred_at_utc)`
  * `(user_id, entry_id)`
  * `(user_id, local_date_at_event)`
  * `study_component_id`
  * `session_id`

Do not create an ingestion API in this phase.

---

## 21. `review_events`

Create the causal-event table according to `DATA_MODEL.md`.

Include:

```text
event_id
user_id
study_component_id
attempt_id
rating
status

base_server_revision
parent_event_id
client_component_revision

occurred_at_client
occurred_at_canonical
server_received_at

device_id
client_sequence
session_id
content_version

timezone_at_event
utc_offset_minutes_at_event
local_date_at_event
timezone_source

timezone_corrected
created_at
```

Requirements:

* `event_id` is the primary idempotency key.
* Rating CHECK:

  * again
  * hard
  * good
  * easy
* Status CHECK:

  * scheduling
  * reinforcement
  * conflict_demoted
  * revoked
  * pending_parent
* Non-negative revision and sequence checks.
* User FK cascades.
* Attempt/component/session relationships are indexed.
* Index:

  * `(study_component_id, occurred_at_canonical)`
  * `(user_id, server_received_at)`
  * partial index for `status = 'pending_parent'`

### Important parent rule

Do not create an immediate parent-event foreign key that prevents storing a `pending_parent` event before its parent arrives.

`parent_event_id` is causal lineage, but Phase 16/19 must be able to hold unknown-parent events.

Document this database decision.

Do not implement branch resolution yet.

---

## 22. `daily_activity`

Create:

```text
daily_activity
```

with:

```text
user_id
local_date
attempts
reviews
new_items
study_ms
updated_at
```

Requirements:

* Composite primary or unique key `(user_id, local_date)`
* User FK cascade
* Non-negative count/time checks
* Date type for `local_date`
* Derived-cache documentation

Do not populate it from guest data in this phase.

---

## 23. Server collection tables

Create account-side collection tables for future sync.

### `bookmarks`

```text
user_id
entry_id
created_at
PRIMARY KEY or UNIQUE (user_id, entry_id)
```

### `custom_lists`

```text
id
user_id
name
normalised_name
created_at
updated_at
```

Requirements:

* UUID ID
* User FK cascade
* Name length constraint aligned with Phase 14
* Unique normalised name per user
* Updated timestamp not before created timestamp where practical

### `custom_list_entries`

```text
list_id
entry_id
created_at
PRIMARY KEY or UNIQUE (list_id, entry_id)
```

Requirements:

* List FK cascade
* Index by entry ID where useful

Do not sync guest bookmarks/lists yet.

Do not copy Arabic, meanings or eligibility into these tables.

---

## 24. `user_settings`

Create one row per account:

```text
user_id PRIMARY KEY
theme
arabic_font_scale
timezone_mode
timezone_name

question_count
option_count
daily_new_target
daily_review_target

created_at
updated_at
```

Align all values and bounds with the existing shared local contracts:

* Current theme constants
* Current Arabic-font-scale constants
* `TimezonePreference`
* `SessionDefaults`
* `SESSION_DEFAULTS_BOUNDS`
* Current generator option-count bounds

Requirements:

* User FK cascade
* Theme CHECK
* Arabic scale CHECK
* Timezone mode CHECK:

  * browser
  * iana
* Shape CHECK:

  * browser mode → timezone name is NULL
  * iana mode → timezone name is non-empty
* Numeric bounds matching the client
* No duplicate incompatible server-only settings type

Extract shared validation constants where doing so does not introduce server imports into browser code.

Do not automatically copy local settings into this row.

---

## 25. `guest_imports`

Create the future merge audit/idempotency table.

Include:

```text
id
user_id
device_id
import_key
imported_at
event_count
attempt_count
result
```

Requirements:

* UUID ID
* User FK cascade
* Unique idempotency key
* Non-negative counts
* Constrained result/status
* Index by user and imported time

Do not perform guest imports in Phase 15.

---

## 26. `content_versions`

Create:

```text
content_versions
```

with:

```text
release_id PRIMARY KEY
content_version
schema_version
question_generator_version
entry_count

checksum_learner
checksum_validation
checksum_assessment

release_status
minimum_supported_client_version
minimum_supported_event_schema

created_at
updated_at
```

Required CHECKs:

```text
release_status IN ('active', 'supported', 'revoked')
entry_count > 0
minimum_supported_event_schema > 0
checksum fields are lowercase 64-character SHA-256 hex
```

Enforce exactly one active release through an appropriate partial unique index or equivalent database invariant.

Do not store vocabulary entries in PostgreSQL.

---

## 27. No vocabulary tables

Migration 0001 must not create:

```text
vocabulary_entries
verbs
arabic_forms
roots
babs
verb_types
meanings
assessment_answers
```

The validated JSON and immutable release artifacts remain the sole content authority.

`skill_types` is a system behaviour lookup, not a vocabulary table.

`content_versions` stores release metadata and checksums only.

---

## 28. Server-manifest loader

Create a server-only loader for:

```text
content-server/release-registry.json
content-server/releases/<release-id>/validation.json
content-server/releases/<release-id>/assessment.json
content-server/releases/<release-id>/checksums.json
public/content/releases/<release-id>/learner.json
```

Use the existing strict Zod schemas.

### Required verification

For every loaded release:

1. Read exact UTF-8 artifact bytes.
2. Parse `checksums.json`.
3. Verify learner SHA-256.
4. Verify validation SHA-256.
5. Verify assessment SHA-256.
6. Parse all artifacts through strict schemas.
7. Confirm every artifact has the same:

   * Release ID
   * Content version
   * Schema version
   * Question-generator version where present
   * Entry count
8. Confirm registry status and protocol minimums.
9. Confirm the requested directory matches the registry entry.
10. Reject path traversal or malformed release IDs.

Do not normalise or reserialise bytes before checksum verification.

### Active release

Load the active release from the server registry.

Fail closed when:

* Registry is invalid
* Active release is missing
* More than one release is active
* Any checksum differs
* Validation and assessment disagree
* The active release is marked revoked
* An artifact has unknown fields
* An artifact is missing

### Caching

Immutable verified releases may be cached by release ID in process memory.

Requirements:

* Cache only after successful complete verification.
* Concurrent requests for one release coalesce.
* Failed loads are not cached as success.
* Tests can reset/inject the cache.
* No browser import path.

---

## 29. Content-version registration

Create an idempotent command:

```text
pnpm db:register-content
```

It should:

1. Verify the complete server registry and manifests.
2. Upsert every registered release into `content_versions`.
3. Preserve release IDs and checksums.
4. Update lifecycle status from the mutable registry.
5. Never create vocabulary rows.
6. Run safely more than once.
7. Execute inside a transaction.
8. Reject inconsistent existing checksum values for an immutable release.
9. Refuse to rewrite immutable release metadata silently.

CI should run this against disposable PostgreSQL.

The active release row in PostgreSQL must match the active server registry.

---

## 30. Better Auth configuration

Configure Better Auth for:

* Email/password sign-up
* Mandatory email verification
* Sign-in only after verification
* Logout
* Password-reset request
* Password reset
* Session cookies
* Account deletion
* Database-backed rate limiting
* UUID IDs
* Drizzle adapter
* User table role field

Suggested password bounds:

```text
minimum: 8
maximum: 128
```

Do not add arbitrary composition rules such as requiring a special character.

Configure password reset to revoke other sessions.

Configure verification and reset token expiry explicitly.

Do not auto-enable OAuth or optional plugins.

---

## 31. Next.js auth handler

Mount Better Auth through the current supported Next.js 16 App Router handler at:

```text
/api/auth/[...all]
```

Requirements:

* Only supported methods exported.
* Node runtime where required.
* No custom body parser.
* No duplicate hand-written login API.
* No custom session cookie implementation.
* No auth API secrets returned to the browser.
* Auth disabled cleanly when `AUTH_ENABLED=false`.

Do not protect the entire application through global proxy/database session checks.

Guest routes must not require auth middleware.

---

## 32. Authentication client

Create one browser auth client using Better Auth’s current React client.

Expose typed operations for:

* Sign up
* Sign in
* Sign out
* Current session
* Request password reset
* Reset password
* Verify/resend email where required
* Delete user

Do not wrap every Better Auth function in unnecessary abstractions.

Do create shared mapping from library errors to learner-safe messages.

Never show:

* Raw Better Auth error objects
* Database errors
* SQL constraint names
* Stack traces
* Verification/reset tokens

---

## 33. Safe redirects

All auth callback/return URLs must be validated.

Allow:

* Same-origin relative paths
* A small explicit default such as `/`

Reject:

* External origins
* Protocol-relative URLs
* JavaScript URLs
* Encoded open redirects
* Backslash variants
* Excessively long values

Default successful authentication to a safe learner route.

Add unit tests for redirect validation.

---

## 34. Registration page

Create:

```text
/register
```

Fields:

* Name
* Email
* Password
* Confirm password

Requirements:

* Client validation for immediate usability
* Server remains authoritative
* Email normalised consistently
* Password bounds visible
* Confirm-password validation
* Accessible labels
* Password autocomplete attributes
* Submit pending state
* Error summary
* Generic existing-account behaviour
* Link to login
* No role input
* No merge prompt
* No upload of guest data

Successful registration should show an honest verification-email state.

Do not claim the account is usable before verification.

---

## 35. Verification flow

Create:

```text
/verify-email
```

Support:

* Verification link handling
* Success state
* Expired/invalid state
* Already-verified state where available
* Resend action
* Rate-limit response
* Link to login

Mandatory verification means an unverified learner cannot create a signed-in session.

Do not include the raw token in learner-facing copy or logs.

Verification-email links must use the configured canonical app origin.

---

## 36. Login page

Create:

```text
/login
```

Fields:

* Email
* Password
* Remember me when supported

Requirements:

* Generic invalid-credentials response
* No distinction between unknown email and wrong password
* Unverified-account state handled without leaking extra account information
* Link to registration
* Link to forgot-password
* Safe return URL
* Accessible loading/error state
* No local guest-data deletion
* No false “progress synced” claim

After login, keep local Dexie state intact.

---

## 37. Forgot/reset password

Create:

```text
/forgot-password
/reset-password
```

### Request page

Always return learner-facing copy similar to:

```text
If an account exists for that email, a reset link has been sent.
```

The visible response must not reveal whether the account exists.

### Reset page

Requirements:

* Validate token presence
* Handle invalid/expired token
* New password
* Confirm password
* Revoke other sessions after successful reset
* Safe success redirect
* No token logging
* No token persisted to localStorage
* No raw provider error displayed

---

## 38. Logout

Provide logout from the account/navigation UI.

Requirements:

* Invalidates current server session
* Updates visible auth state
* Does not clear Dexie
* Does not clear bookmarks/lists
* Does not clear guest profile
* Returns to a safe learner route
* Failure is recoverable

---

## 39. Provider-neutral email contract

Create one email interface conceptually similar to:

```ts
type EmailTemplate =
  | "verify-email"
  | "reset-password"
  | "delete-account";

type SendEmailInput = {
  template: EmailTemplate;
  to: string;
  data: Record<string, string>;
  idempotencyKey: string;
};

interface EmailTransport {
  send(input: SendEmailInput): Promise<SendEmailResult>;
}
```

Adapt to current Better Auth callbacks.

Requirements:

* Better Auth callbacks depend on the provider-neutral interface.
* Auth configuration does not directly instantiate Resend.
* Templates are centralised.
* User-provided values are escaped.
* Plain-text and HTML content are supported where practical.
* Logs never contain passwords.
* Production failures are logged safely.
* Provider response bodies are not sent to clients.

---

## 40. Development console/file email transport

Local development and integration tests must not call Resend.

Create a deterministic transport that:

* Writes each message atomically to a configured outbox directory
* Optionally prints a concise local-only notice
* Records:

  * Message ID
  * Template
  * Recipient
  * Subject
  * HTML/text
  * Created time
* Supports injected time/ID in tests
* Never writes passwords
* Is explicitly blocked in production
* Uses a gitignored directory such as:

```text
.local/email-outbox/
```

Tests should inspect the outbox programmatically rather than parse terminal output.

Provide a safe command to clear the local test outbox.

---

## 41. Resend transport

Production/preview transport should use Resend behind the common interface.

Requirements:

* API key from server environment only
* Verified sender from `EMAIL_FROM`
* Idempotency key supplied
* No external call in unit/integration tests
* Provider error mapped to a safe internal result
* Structured logging without message body/token leakage
* Timeout and retry policy documented
* No indefinite retry loop inside a request
* No Resend import in browser code

Email dispatch should follow the current Better Auth recommendation for avoiding authentication timing leaks.

Do not create noticeably different registration/reset response timing based on account existence or provider latency.

---

## 42. Enumeration safety

Protect:

* Registration
* Verification resend
* Password-reset request
* Login errors

Requirements:

* Registering an existing email must not reveal that it exists.
* Reset request always shows the same visible response.
* Verification resend uses generic copy.
* Login reports generic invalid credentials.
* Response body shapes are stable.
* Case variants do not bypass uniqueness.
* Integration tests compare status and safe response shape for existing/non-existing accounts.
* Do not assert exact nanosecond equality, but avoid obvious control-flow timing leaks.

---

## 43. Rate limiting

Use Better Auth’s supported rate-limit system with database storage.

Do not rely on per-instance memory in preview/production serverless environments.

Apply explicit stricter rules to sensitive endpoints such as:

```text
/sign-up/email
/sign-in/email
/send-verification-email
/request-password-reset
/reset-password
/delete-user
```

Exact paths must match the installed Better Auth version.

Requirements:

* Database-backed counters
* Expiry/window semantics from Better Auth
* Useful `Retry-After` handling
* Generic learner-facing copy
* Enabled in integration tests
* Enabled in production
* Configurable safe test thresholds
* No trusted-client IP derived from arbitrary untrusted forwarded-header positions
* Deployment proxy/header assumptions documented

Add tests proving the configured limit is actually enforced.

---

## 44. Session security

Use Better Auth’s secure session implementation.

Requirements:

* HTTP-only cookies
* Secure cookies in production
* Appropriate SameSite policy
* Session expiry explicitly configured
* Session refresh policy explicitly configured
* Password reset revokes other sessions
* Deleted account cannot retain a usable session
* Session table indexes from generated schema preserved
* No session token stored in localStorage
* No custom JWT introduced
* No cookie contents logged

Do not trust a cookie-presence check as final route/API authorisation.

Protected server routes must validate the actual session.

---

## 45. Auth feature flag

Add:

```text
AUTH_ENABLED
```

Requirements:

* Production-safe explicit value
* Auth routes show a safe unavailable state when disabled
* Guest learner routes work normally
* No server database query is required to render guest content
* No registration prompt points to a broken form when auth is disabled
* Disabling auth acts as the Phase 15 rollback/kill switch
* Tests cover enabled and disabled modes

Do not disable local study features when auth is off.

---

## 46. Guest independence

This is a release-blocking requirement.

Prove that a guest can still:

* Load Dashboard
* Browse Library
* Bookmark vocabulary
* Use custom lists
* Study flashcards
* Complete MC quizzes
* Complete bāb/root quizzes
* Use mixed revision
* Use Custom Session
* View Progress
* View Weak Areas
* Export data

without:

* Registering
* Creating a server session
* Reading a PostgreSQL table
* Writing a PostgreSQL table
* Waiting for the auth service

Avoid database session reads in the root layout.

A broken/unavailable auth endpoint must not strand guest pages.

---

## 47. Navigation and account UI

Update navigation unobtrusively.

Guest state:

```text
Sign in
Create account
```

Signed-in state:

```text
Account
Sign out
```

Requirements:

* Auth-state loading does not block learner navigation.
* Failure to read auth session falls back to guest UI with a non-blocking retry when appropriate.
* Register prompt links to the new registration page.
* Existing mobile navigation remains usable.
* Do not add a mandatory auth modal.
* Account menu has keyboard support and visible focus.
* No raw user ID displayed.

---

## 48. Account page

Create:

```text
/account
```

Show:

* Name
* Email
* Verification status
* Account creation context where appropriate
* Link to account settings
* Change-password action when supported
* Delete-account action
* Logout

Also show an honest Phase 15 notice:

```text
Your vocabulary progress remains stored locally on this device until account syncing is added.
```

Do not show server progress totals.

Do not imply bookmarks or settings have synced.

---

## 49. Account settings API

Create authenticated CRUD for the `user_settings` row.

A suitable contract:

```text
GET /api/account/settings
PUT or PATCH /api/account/settings
DELETE /api/account/settings
```

Requirements:

* Actual server-session validation
* Strict Zod input
* Explicit field allowlist
* Reject unknown fields
* Upsert one row per user
* Return a learner-safe typed response
* Validate timezone through the shared timezone validator
* Validate session-default bounds through shared constants
* Validate theme/font values through shared constants
* Reset/delete returns documented defaults
* No access to another user’s settings
* No raw database errors
* CSRF/session protections
* Rate limit where appropriate

Do not add unauthenticated user-ID parameters.

---

## 50. Account settings UI boundary

Provide a minimal authenticated server-settings page.

It may allow editing the server copy of:

* Theme
* Arabic font scale
* Timezone
* Session defaults

However, do not pretend this is cross-device study-setting sync yet.

Clearly distinguish:

```text
Account settings
```

from the current device’s local study settings when necessary.

Do not automatically overwrite Dexie from server settings.

Do not automatically overwrite server settings from Dexie.

That reconciliation belongs to Phase 16/17.

---

## 51. Account deletion

Provide self-service deletion.

Use Better Auth’s current supported deletion flow or a thin authenticated endpoint around it.

Requirements:

* Requires password or a sufficiently fresh authenticated session according to the installed Better Auth contract
* Explicit confirmation
* Confirmation names the account email
* Generic failure
* Deletes all personally identifiable server rows
* Cascades application user data
* Invalidates sessions
* Does not delete local Dexie guest data automatically
* Explains that local device data remains unless separately cleared
* No asynchronous orphan cleanup left undocumented

Seed application rows in integration tests and prove deletion removes:

* Sessions
* Accounts
* User settings
* Study components
* Attempts
* Events
* Sessions/activity
* Bookmarks
* Lists/list entries
* Guest import records

`skill_types` and `content_versions` must remain.

---

## 52. Health endpoint

Create:

```text
GET /api/health
```

Return only non-sensitive health information such as:

```json
{
  "status": "ok",
  "database": "reachable",
  "activeReleaseId": "...",
  "authEnabled": true
}
```

Requirements:

* Bounded database reachability check
* Verified active manifest load
* No database URL
* No environment dump
* No secret values
* No stack traces
* Appropriate unhealthy HTTP status
* Safe response when auth is disabled
* Integration tests for healthy/unhealthy states

Do not expose assessment content.

---

## 53. Database constraint integration tests

Use disposable PostgreSQL.

Test the actual committed SQL migration and real PostgreSQL constraints.

Do not mock the ORM for these tests.

### Required `study_components` failures

Prove PostgreSQL rejects:

1. Root skill stored as `form_direction`
2. Meaning recognition stored as `entry_level`
3. Form component with NULL `source_field`
4. Form component with NULL `direction`
5. Entry-level component with non-NULL `source_field`
6. Entry-level component with non-NULL `direction`
7. Invalid source-field text
8. Invalid direction text
9. Unknown component shape
10. Negative revision
11. Negative reps
12. Negative lapses
13. Duplicate form component
14. Duplicate entry-level component

### Required successful cases

Prove:

* Different fields coexist.
* Different directions coexist.
* Two users can own the same natural component identity.
* Entry-level skills insert correctly.
* Form skills insert correctly.
* Due index is usable through query-plan inspection where practical.

### Future-shape protection

Prove an unknown future shape cannot be inserted into `skill_types` until an explicit migration extends the CHECK.

---

## 54. Additional database tests

Test:

* User cascade deletion
* Session/account foreign keys
* Attempt/event ownership
* Review-event status CHECK
* Rating CHECK
* Unknown-parent `parent_event_id` can be stored as pending
* Duplicate `event_id` rejected
* Daily-activity uniqueness
* Bookmark uniqueness
* List-membership uniqueness
* List-name uniqueness per user
* Same list name allowed for different users
* User-settings one-row rule
* Settings bounds
* Timezone shape CHECK
* Content checksum CHECKs
* Exactly one active content version
* Guest-import idempotency anchor
* Auth rate-limit table works
* Migration can apply to an empty database
* Migration cannot partially succeed unnoticed

---

## 55. Dexie/PostgreSQL component parity

Create a test using current release fixtures and the shared natural-key builder.

Prove that equivalent valid component fixtures:

* Produce the same natural identity in client code
* Fit the PostgreSQL shape constraints
* Reject the same shape mismatch categories

Do not create a second server natural-key builder.

The existing shared builder remains authoritative.

---

## 56. Manifest-loader tests

Use temporary fixture directories.

Test:

* Valid active release loads.
* Learner checksum mismatch rejects.
* Validation checksum mismatch rejects.
* Assessment checksum mismatch rejects.
* Checksums manifest mismatch rejects.
* Registry references missing release.
* Multiple active releases reject.
* Active ID points to supported rather than active.
* Revoked active release rejects.
* Release ID mismatch rejects.
* Content-version mismatch rejects.
* Schema-version mismatch rejects.
* Question-generator-version mismatch rejects.
* Entry-count mismatch rejects.
* Unknown schema fields reject.
* Missing file rejects.
* Invalid JSON rejects.
* Path traversal rejects.
* Concurrent reads coalesce.
* Failed read can retry after correction.
* Assessment manifest cannot be imported from a client component.

Use exact bytes for checksum tests.

---

## 57. Authentication integration tests

Against disposable PostgreSQL and deterministic email transport, test:

### Registration

* New account created.
* Password stored only as a hash in Better Auth account storage.
* Email verification message created.
* No signed-in session before verification.
* Role defaults to learner.
* Client cannot set role.
* Duplicate email casing does not create another account.

### Enumeration

* Existing-email registration has safe response.
* Unknown/existing reset requests have equivalent visible response shape.
* Login error is generic.

### Verification

* Valid link verifies.
* Invalid token fails safely.
* Expired token fails safely.
* Token cannot be reused to create an unsafe state.
* Verified account can log in.

### Login/session/logout

* Correct login creates session.
* Wrong password fails generically.
* Unverified account cannot log in.
* Session retrieval works.
* Logout invalidates current session.
* Secure cookie settings are correct for environment.

### Password reset

* Request writes test email.
* Valid reset changes password.
* Old password stops working.
* New password works.
* Existing sessions are revoked.
* Invalid/expired token fails safely.

### Rate limiting

* Sensitive endpoint reaches configured limit.
* Further request returns 429.
* Retry metadata exists.
* Separate keys/IPs are isolated according to configuration.

### Account deletion

* Authenticated deletion succeeds.
* Session becomes invalid.
* Cascaded personal rows are removed.

---

## 58. Email-adapter tests

Test:

* Correct template selected.
* Correct recipient.
* Correct same-origin URL.
* HTML escaping.
* Plain-text equivalent.
* Atomic file write.
* Deterministic injected ID/time.
* Production rejects file transport.
* Resend transport receives the idempotency key.
* Provider failure maps safely.
* No email body/token appears in ordinary production logs.
* Verification and reset use distinct idempotency keys.
* No real network request occurs in tests.

---

## 59. Component tests

Add tests for:

* Register form validation
* Password confirmation
* Registration success state
* Generic registration error
* Login form
* Generic invalid credentials
* Unverified account state
* Forgot-password generic response
* Reset valid-token state
* Reset invalid-token state
* Verify-email success/error
* Rate-limit message
* Account page
* Auth-disabled state
* Account-settings loading/save/error
* Delete-account confirmation
* Logout
* Guest navigation with auth unavailable
* Register prompt linking correctly
* Signed-in local-progress notice
* No raw server error displayed
* Safe return URL handling

Avoid tests that merely assert Tailwind classes.

---

## 60. Playwright E2E

Create a dedicated Phase 15 E2E suite.

Use disposable PostgreSQL and deterministic file email transport.

### 60.1 Guest regression

With no authenticated session:

1. Open Dashboard.
2. Browse Library.
3. Open Saved Vocabulary.
4. Begin a study session.
5. Complete one question.
6. Open Progress.

Confirm no registration is required.

### 60.2 Authentication disabled

Run with:

```text
AUTH_ENABLED=false
```

Confirm:

* Guest pages work.
* Register/sign-in UI reports unavailable safely.
* No DB-backed auth request is required for guest study.

### 60.3 Register → verify → login → logout

1. Register a new email.
2. Confirm verification-required state.
3. Read verification message from local outbox.
4. Visit exact verification link.
5. Confirm verification success.
6. Log in.
7. Confirm account UI.
8. Log out.
9. Confirm session is gone.

### 60.4 Unverified login

Attempt login before verification.

Confirm:

* No session
* Safe response
* Resend path available
* No token leaked

### 60.5 Password reset

1. Request reset.
2. See generic response.
3. Read local reset email.
4. Follow reset link.
5. Set new password.
6. Confirm old password fails.
7. Confirm new password logs in.

### 60.6 Enumeration safety

Compare learner-visible responses for:

* Reset request for existing email
* Reset request for unknown email
* Registration for existing email

No UI text should disclose account existence.

### 60.7 Rate limit

Trigger a low test-only rate limit.

Confirm:

* 429 is handled.
* Retry message appears.
* Form remains usable after the test window.

### 60.8 Account settings

1. Log in.
2. Read account settings.
3. Change settings.
4. Reload.
5. Confirm server values persist.
6. Confirm local Dexie values were not silently replaced.

### 60.9 Local guest data survives login/logout

1. Create bookmark/list and study progress as guest.
2. Register and log in.
3. Confirm local data remains.
4. Log out.
5. Confirm local data still remains.
6. Confirm no merge or upload occurred.

### 60.10 Delete account

1. Log in.
2. Create account settings.
3. Delete account with confirmation.
4. Confirm session invalid.
5. Confirm login fails.
6. Confirm local Dexie data remains untouched.
7. Confirm server personal rows are gone through integration helper.

### 60.11 Mobile

At 320px:

* Register
* Verify
* Login
* Open account
* Request reset
* Logout

Confirm no horizontal overflow and reachable controls.

### 60.12 Accessibility

Run axe on:

* Register
* Login
* Verification-required
* Verify success
* Forgot password
* Reset password
* Account
* Account settings
* Delete confirmation
* Mobile auth pages
* Dark-mode auth pages

Fail on serious or critical violations.

---

## 61. CI changes

Update GitHub Actions to run disposable PostgreSQL integration tests on every PR.

Use a PostgreSQL service container with:

* Pinned major version
* Health check
* Test-only credentials
* Test database
* No reused production secret

The Quality job should include:

```text
Install dependencies
Start/check PostgreSQL
Apply full migration chain
Register content versions
Run database constraint tests
Run auth integration tests
Run existing unit/component tests
Build
```

Keep E2E dependent on the Quality job.

Configure E2E with:

* Disposable database
* Migration application
* Test email outbox
* Deterministic app origin
* Auth enabled

Upload useful test artifacts only on failure.

Never upload:

* Database URLs containing passwords
* Verification tokens
* Reset tokens
* Email outbox contents containing live credentials

Test credentials are disposable but should still not be published unnecessarily.

---

## 62. Quality-gate integration

Extend:

```text
scripts/quality-gate.ps1
```

to include server checks.

Add stages for:

* Environment/test prerequisite validation
* Migration validation
* Disposable-Postgres integration tests
* Content-version registration test
* Better Auth integration tests
* Manifest-loader tests

The local quality gate should:

* Start or require an explicit disposable test database
* Never reset a non-test database
* Refuse destructive operations unless the database name matches a strict test pattern
* Clean test state reliably
* Produce concise failure diagnostics
* Remain deterministic

Do not make ordinary unit tests depend on a running database.

---

## 63. Test-database safety

Any reset/drop helper must inspect the parsed database name.

Allow destructive integration-test reset only when the database name clearly matches an approved pattern such as:

```text
safwa_test
safwa_test_<worker>
```

Refuse:

```text
safwa
safwa_prod
production
postgres
neondb
```

Also require:

```text
NODE_ENV=test
```

or an equivalent explicit integration-test flag.

Never expose a generic production-capable “drop all tables” API route.

---

## 64. Migration rollback

Provide a documented rollback for migration 0001.

Because it introduces only new tables, rollback may drop them in dependency-safe order.

Requirements:

* Separate reviewed SQL or documented command
* Test against disposable PostgreSQL
* Never run automatically in production
* Explain that rollback destroys account/server data
* Auth feature flag is the preferred immediate application rollback
* Production rollback requires backup confirmation after real users exist

Do not pretend a destructive rollback is harmless.

---

## 65. Security requirements

At minimum:

* Zod validation at every custom API boundary
* Drizzle parameterisation
* No raw SQL from request input
* No secrets in client bundles
* No assessment manifest in public assets beyond the existing intentional public learner overlap
* No `dangerouslySetInnerHTML` for email/user content
* No password/token logging
* No raw DB error returned
* No open redirects
* No client-controlled role
* No unauthenticated account-settings access
* No unauthenticated deletion
* Rate limiting on sensitive auth operations
* Database-backed rate-limit storage
* Case-insensitive effective email uniqueness
* Secure session cookies
* Password reset revokes sessions
* Account deletion cascades
* Generic enumeration-safe responses
* Server manifests fail closed
* Health endpoint reveals no secrets

Run a security-focused reviewer for this phase.

---

## 66. Performance and reliability

Requirements:

* Reuse one database pool.
* Do not connect during module evaluation where it blocks builds.
* Do not query the database from guest layouts.
* Manifest verification is cached after success.
* Concurrent manifest loads coalesce.
* Auth email delivery cannot hang indefinitely.
* Database and email operations have bounded failure paths where cancellation semantics are safe.
* No automatic migration on every serverless cold start.
* No unbounded retry loops.
* Health checks are bounded.
* Integration tests close database pools.
* Process shutdown handles local pool closure.
* Provider failure does not crash unrelated guest routes.

---

## 67. Documentation updates

Update:

```text
README.md
docs/PRODUCT_REQUIREMENTS.md
docs/ARCHITECTURE.md
docs/DATA_MODEL.md
docs/TEST_STRATEGY.md
docs/DEPLOYMENT.md
docs/OFFLINE_AND_SYNC.md
docs/RISK_REGISTER.md
docs/phases/IMPLEMENTATION_PHASES.md
```

Create:

```text
docs/phases/phases-15.md
```

Document:

* Chosen PostgreSQL driver
* Better Auth package/version contract
* Better Auth schema generation process
* Migration authority
* Logical migration 0001 mapping
* Full table inventory
* Composite FK rationale
* Shape checks
* Partial unique indexes
* Unknown-parent event decision
* No-vocabulary-table boundary
* Server-manifest verification
* Content-version registration
* Email adapter
* Local email transport
* Resend transport
* Rate-limit storage
* Auth feature flag
* Enumeration safety
* Guest independence
* Signed-in local-state limitation
* Account deletion cascade
* Local development commands
* CI database setup
* Rollback procedure
* Environment variables

Do not rewrite unrelated product rules.

Any Arabic used in documentation must use the repository placeholder mechanism.

---

## 68. Manual demonstration

Demonstrate:

1. Start local PostgreSQL.
2. Apply migration.
3. Run migration again safely.
4. Show seeded `skill_types`.
5. Show registered `content_versions`.
6. Show no vocabulary tables exist.
7. Run a successful form-component insert.
8. Show root-as-form constraint rejection.
9. Show entry-level-with-source-field rejection.
10. Show duplicate partial-index rejection.
11. Run server-manifest verification.
12. Tamper with a temporary checksum fixture and show rejection.
13. Register an account.
14. Show verification email in local outbox.
15. Verify the account.
16. Log in.
17. Log out.
18. Request password reset.
19. Reset password.
20. Show old password rejected.
21. Show rate limiting.
22. Read/update account settings.
23. Show local Dexie settings unchanged.
24. Create local guest study data.
25. Log in and show guest data remains.
26. Delete the account.
27. Show server personal rows removed.
28. Show local guest data remains.
29. Disable auth and show guest study still works.
30. Show `/api/health`.
31. Show desktop auth pages.
32. Show 320px auth flow.
33. Show keyboard-only flow.
34. Show dark mode.
35. Show axe results.
36. Show complete quality gate.

---

## 69. Acceptance criteria

Phase 15 is complete only when:

* Phase 14 is merged first.
* PostgreSQL local setup exists.
* Drizzle is configured.
* One committed initial migration exists.
* Better Auth schema is generated for the pinned installed version.
* User IDs and application user FKs use one compatible UUID type.
* Auth core tables exist.
* Database-backed rate-limit table exists.
* `skill_types` exists and is seeded.
* `study_components` has the composite skill/shape FK.
* Shape CHECKs are database-enforced.
* Source-field and direction CHECKs are database-enforced.
* Shape-predicated partial unique indexes exist.
* `study_attempts` exists.
* `review_events` exists.
* Unknown-parent pending events are not blocked by an incorrect FK.
* `study_sessions` exists.
* `daily_activity` exists.
* Server bookmark/list tables exist.
* `user_settings` exists.
* `guest_imports` exists.
* `content_versions` exists.
* Exactly one active content-version row is enforced.
* No vocabulary tables exist.
* Server manifests load through strict schemas.
* Learner, validation and assessment checksums are verified.
* Cross-artifact identity is verified.
* Active/revoked status is enforced.
* Content-version registration is idempotent.
* Registration works.
* Email verification is mandatory.
* Login works after verification.
* Logout works.
* Password reset works.
* Password reset revokes other sessions.
* Enumeration-safe responses are proven.
* Case variants cannot create duplicate accounts.
* Rate limits are proven.
* Local console/file email works.
* Tests make no real Resend call.
* Resend remains behind an adapter.
* Account settings CRUD works.
* Account deletion cascades server data.
* Account deletion leaves local Dexie untouched.
* Auth can be disabled through a feature flag.
* Guests remain fully functional with auth disabled.
* Guest pages do not require PostgreSQL.
* Login does not clear or upload guest data.
* The UI does not claim progress is synced.
* `/api/health` is safe and bounded.
* Disposable-Postgres constraint tests pass.
* Auth integration tests pass.
* Register→verify→login→logout E2E passes.
* Password-reset E2E passes.
* Guest regression E2E passes.
* Mobile layouts work.
* Axe reports no serious or critical violations.
* Full Phase 0–15 quality gate passes.
* No Phase 16 sync code is included.
* Nothing under `data/` changes.
* Generated content artifacts remain deterministic.
* Claude council approves the exact final bytes.
* Independent external review runs when required by repository policy.
* GitHub CI passes.

---

## 70. Final validation

Run:

```powershell
pnpm install --frozen-lockfile

pnpm db:check
pnpm db:migrate
pnpm db:register-content

pnpm test
pnpm test:integration
pnpm test:e2e
pnpm test:coverage

powershell -ExecutionPolicy Bypass -File scripts/quality-gate.ps1

git diff --check
git status --short
```

Also inspect PostgreSQL directly:

```sql
SELECT id, component_shape FROM skill_types ORDER BY id;

SELECT release_id, release_status
FROM content_versions
ORDER BY release_id;

SELECT tablename
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
```

Confirm no vocabulary-content table exists.

Run the complete gate again after the final reviewer correction.

---

## 71. Final inspection

Before committing:

```powershell
git status
git diff --stat
git diff --check
git diff
```

Confirm:

* Phase 14 is in the base.
* No files under `data/` changed.
* No generated artifact changed unexpectedly.
* No assessment manifest is imported by client code.
* No secret entered a public environment variable.
* No real email was sent during tests.
* No database reset can target production.
* No vocabulary table exists.
* No sync API exists.
* No guest merge exists.
* No attempt/event ingestion endpoint exists.
* No server FSRS replay exists.
* No guest route requires auth.
* No root layout performs a mandatory DB read.
* No account flow clears Dexie.
* No UI claims cross-device sync.
* Only intentional Phase 15 changes remain.

---

## 72. Commit

Commit with:

```text
Phase 15: add server, database and account foundation
```

Push and open a draft PR through `/phase-loop`.

Do not merge automatically.

---

## 73. Final response

Report:

1. Preflight results.
2. Base commit.
3. Phase 14 merge confirmation.
4. Dependencies added.
5. Chosen PostgreSQL driver and rationale.
6. Environment variables.
7. Docker PostgreSQL setup.
8. Drizzle configuration.
9. Migration filename and logical migration number.
10. Better Auth schema-generation process.
11. Complete table inventory.
12. Better Auth table inventory.
13. Rate-limit table/storage.
14. UUID strategy.
15. `skill_types` seed.
16. Composite FK implementation.
17. Shape CHECK implementation.
18. Partial unique indexes.
19. Attempt schema.
20. Review-event schema.
21. Unknown-parent decision.
22. Session/activity schema.
23. Bookmark/list schema.
24. User-settings schema.
25. Guest-import schema.
26. Content-version schema.
27. Proof no vocabulary tables exist.
28. Manifest-loader architecture.
29. Checksum-verification process.
30. Content-registration process.
31. Auth configuration.
32. Verification requirements.
33. Login/logout flow.
34. Password-reset flow.
35. Enumeration safety.
36. Email adapter design.
37. Development email transport.
38. Resend transport.
39. Rate-limit rules.
40. Redirect validation.
41. Auth feature flag.
42. Guest independence.
43. Signed-in local-state limitation.
44. Account-settings CRUD.
45. Account-deletion cascade.
46. Health endpoint.
47. Database-constraint tests.
48. Authentication integration tests.
49. Manifest tests.
50. Email tests.
51. Component tests.
52. E2E tests.
53. Exact test counts.
54. CI changes.
55. Quality-gate changes.
56. Migration rollback.
57. Security review outcome.
58. Accessibility results.
59. Mobile results.
60. Existing Phase 0–14 regression results.
61. Confirmation no Phase 16 work exists.
62. Confirmation no real emails were sent.
63. Confirmation generated content is unchanged.
64. Confirmation `data/` is unchanged.
65. Final Git status.
66. Commit SHA.
67. Draft PR URL.
68. Reviewer/council outcomes.
69. Correction cycles.
70. Remaining concerns and deliberately deferred Phase 16 work.

Stop after Phase 15.

Do not begin Phase 16.
