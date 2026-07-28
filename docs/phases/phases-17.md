# Phase 17 — Guest-to-Account Merge and Core MVP

Implement **Phase 17 — Guest→account merge** for Safwa.

Use the established `/run-phase` workflow (the repository's standard phase
workflow; it supersedes the older single-reviewer `/phase-loop` skill —
CLAUDE.md, "Phase implementation workflow"):

```text
/run-phase phase-17 Phase 17 — Guest-to-account merge and Core MVP. Implement exactly the Phase 17 requirements in docs/phases/IMPLEMENTATION_PHASES.md and the guest-merge contracts in docs/PRODUCT_REQUIREMENTS.md, docs/DATA_MODEL.md, docs/OFFLINE_AND_SYNC.md, docs/ARCHITECTURE.md and docs/TEST_STRATEGY.md. Add an explicit, consent-based, deterministic and idempotent guest-to-account merge that submits guest attempts and review events through the existing Phase 16 server-authoritative validation, grading and replay pipeline; unions bookmarks and lists; preserves account settings while using guest settings only where the account has no value; re-keys local guest state safely to the account; rebases onto authoritative server state; and proves the merged state appears on a second signed-in device. Resolve the Phase 16 Dexie owner-key collision limitation so guest and account rows can coexist without overwriting each other. Preserve original attempt/event ids, event-time metadata and internal guest lineage. Do not begin Phase 18 PWA/offline-queue guarantees, Phase 19 general multi-device offline conflict resolution, Phase 20 resets or later phases.
```

Work only on Phase 17.

Do not begin service-worker/PWA work, durable offline retry guarantees, general concurrent-device conflict resolution, pessimistic branch demotion, reset controls, admin tooling or production launch hardening.

---

## 1. Required prerequisite

Phase 16 PR **#22** must be:

* Reviewed.
* Merged into `main`.
* Green in GitHub Actions.

Before implementation, confirm `origin/main` contains:

```text
Phase 16 — Online Sync (Stage A): server-authoritative learning state
```

The Phase 16 foundation that must already exist includes:

* Authenticated and verified-account sync endpoints.
* Strict Zod sync wire schemas.
* Server-authoritative objective grading.
* Validation against retained validation and assessment manifests.
* Attempt and event idempotency.
* Canonical event-time handling.
* Stage A causal-chain ingestion.
* Deterministic server replay.
* Account-wide pull cursor.
* Client push, pull and rebase.
* Durable post-sync undo through revocations.
* Bookmark, list and settings sync.
* Sync-status UI.
* Local owner scoping in Dexie schema v6.
* Shared-device logout cleanup.
* `SYNC_ENABLED` kill switch.
* Disposable-Postgres integration tests.
* Existing Phase 16 migrations and rollback.
* Full quality-gate and CI integration.

Do not build Phase 17 on the old Phase 16 branch.

Stop and report if Phase 16 is not merged, migrations do not apply cleanly, or `origin/main` is red before any Phase 17 edits.

---

## 2. Required branch

Create:

```text
phase/17-guest-account-merge
```

from the latest merged `origin/main`.

Do not reuse an earlier phase branch.

Do not stack this phase on an unmerged pull request.

---

## 3. Save the detailed phase specification

Create:

```text
docs/phases/phases-17.md
```

using this prompt as the implementation specification, adjusted only where repository discovery proves that a file name or already-implemented contract differs.

The merged implementation is authoritative where it is stricter or more developed than older planning prose. Document any reconciliation between this specification and the current code.

---

## 4. Read the repository before planning

Read all repository instructions and architecture documents before editing:

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
docs/phases/phases-14.md
docs/phases/phases-15.md
docs/phases/phases-16.md

docs/adr/*
```

Inspect the current implementation, especially:

```text
package.json
pnpm-lock.yaml
tsconfig.json
vitest.config.*
playwright.config.*
.github/workflows/ci.yml
scripts/quality-gate.ps1

db/schema/*
db/migrations/*
db/rollback/*
tests/integration/*
e2e/helpers/*

modules/auth/*
modules/content/db.ts
modules/content/owner-scope.ts
modules/profile/*
modules/collections/*
modules/analytics/*
modules/scheduler/*
modules/study-engine/*
modules/study-session/*

modules/sync/protocol/*
modules/sync/server/*
modules/sync/client/*
modules/sync/README.md

components/account/*
components/auth/*
components/register-prompt.tsx
components/sync/*
app/api/sync/*
app/(shell)/account/*
```

Search the repository for:

```text
guest_imports
importKey
guest
userId
LocalOwnerId
owner-scope
accountScopedTables
clearAccountLocalState
study_components
study_attempts
review_events
bookmarks
lists
settings
mutation_queue
sync_state
stale_branch_conflict
payload_conflict
parentEventId
clientComponentRevision
baseServerRevision
applyPullResponse
reconcile
pull
logout
account switch
```

Pay particular attention to the current Phase 16 limitations:

1. Dexie v6 added `userId` indexes but left several primary keys unchanged.
2. A guest and account can be read separately, but an account write using the same natural key can physically replace the guest row.
3. Sign-out currently clears every account-scoped store, including guest rows.
4. Login deliberately does not upload or merge guest data.
5. Normal bookmark/list/settings sync semantics are not automatically the correct guest-import semantics.
6. Stage A normal sync rejects a genuine stale scheduling branch instead of applying Phase 19 conflict resolution.
7. The full authenticated multi-context sync E2E was deferred.

Do not preserve these limitations merely because they exist today: resolving the relevant ones is part of Phase 17.

---

## 5. Verify current official library contracts

Before implementing database migrations, IndexedDB migrations, route handlers or authentication-sensitive UI, verify official documentation for the exact versions pinned in the repository:

* Next.js App Router route handlers.
* Better Auth session retrieval and verified-user enforcement.
* Drizzle transactions, advisory locks, savepoints and conflict clauses.
* PostgreSQL unique constraints and idempotent import patterns.
* Dexie data-moving version upgrades and compound primary keys.
* IndexedDB-valid key types.
* Zod strict schemas and bounded arrays.
* Playwright authenticated multi-context testing.
* Vitest integration testing against PostgreSQL.

Use primary official documentation only.

Do not upgrade dependencies unless Phase 17 genuinely requires it. Keep any upgrade minimal, pinned and justified.

Do not add another database, state-management, queueing or API framework.

---

## 6. Preflight

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

* The working tree is clean.
* Phase 16 is merged into `origin/main`.
* The branch starts at current `origin/main`.
* PostgreSQL is reachable.
* The entire migration chain succeeds from an empty disposable database.
* Content registration succeeds.
* All Phase 0–16 checks pass before editing.
* The sync kill switch still works.
* Guests can still study without authentication.
* Login does not currently merge guest data.
* The active content release remains valid and contains 455 entries.
* Nothing under `data/` has changed.

Stop rather than stashing, resetting, deleting or overwriting unrelated user work.

Record preflight evidence and assumptions in the `/run-phase` runtime state
(`.claude/review/runtime/active-phase.json`).

---

## 7. Phase objective

Deliver a safe, explicit and complete guest-to-account merge.

A learner must be able to:

1. Study as a guest and build meaningful local progress.
2. Register or sign in.
3. Be told clearly that guest data exists on this device.
4. Choose whether to merge it into the signed-in account.
5. Merge every valid guest attempt and scheduling event without trusting local grading claims.
6. Preserve original attempt ids, event ids, device id, event-time timestamps, timezone metadata, release identity and the guest chain’s internal lineage.
7. Combine guest and account learning history through deterministic server replay.
8. Merge bookmarks and custom lists with documented union semantics.
9. Keep account settings, using guest values only where the account has no existing value.
10. Re-key imported local data to the account without losing or duplicating it.
11. Rebase local projections onto the authoritative server result.
12. See an honest summary of what was merged.
13. Retry safely after interruption.
14. Run the same merge again with no additional effect.
15. Sign in on a second browser context and see the merged authoritative state.
16. Defer the merge without losing the guest data.

This phase completes the **Core MVP** milestone.

---

## 8. Hard phase boundaries

### In scope

* Detecting meaningful guest data after authentication.
* Explicit merge consent.
* A later “merge guest data” entry point when the learner initially defers.
* Durable import identity and retry state.
* Guest snapshot creation.
* Bounded/chunked upload for large histories.
* Server-authoritative validation and grading.
* Deterministic guest/account union replay.
* `guest_imports` idempotency and audit records.
* Bookmark union.
* Custom-list name deduplication and membership union.
* Account-wins settings reconciliation.
* Dexie data-moving migration where required.
* Safe guest/account local coexistence.
* Local owner re-keying.
* Authoritative post-merge rebase.
* Post-merge summary UI.
* Scoped logout/account-switch cleanup that preserves deferred guest rows.
* Authenticated two-context E2E.
* Core MVP documentation and checklist completion.

### Explicitly out of scope

* Automatic merge without consent.
* Deleting guest data merely because the user signs in.
* PWA installation or service workers.
* Background Sync API.
* Phase 18 durable offline retry/backoff guarantees.
* Phase 19 general offline concurrent-branch conflict resolution.
* Pessimistic winner selection or `conflict_demoted` handling for normal device conflicts.
* The legacy ten-minute concurrency fallback.
* Progress reset controls.
* Admin/content-management features.
* New quiz types.
* Vocabulary edits.
* OAuth, passkeys, magic links or 2FA.
* Production deployment.

---

## 9. Non-negotiable trust and safety rules

### 9.1 Consent is mandatory

Never upload, claim, re-key or delete guest data automatically on login.

The user must explicitly choose to merge.

At minimum provide:

* **Merge guest progress**
* **Not now**

“Not now” must be non-destructive. The option to merge later must remain available from an appropriate account or data-settings surface while guest data still exists.

Do not add a destructive “discard guest data” action unless it has a separate explicit confirmation and is required by an existing product contract.

### 9.2 Server derives ownership

Every merge endpoint must:

* Require an authenticated, email-verified session.
* Derive `userId` only from the server session.
* Never accept an authoritative user id from the request.
* Scope every read and write to that session user.
* Treat the import key as idempotency metadata, not authorization.
* Return enumeration-safe failures.
* Never expose raw database errors.

### 9.3 Do not trust guest grading

Guest objective attempts must pass through the same Phase 16 reconstruction and grading rules as ordinary account sync:

* Validate the release and manifests.
* Reconstruct the question.
* Verify the option set and selected answer reference.
* Derive correctness.
* Derive rating.
* Validate component identity and eligibility.
* Validate event-time metadata.
* Canonicalise timestamps.
* Audit tampering or impossible payloads.

Do not add a privileged “trust imported guest state” shortcut.

### 9.4 Preserve original historical identity

For every imported guest attempt and review event, preserve:

* Attempt id.
* Event id.
* Session id where represented.
* Device id.
* Question seed and generator version.
* Release id and content version.
* Original event-time instant.
* Timezone, offset, local date and timezone source.
* Parent relationships within the guest chain.
* Client component revisions.
* Hint and delivery-mode metadata.
* First-attempt/reinforcement semantics.

Do not replace historical records with a single copied FSRS card.

The server result must come from replay, not “take the stronger card”, “take the latest card” or “copy local state”.

### 9.5 Guest data is deleted only after durable success

Never remove or overwrite the only local copy before:

1. The server has accepted or safely accounted for the import.
2. The import has a durable idempotency record.
3. The client has received the authoritative merged state.
4. The local re-key/rebase transaction has completed successfully.

If server application succeeds but local finalisation fails, a retry must resume safely from the durable import key and server state.

---

## 10. Resolve the Dexie owner-identity limitation

Phase 16’s additive `userId` indexes are insufficient because primary keys such as `componentKey`, `entryId` and `key` are shared between identities.

Design and implement the smallest correct data-moving Dexie migration that guarantees guest and account records can coexist without replacing each other.

Use a canonical, IndexedDB-valid, non-null owner key such as:

```text
guest
account:<user-id>
```

or an equivalent rigorously validated representation.

Do not put `null` or `undefined` inside a compound IndexedDB primary key.

At minimum assess and migrate every store whose logical primary key can collide across owners, including:

* `study_components`
* `bookmarks`
* `settings`
* `lists`, if its current identity or merge mapping cannot safely coexist

Also inspect:

* `review_events`
* `study_attempts`
* `sessions`
* `daily_activity`
* `mutation_queue`
* `sync_state`

Do not change globally unique attempt/event ids unnecessarily. Preserve original ids used by server idempotency.

Requirements for the migration:

* Existing pre-v6 rows with absent owner are treated as guest rows.
* Existing v6 guest rows become the canonical guest owner.
* Existing account rows retain their owner.
* Every migrated row remains readable.
* No guest row is overwritten by an account row.
* No account can read another account’s rows.
* The migration is transactional and tested with populated fixtures.
* Opening and reopening the migrated database is tested.
* Failure rolls back without partial migration.
* Export remains valid.
* The derived `daily_activity` cache may be rebuilt rather than treated as authoritative.
* Existing content-cache stores remain untouched.

Update all persistence adapters, queries, live queries and hooks to use the new identity contract. Do not scatter ad hoc compound-key construction across components; provide one shared builder/parser owned by the persistence layer.

---

## 11. Scoped logout and account-switch cleanup

Once owner-safe keys exist, replace Phase 16’s whole-store account cleanup with safe owner-scoped cleanup.

Signing out or switching accounts must:

* Remove the departing account’s local private rows.
* Remove its mutation queue and sync cursor.
* Prevent the next account from reading any previous account data.
* Preserve guest-owned rows that have not been merged.
* Preserve content caches and the anonymous device profile.
* Preserve a deferred guest merge opportunity.
* Avoid deleting another account’s rows through an owner-filter bug.
* Work when a prior write or session resolution is interrupted.

Account deletion should similarly clear deleted-account local state while following the product’s existing guest-data policy.

Add regression tests proving that “Not now → sign out → continue as guest” does not lose the guest’s progress.

---

## 12. Guest snapshot and import identity

Create a coherent guest snapshot from the canonical guest owner.

The snapshot should include, as applicable:

* Guest attempt records.
* Guest scheduling review events.
* Guest bookmarks.
* Guest custom lists and canonical membership.
* Guest syncable settings.
* Device id.
* Counts and stable metadata required for summaries and validation.

Do not upload:

* Content artifacts.
* Authentication/session data.
* Secrets.
* Derived caches as authoritative data.
* Live component projections as a substitute for events.
* Dead or unrelated account queue entries.
* Arbitrary settings outside the existing allow-list.

Create a durable client-generated import key that:

* Is cryptographically strong.
* Is stable across retries of the same guest snapshot.
* Is not regenerated on every request.
* Cannot collide across independent imports.
* Is persisted before the first network mutation.
* Is tied to a stable canonical snapshot hash or equivalent conflict detector.

The same import key with the same snapshot must be a no-op after success.

The same import key with materially different content must fail safely as a payload conflict rather than silently treating different data as the same import.

If the guest dataset is larger than existing push bounds, upload it in bounded chunks. Do not create one unbounded request merely to simplify implementation.

Interruption after any chunk must be recoverable through existing attempt/event idempotency plus the stable import key.

---

## 13. Server merge API

Add a dedicated authenticated merge API under a clear route such as:

```text
app/api/sync/guest-merge/*
```

The precise staged route design may be adjusted after repository inspection, but it must support:

* Strict request and response schemas.
* Stable import key.
* Snapshot identity/hash.
* Bounded batches.
* Per-item results where useful.
* Retry/resume.
* Finalisation.
* Post-merge authoritative state or a cursor allowing an immediate pull.
* An explicit final status: applied, no-op, rejected or incomplete/retryable.
* Counts for the post-merge summary.

Do not expose a client-controlled `ingestionMode: guestMerge` flag on the ordinary sync endpoint.

Any merge-specific ingestion mode must be server-internal and reachable only through the authenticated merge coordinator.

Reuse current Phase 16 modules. Do not duplicate:

* Attempt validation.
* Question reconstruction.
* Correctness derivation.
* Rating derivation.
* Content-manifest loading.
* Canonical-time logic.
* Event idempotency.
* Replay.
* Cursor handling.
* Audit redaction.
* Collection validation.
* Settings validation.

Refactor existing modules into shared server functions only where required.

---

## 14. Guest and account history union

The merge must support:

1. Guest history only.
2. Account history only.
3. Guest and account history on different components.
4. Guest and account history on the same component.
5. Interleaved event-time histories.
6. Repeated delivery.
7. A partially completed retry.

Normal Phase 16 sync rejects a competing root or stale branch because Phase 19’s general conflict policy is not implemented. A guest merge is a separate, explicit identity-union operation and must not simply lose valid guest scheduling history to `stale_branch_conflict`.

Implement a narrow merge-specific union policy:

* Validate guest events through the normal server trust boundary.
* Preserve their original ids and internal parent relationships.
* Keep existing accepted account events.
* Treat the valid account and guest histories as one explicit imported union.
* Replay all accepted merge-history events deterministically.
* Use deterministic topological/canonical ordering for independent roots or branches.
* Do not copy either side’s precomputed FSRS state.
* Do not apply Phase 19’s pessimistic winner or descendant-demotion rules.
* Do not make this behaviour available to ordinary sync requests.
* Document clearly why explicit identity merge is different from general concurrent-device reconciliation.

Invalid, tampered, revoked-release or impossible guest records must be rejected safely and remain locally recoverable/exportable. Do not report a fully successful merge while silently discarding rejected history.

The final server component state must equal replay of the accepted account-plus-guest union.

---

## 15. `guest_imports` idempotency

Use the existing `guest_imports` table as the durable import audit and idempotency anchor.

Review whether its current columns and global `importKey` uniqueness are sufficient. Add an explicit Drizzle migration if additional fields or constraints are required, such as:

* Snapshot hash.
* Completion status.
* Applied/rejected counts.
* Final server cursor.
* Completed timestamp.
* Safe result metadata.

Requirements:

* Same successful import resubmitted: no-op.
* No duplicate attempts.
* No duplicate events.
* No second FSRS application.
* No unnecessary revision or cursor bumps.
* Same key with different payload: safe conflict.
* Import key cannot be claimed across accounts.
* Partial processing cannot be mistaken for completed success.
* Account deletion cascades import records.
* Rejections and anomalous conflicts are audit-logged without storing sensitive payloads.

Create the next migration number based on the actual repository state and add a matching rollback script.

Run the full migration chain from an empty database.

---

## 16. Bookmark merge semantics

Guest and account bookmarks use set-union semantics:

```text
merged bookmarks = account entry ids ∪ guest entry ids
```

Requirements:

* Dedupe by entry id.
* Never delete an account bookmark because the guest lacks it.
* Validate entry ids.
* Repeating the import is a no-op.
* Stamp changed rows with the account sync cursor so another device receives them.
* Clear stale tombstones for reintroduced bookmarks.
* Return accurate merged/unchanged/rejected counts.

---

## 17. Custom-list merge semantics

Custom lists merge by normalised list name.

For a guest list whose normalised name already exists in the account:

* Preserve the account list as the canonical list.
* Union its entry membership with the guest list.
* Preserve the account’s display name and account-owned metadata unless the current documented policy requires otherwise.
* Return a guest-list-id → account-list-id mapping for local re-keying.

For a guest list with a new normalised name:

* Create an account list.
* Preserve the guest UUID when safe.
* If the UUID collides with an inaccessible or different list, create a new server UUID without revealing another account’s ownership.
* Return the resulting id mapping.

Additional rules:

* Canonicalise membership.
* Dedupe and sort entry ids.
* Validate names using the existing shared validator.
* Respect list-count and membership bounds.
* Never silently discard a name conflict.
* Repeated import must not produce duplicate lists or memberships.
* Imported list rows must be visible through ordinary Phase 16 pull on another device.

---

## 18. Settings merge semantics

Account settings win.

Guest settings may fill only genuine account gaps.

Because the current server schema may materialise defaults as non-null columns, inspect how account settings rows are created and define “gap” precisely.

At minimum:

* If no account settings row exists, valid guest syncable settings may initialise it.
* If the account already has a value for a setting, preserve the account value.
* Do not overwrite explicit account preferences with guest timestamps.
* Ignore settings outside `SYNCABLE_SETTING_KEYS`.
* Validate guest values through the existing server allow-list.
* Pull the authoritative account values back to the client after merge.
* Update localStorage mirrors using the existing preference-adoption path.
* Repeating the merge does not rewrite unchanged settings or bump cursors unnecessarily.

Do not introduce field-level provenance unless it is genuinely required for correctness.

---

## 19. Client merge flow

Implement an accessible, honest client state machine with states such as:

```text
checking
no-guest-data
ready-for-consent
deferred
preparing
uploading
finalising
rebasing
completed
completed-no-op
retryable-error
attention-required
```

The UI must:

* Appear only after the auth session is resolved.
* Never misclassify a pending session as a guest.
* Detect meaningful guest data without creating a guest profile from passive reads.
* Explain what will be merged.
* Show useful counts before confirmation where practical.
* Allow “Not now”.
* Expose the deferred action later.
* Disable duplicate submissions while active.
* Survive reload/interruption.
* Surface retryable failures.
* Avoid claiming success before local finalisation.
* Avoid raw internal ids, keys, payloads or database messages.
* Work at 320px.
* Support keyboard-only operation.
* Have visible focus.
* Use appropriate dialog/alert/live-region semantics.
* Honour dark mode and reduced motion.

Do not block the learner from using the signed-in account merely because they deferred the merge.

However, prevent account study writes from physically overwriting guest rows by landing the owner-key migration before enabling coexistence.

---

## 20. Local finalisation and rebase

After the server merge completes:

1. Pull or receive the authoritative merged account state.
2. Apply authoritative component projections.
3. Update imported local attempts and review events to the account owner.
4. Apply server event statuses and canonical results.
5. Apply bookmark/list union results and list-id mappings.
6. Preserve authoritative account settings.
7. Reset or advance the account sync cursor correctly.
8. Remove stale imported guest queue entries.
9. Rebuild derived analytics caches from merged raw history.
10. Ensure normal sync does not upload the imported rows again as new data.
11. Remove guest-owned source rows only after the account-owned result is durable.
12. Preserve any guest data that was rejected or not part of the completed snapshot, with an honest recovery path.

Perform local changes in the smallest safe Dexie transaction set. Avoid a transaction so large that it becomes impractical, but never leave the database claiming a completed local merge when only half of the ownership conversion committed.

If local finalisation fails after server success, store enough state to retry finalisation without reapplying the server import.

---

## 21. Post-merge summary

Show a concise summary containing accurate values such as:

* Attempts imported.
* Scheduling events imported.
* Components updated.
* Bookmarks added.
* Lists created.
* Lists combined.
* Settings filled.
* Records already present/no-op.
* Any records needing attention.

Do not expose internal event ids, natural keys, audit details or rejection payloads.

The summary must distinguish:

* Successful merge.
* Successful no-op/repeated merge.
* Partial/retryable merge.
* Rejected records requiring attention.

Provide clear next actions, including continuing to study and retrying unresolved items.

---

## 22. Required unit tests

Add focused unit tests for at least:

* Owner-key construction and parsing.
* Guest/account compound-key isolation.
* Guest snapshot selection.
* Meaningful-guest-data detection.
* Stable import-key reuse.
* Snapshot hash determinism.
* Same key/different snapshot conflict handling.
* Merge client state machine.
* Bookmark union.
* List-name normalisation and membership union.
* Guest-list-id to account-list-id mapping.
* Settings account-wins/gap-fill rules.
* Local finalisation planning.
* Import-result summary calculations.
* Scoped logout cleanup planning.
* No automatic upload before consent.
* Deferred merge remains available.

Keep pure merge rules outside React and Dexie where practical.

---

## 23. Required Dexie migration tests

Add populated migration tests covering:

* Fresh database at the new version.
* v1→latest.
* v2→latest.
* v3→latest.
* v4/v5/v6→latest.
* Pre-v6 rows with absent `userId`.
* Coexisting guest and account component with the same natural key.
* Coexisting guest and account bookmark with the same entry id.
* Coexisting guest and account setting with the same key.
* Custom-list identity/mapping cases.
* Existing attempt and event ids preserved byte-for-byte.
* Derived cache rebuild.
* Reopen after migration.
* Upgrade failure rollback.
* Export after migration.
* Account-scoped cleanup preserving guest rows.
* Guest/account reads never crossing owners.

Do not weaken existing migration assertions.

---

## 24. Required PostgreSQL integration tests

Against the disposable `safwa_test` database, prove:

### Idempotency

* First import applies.
* Exact resubmission is a no-op.
* Attempt count does not increase twice.
* Event count does not increase twice.
* FSRS replay does not run twice.
* Component revisions do not double-advance.
* Cursor does not bump for a pure no-op.
* Same import key with different snapshot is rejected.

### History union

* Guest-only fixture.
* Account-only fixture.
* Guest and account on different components.
* Guest and account on the same component.
* Interleaved event-time history.
* Multiple guest events in one internal chain.
* Multiple valid roots in an explicit merge union.
* Final component state equals deterministic replay of the accepted union.
* All accepted attempts remain queryable.
* Original ids and historical metadata are preserved.

### Trust boundary

* False guest `isCorrect` is corrected.
* Wrong claimed rating is corrected.
* Altered answer references are rejected.
* Tampered natural key is rejected.
* Unknown generator version is recoverable.
* Revoked release is handled safely.
* Cross-account parent/event references are rejected.
* Client-supplied user id cannot redirect an import.
* Ordinary sync cannot activate merge-only union behaviour.

### Collections/settings

* Bookmark union.
* Existing bookmark unchanged.
* Same-name list membership union.
* New list creation.
* List-id collision mapping.
* Repeated list import no-op.
* Account settings preserved.
* Guest settings initialise only genuine gaps.
* Invalid settings rejected safely.
* Pull returns all merged collections/settings.

### Transaction and recovery

* A rejected item does not corrupt accepted items.
* A mid-import retry resumes safely.
* A finalisation failure cannot create a false completed import record.
* Account deletion cascades `guest_imports`.

Follow the repository’s integration-test isolation convention: one database reset per file and a distinct test user per test unless a global-table constraint requires a single combined test.

---

## 25. Required component tests

Cover:

* Merge prompt with detected guest data.
* No prompt when there is no meaningful guest data.
* Pending auth session does not trigger guest behaviour.
* “Not now” is non-destructive.
* Deferred action appears later.
* Loading/upload/finalising/rebasing states.
* Retryable error.
* Successful summary.
* Repeated/no-op summary.
* Partial-attention summary.
* Keyboard focus management.
* Screen-reader live announcements.
* Dialog dismissal rules.
* Dark mode.
* Reduced motion.
* 320px layout.
* No raw internal error text.

---

## 26. Required Playwright E2E

Add a dedicated Phase 17 E2E suite covering the full Core MVP journey.

### Main acceptance journey

1. Begin as a guest.
2. Complete real study activity through the existing UI.
3. Produce both correct and incorrect/reinforcement history.
4. Add bookmarks.
5. Create a custom list.
6. Change at least one guest setting.
7. Register.
8. Retrieve and use the verification link through the existing safe test helper.
9. Sign in.
10. Confirm the merge prompt appears.
11. Inspect the pre-merge summary.
12. Consent to merge.
13. Wait for an honest completed state.
14. Confirm dashboard/progress is identical or better than the guest state.
15. Confirm bookmarks and list are present.
16. Confirm account settings follow account-wins semantics.
17. Open a second authenticated browser context/device.
18. Pull/synchronise.
19. Confirm the second context shows the merged progress and collections.

### Additional E2E cases

* Re-running the merge changes nothing.
* Login with no guest data shows no merge prompt.
* “Not now” uploads nothing.
* “Not now” followed by sign-out preserves guest data.
* Deferred merge can be started later.
* Merge survives a page reload during a retryable stage.
* `SYNC_ENABLED=false` fails safely without deleting guest data.
* Mobile 320px journey.
* Keyboard-only journey.
* Axe scans for consent, progress, success, error and dark-mode states.
* No horizontal scroll.
* No token-bearing auth URLs in Playwright traces or uploaded reports.

This phase must discharge the previously deferred authenticated multi-context online-sync E2E for the merged journey. Do not defer the second-device proof again.

---

## 27. CI and quality gate

Update CI and `scripts/quality-gate.ps1` where required so both run:

* Full migration chain including the Phase 17 migration.
* Content registration.
* Existing database constraints.
* Existing auth integration suites.
* Existing Phase 16 sync integration suites.
* New guest-merge integration suites.
* Typecheck.
* Lint.
* Format check.
* Unit/component tests.
* Production build.
* All Playwright configurations including Phase 17.

Keep CI and the local quality gate equivalent.

Do not silently skip E2E because it is slow. The full E2E gate must pass before final review and PR creation.

---

## 28. Documentation updates

Update the as-built documentation:

```text
docs/phases/phases-17.md
docs/phases/IMPLEMENTATION_PHASES.md
docs/PRODUCT_REQUIREMENTS.md
docs/ARCHITECTURE.md
docs/DATA_MODEL.md
docs/OFFLINE_AND_SYNC.md
docs/TEST_STRATEGY.md
docs/DEPLOYMENT.md
docs/RISK_REGISTER.md
modules/sync/README.md
```

Document:

* Core MVP completion.
* Consent behaviour.
* Import protocol.
* Idempotency model.
* Merge-specific union replay.
* Difference between identity merge and Phase 19 device-conflict resolution.
* Dexie schema version and key migration.
* Scoped logout semantics.
* Bookmark/list/settings merge rules.
* Post-merge rebase.
* Failure/retry behaviour.
* Migration and rollback.
* Remaining deferred Phase 18/19 guarantees.

Create an ADR if the owner-key migration or merge-specific multi-root replay constitutes a durable architectural decision not adequately captured by existing ADRs.

Run:

```text
pnpm docs:verify
```

if any Arabic-placeholder-bearing documentation is touched.

Never manually type source Arabic that is meant to match the dataset.

---

## 29. Performance and boundedness

The merge must remain bounded:

* Strict request size limits.
* Existing per-kind sync limits respected.
* Chunk large histories.
* Do not load an unlimited account history into browser memory unnecessarily.
* Avoid N+1 queries per attempt/event where the existing ingestion path can batch.
* Serialize conflicting imports per account/import key with an advisory lock or equivalent.
* Do not hold a database transaction open across network requests.
* Do not perform a full database replay for unrelated account components.
* Rebuild only affected component projections.
* Keep progress UI responsive while preparing a snapshot.
* Allow cancellation before server mutation begins.
* Once mutation begins, cancellation must not produce false rollback claims.

Add a test with a snapshot larger than one network batch.

---

## 30. Security and privacy review checklist

Before completion verify:

* No automatic guest upload.
* No client-trusted ownership.
* No client-trusted grading.
* No client-accessible merge-mode bypass.
* No cross-account import.
* No cross-account list-id enumeration.
* No raw payloads in logs.
* No Arabic answers copied into audit logs.
* No secrets/auth tokens in IndexedDB merge metadata.
* No guest data deleted before durable completion.
* No account data exposed after logout.
* No guest data lost merely because the user deferred.
* Strict Zod request schemas.
* Bounded arrays and strings.
* Safe generic errors.
* Audit entries use allow-listed metadata only.
* Original immutable vocabulary JSON is untouched.

---

## 31. Acceptance criteria

Phase 17 is complete only when all of the following are true:

1. Guest data is never uploaded without explicit consent.
2. A guest can defer and retain their data.
3. Guest and account local rows can coexist without primary-key replacement.
4. Logout/account switching preserves deferred guest rows while protecting account privacy.
5. Guest attempts and events are validated by the existing server-authoritative pipeline.
6. Original ids and historical metadata are preserved.
7. Guest/account scheduling state is produced by deterministic replay of the accepted union.
8. Bookmark union is correct.
9. List-name dedupe and membership union are correct.
10. Account settings win and guest settings fill only genuine gaps.
11. `guest_imports` makes exact resubmission a no-op.
12. Same import key with different content fails safely.
13. Local re-key/rebase is recoverable after interruption.
14. The dashboard after merge is identical or better than the guest dashboard.
15. A second signed-in context sees the merged authoritative state.
16. All Core MVP criteria in `PRODUCT_REQUIREMENTS.md` that do not require Phase 18 offline capability are green.
17. Existing guest, auth, sync, study, analytics and collection tests remain green.
18. Nothing under `data/` changes.
19. The full quality gate exits 0.
20. The full-phase reviewer council approves the exact final bytes.
21. A draft PR is created.
22. The PR is not merged automatically.

---

## 32. Demonstration

Demonstrate the complete journey:

```text
guest studies
→ guest gains progress/bookmarks/list/settings
→ guest registers and verifies
→ merge consent appears
→ learner consents
→ server validates and replays the union
→ local state re-keys and rebases
→ summary appears
→ dashboard and collections remain correct
→ second browser context signs in
→ second context pulls the merged state
```

Also demonstrate:

* Re-running the merge is a no-op.
* Deferring preserves guest data.
* Sign-out after deferring returns to intact guest progress.
* A tampered guest correctness claim is corrected or rejected server-side.
* GitHub Actions is green.

---

## 33. Implementation workflow

Use small, coherent implementation slices.

A sensible order is:

1. Repository discovery and written design.
2. Pure owner-key and merge-domain contracts.
3. Dexie data-moving migration.
4. Owner-scoped persistence and logout cleanup.
5. Guest snapshot/import metadata.
6. Server merge protocol.
7. Import idempotency migration.
8. Merge-specific validated history union and replay.
9. Bookmark/list/settings merge.
10. Client upload/finalisation orchestration.
11. Consent and summary UI.
12. Unit/component tests.
13. Integration tests.
14. E2E and second-context proof.
15. Documentation, migration notes and risk updates.
16. Full quality gate.
17. Full-phase review.
18. Fix/retest/re-review until approved.
19. Draft PR.

Each commit must be independently coherent and reviewed through the
repository’s `/run-phase` process: the mandatory `commit-reviewer` plus
whichever specialists the deterministic risk router selects per commit, and
the full council (`functionality-`, `testing-`, `clean-code-` plus the
risk-routed `security-`/`architecture-`/`reliability-reviewer`, consolidated
by `council-chair`) for the final integrated phase review.

Do not bypass the council because the phase is large.

Any production-code correction after review invalidates the previous approval and requires another full gate and review.

---

## 34. Final verification

Run the full repository quality gate without skipping E2E:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/quality-gate.ps1
```

Also inspect:

```powershell
git status --short
git diff --stat origin/main...HEAD
git diff --name-only origin/main...HEAD
git log --oneline origin/main..HEAD
```

Confirm:

* All expected files are committed.
* No generated artifacts are stale.
* No unrelated files are modified.
* No data files changed.
* Migration and rollback are committed.
* The exact reviewed tree is the tree pushed.
* CI is green.

---

## 35. Draft pull request

After the full quality gate passes and the full-phase reviewer approves, create a **draft** PR targeting `main`.

Suggested title:

```text
Phase 17 — Guest-to-account merge and Core MVP
```

The PR body must include:

* Objective and Core MVP milestone.
* Summary of consent UX.
* Merge API/protocol.
* Server-authoritative validation.
* Guest/account union replay policy.
* Dexie migration and owner-key design.
* Scoped logout changes.
* Bookmark/list/settings semantics.
* Idempotency guarantees.
* Test evidence and exact counts.
* E2E second-device demonstration.
* Migration and rollback notes.
* Security considerations.
* Known limitations.
* Remaining Phase 18/19 deferrals.
* Review history and resolved findings.
* Manual verification instructions.

Do not mark the PR ready for review unless the repository workflow explicitly requires it.

Do not merge it.

The human reviews and merges manually.

---

# As built

Phase 17 is implemented and the Core MVP is complete. The sections above are
the specification; this records where the work landed and the places the
as-built answer differs from, or is narrower than, the sketch.

## Where it lives

| Concern                          | Code                                                                    |
| -------------------------------- | ----------------------------------------------------------------------- |
| Wire contract                    | `modules/sync/protocol/*` (shared verbatim by both sides)                |
| Endpoint + coordinator           | `app/api/sync/guest-merge`, `modules/sync/server/guest-merge.ts`         |
| Ingestion                        | reuses `modules/sync/server/ingest.ts` — the same pipeline as push       |
| Client flow                      | `modules/sync/client/guest-merge-{machine,chunking,api,upload,finalise}` |
| Learner-facing text and surface  | `modules/sync/client/guest-merge-{copy,surface}.ts` (pure, tested)       |
| UI                               | `components/sync/guest-merge-{provider,dialog}.tsx`, `components/settings/data-settings.tsx` |
| Owner-keyed local state          | `modules/content/owner-key.ts`, `modules/content/owner-scope.ts`, Dexie v7–v9 |
| Scoped departure                 | `modules/sync/client/logout.ts`, `components/account/*`                  |
| Tests                            | `tests/integration/guest-merge-*`, `modules/sync/client/guest-merge-*.test.ts`, `e2e/guest-merge.spec.ts` |

Architecture: **ADR-009**. Data flow: `docs/DATA_MODEL.md` §4.1, §9.2, §10.
Model: `docs/OFFLINE_AND_SYNC.md` §7 and its as-built section.

## Decisions worth knowing about

- **The chunk's unit is an attempt plus every event grading against it**, not a
  count of rows. Ingest resolves an event's attempt within the request that
  carries it, so splitting that pair across two requests makes the second one
  refuse a perfectly valid event as malformed. The planner packs indivisible
  units for that reason, and a legal snapshot is never refused for arithmetic.
- **The multi-root exemption is conditional on stored provenance**, never on
  inference — both the component's `merged_at`/`merged_from_guest_import_id`
  and each extra root's `imported_from_guest_import_id` (§4.1). This was the
  alternative to rewriting the guest's events to descend from the account's
  chain, which would have invented causality that did not happen.
- **The owner had to become part of the local primary key**, not merely an
  indexed column. IndexedDB cannot index `null` and a compound key containing
  `null` is not a key, so `userId` could not be promoted directly; the answer is
  a total `ownerKey` string, branded so a raw user id cannot stand in for one.
- **Account deletion is authorised by a one-time nonce**, not by a marker in a
  URL and not by "nobody is signed in". Two weaker designs were built and
  rejected during review: a constant marker is something anyone can append to a
  link, and a session ends for reasons that are not deletion (this app revokes
  every session on a password reset). The nonce rides inside the callback URL
  Better Auth stores against the deletion token, so it is evidence of the
  deletion itself.
- **A failed merge keeps everything.** Local rows are dropped only after the
  account's copy is durable, and every failure path returns before that point.
  A retry is a distinct action from a fresh consent, because part of the import
  may already be durable and the learner already agreed once.

## Known limits, stated rather than papered over

- The pending-deletion nonce lives on the device that **requested** the
  deletion. Requesting on a laptop and confirming from a phone leaves the
  laptop's rows until that laptop next signs out (RISK_REGISTER #26).
- A **full page load** re-asks the merge question: the deferral is remembered
  for the visit, not persisted. Declining again is free, and the Settings entry
  point carries the offer within a visit.
- The §24 content-boundary cases — an unsupported generator version, an unknown
  release and a **revoked** one — are now proven **on the merge path** in
  `tests/integration/guest-merge-end-to-end.test.ts`, not only in the unit tests
  for the shared layers that decide them (`modules/sync/server/grade.test.ts`,
  `modules/sync/server/release.test.ts`). The earlier claim that merge-side
  tests would be redundant was wrong: the checks are shared, but the summary the
  coordinator stores, the reason code the client is told and the rows the import
  leaves behind are not. Proving it required forwarding the merge's existing
  test-only `registryDir` override into `ingestSchedulingBatch` — it already
  reached the bookmark and list merges — and it surfaced a real defect in the
  shared pipeline: a revoked release was reported as `revoked_release` only for
  the item its component group's context was resolved from, and as
  `invalid_release` for every later item. Fixed in
  `modules/sync/server/ingest.ts`, where the per-batch cache now carries the
  reason code alongside the context so there is one resolution path rather than
  three. Because that code is shared with the Phase 16 push, the same boundary
  is now proven from the **push** entry point too
  (`tests/integration/sync-ingest.test.ts` §8.3), including that an item is
  judged by its own release whatever position it holds in its component group.

## Deliberately not done here

Phase 18's durable offline queue and PWA; Phase 19's concurrent multi-device
conflict resolution — whose resolver must **not** reuse the merge's multi-root
exemption (RISK_REGISTER #25); Phase 20's resets; and the background purge of
expired pending-parent rows (RISK_REGISTER #21).
