# Phase 14 — Bookmarks and Custom Lists

Implement **Phase 14 — Bookmarks & custom lists** for Safwa.

Use the established `/phase-loop` workflow:

```text
/phase-loop Phase 14 — Bookmarks and custom lists. Implement exactly the Phase 14 requirements in docs/phases/IMPLEMENTATION_PHASES.md. Add durable local bookmarks, custom-list CRUD, collection management, session-result curation and study-from-bookmarks/list integration through the existing Custom Session architecture. Do not begin Phase 15.
```

Work only on Phase 14.

Do not begin authentication, PostgreSQL, Drizzle, server APIs, sync or Phase 15.

---

## 1. Required branch

Create:

```text
phase/14-bookmarks-custom-lists
```

from the latest merged `origin/main`.

Before implementation, verify that `main` contains the merged Phase 13 work:

```text
Phase 13: Weak Areas and Targeted Practice
```

Phase 12 and Phase 13 must both already be merged.

Do not implement Phase 14 from an older Phase 11, Phase 12 or Phase 13 branch.

---

## 2. Read the current repository first

Read:

```text
CLAUDE.md
README.md

docs/PRODUCT_REQUIREMENTS.md
docs/ARCHITECTURE.md
docs/DATA_MODEL.md
docs/TEST_STRATEGY.md
docs/RISK_REGISTER.md

docs/phases/IMPLEMENTATION_PHASES.md
docs/phases/phases-12.md
docs/phases/phases-13.md

docs/adr/003-versioned-content-releases.md
docs/adr/004-study-component-granularity.md
```

Inspect the current implementation, especially:

```text
app/(shell)/library/page.tsx
app/(shell)/library/[id]/page.tsx
app/(shell)/study/custom/page.tsx

components/library/library-page-client.tsx
components/library/virtualised-entry-list.tsx
components/library/vocabulary-entry-card.tsx
components/library/vocabulary-detail.tsx

components/study/custom-session.tsx
components/study/quiz-runner.tsx
components/study/flashcard-session.tsx
components/study/weak-drill-session.tsx

components/content/use-active-content.ts
components/register-prompt.tsx

modules/content/db.ts
modules/content/schema.ts
modules/profile/export.ts
modules/profile/persistence.ts
modules/profile/device.ts

modules/study-session/custom.ts
modules/study-session/persistence.ts
modules/study-session/quizzes.ts
modules/study-session/weak-drill.ts

modules/analytics/persistence.ts
modules/analytics/weakness-persistence.ts

lib/uuid.ts
lib/with-timeout.ts

e2e/helpers/idb.ts
e2e/library.spec.ts
e2e/custom-session.spec.ts
e2e/weak-areas.spec.ts

tests/content/db-migration.test.ts
tests/profile/export.test.ts
tests/components/library.test.tsx
tests/components/custom-session.test.tsx
```

Search the repository for:

```text
BookmarkRecord
CustomListRecord
db.bookmarks
db.lists
entryIds
custom-bookmarks-placeholder
Bookmarking will become available
summary-entries
mc-results
session-summary
ensureDurableGuestState
buildExportPayload
```

Follow the current source code where it differs from the original planning baseline.

---

## 3. Preflight

Run:

```powershell
git status --porcelain
git branch --show-current
git fetch origin
git log --oneline -15 origin/main

node --version
pnpm --version
python --version

pnpm install --frozen-lockfile

powershell -ExecutionPolicy Bypass -File scripts/quality-gate.ps1
```

Confirm:

* The working tree is clean.
* The branch was created from the latest `origin/main`.
* Phase 13 is merged.
* All Phase 0–13 tests pass before editing.
* Dashboard, Progress, Weak Areas and weak drills remain green.
* Generated content artifacts are current.
* Nothing under `data/` has changed.

Stop and report rather than stashing, resetting or discarding user changes.

---

## 4. Phase objective

Give guest learners a durable local way to curate vocabulary.

Phase 14 must deliver:

* Bookmark toggles in:

  * The vocabulary library
  * Vocabulary detail pages
  * Quiz session results
  * Flashcard session results
* A Saved Vocabulary area
* Custom-list creation
* Custom-list rename
* Custom-list deletion
* Adding entries to lists
* Removing entries from lists
* Viewing bookmarked entries
* Viewing the entries in a custom list
* Launching study restricted to bookmarks
* Launching study restricted to a custom list
* Bookmark/list filters in Custom Session
* Persistence across reload and browser restart
* Data-export coverage
* Responsive and accessible desktop/mobile behaviour

Everything remains local in Dexie.

---

## 5. Non-goals

Do not implement:

* Authentication
* PostgreSQL
* Drizzle
* Server collection APIs
* Cross-device collection sync
* Mutation-queue writes for collections
* Guest-to-account merge
* Collaboration or shared lists
* Public lists
* Importing lists from files
* Reordering list entries manually
* Folders or nested lists
* Tags
* Notes attached to bookmarks
* Bookmark reminders
* Collection analytics
* Smart or automatically generated lists
* Weak-area auto-lists
* PWA work
* Phase 15

Do not change vocabulary content or eligibility.

Do not add collection data to the learner content release.

---

## 6. Existing persistence contract

The current Dexie schema already contains:

```ts
type BookmarkRecord = {
  entryId: number;
  createdAt: number;
};

type CustomListRecord = {
  id: string;
  name: string;
  entryIds: number[];
  createdAt: number;
  updatedAt: number;
};
```

Use these existing stores:

```text
bookmarks
lists
```

### Preferred database decision

Do not bump `SAFWA_DB_VERSION`.

Do not create a new object store.

Do not split local membership into a separate store during this phase.

The current dataset has only 455 entries, so the existing `entryIds` array is sufficient and keeps the already-shipped local/export contract stable.

A schema migration is permitted only when a demonstrable correctness requirement cannot be met with the current stores. Do not add one merely to imitate the future PostgreSQL representation.

### Canonical local list representation

Every persisted list must have:

* A stable ID
* A valid display name
* Sorted, unique numeric `entryIds`
* Valid finite integer timestamps
* `updatedAt >= createdAt`

Membership arrays should be canonicalised before every write:

```text
deduplicate
sort numerically
reject invalid IDs
```

Do not rely on insertion order for identity or equality.

### Future server compatibility

Keep stable list IDs so Phase 16 can later map:

```text
CustomListRecord
```

to:

```text
custom_lists
custom_list_entries
```

Do not implement that mapping or sync now.

---

## 7. Collections architecture

Create a dedicated collections module.

Suggested structure:

```text
modules/
  collections/
    bookmarks.ts
    lists.ts
    validation.ts
    persistence.ts
    filters.ts
    index.ts
```

Suggested hooks/components:

```text
components/
  collections/
    use-collections.ts
    bookmark-toggle.tsx
    add-to-list-dialog.tsx
    create-list-dialog.tsx
    rename-list-dialog.tsx
    delete-list-dialog.tsx
    saved-vocabulary-client.tsx
    bookmarks-section.tsx
    custom-lists-section.tsx
    custom-list-card.tsx
    custom-list-detail.tsx
    collection-entry-row.tsx
```

Exact filenames may differ, but maintain these boundaries:

* Validation and canonicalisation are pure TypeScript.
* Dexie reads/writes belong in one persistence adapter.
* React components do not construct raw records independently.
* Session filter logic remains pure.
* UUID and timestamps are injected into pure record constructors.

---

## 8. Pure collection rules

### 8.1 Bookmark identity

A bookmark is identified only by:

```text
entryId
```

Bookmark writes must validate that the entry exists in the active verified learner release.

Do not identify bookmarks by:

* Arabic surface form
* Meaning
* Component key
* Array position
* Content index

Protected duplicate-māḍī entries remain separate because their stable entry IDs differ.

### 8.2 Custom-list IDs

Create list IDs with the existing UUIDv7 helper.

Do not use:

* The list name as the primary key
* Array indexes
* `Math.random()`
* A timestamp alone

Inject ID generation in unit tests.

### 8.3 List names

Define explicit constants, for example:

```text
Minimum length: 1 non-whitespace character
Maximum length: 60 characters
Maximum lists: 50
```

Normalise names for validation and duplicate detection:

1. Unicode NFC
2. Trim leading/trailing whitespace
3. Collapse internal whitespace runs to one ordinary space
4. Case-insensitive comparison for uniqueness

Preserve the cleaned display casing entered by the learner.

Examples that must conflict:

```text
Difficult Verbs
 difficult   verbs
DIFFICULT VERBS
```

Do not use locale-dependent ambient comparison that could differ across browsers.

A rename may retain the same list’s current normalised name.

### 8.4 Membership

A custom list may contain each entry at most once.

Adding an existing entry is idempotent.

Removing a missing entry is idempotent.

The maximum membership is the current verified learner release’s entry count.

Do not write unknown or invalid entry IDs.

### 8.5 Unknown persisted IDs

A previously stored bookmark/list entry ID that is absent from the active release must:

* Be excluded from learner-facing views
* Be excluded from study plans
* Not crash rendering
* Remain in the raw export unless the learner explicitly removes it

Do not silently destroy user data merely because the active content release cannot currently resolve it.

---

## 9. Persistence adapter

Implement cohesive operations such as:

```ts
readCollections(db)
isBookmarked(db, entryId)
setBookmarked(db, entryId, bookmarked, now)
toggleBookmark(db, entryId, now)

createList(db, input)
createListWithEntry(db, input)
renameList(db, listId, name, now)
deleteList(db, listId)
addEntryToList(db, listId, entryId, now)
removeEntryFromList(db, listId, entryId, now)
```

Exact API names may differ.

### Transaction requirements

Use Dexie transactions where multiple values must change atomically.

At minimum:

* Create-list-and-add-entry is one transaction.
* Rename validates uniqueness and writes atomically.
* Membership update reads the current row and writes the canonical row in one transaction.
* Delete removes exactly the selected list.

A failed write must not leave partially changed UI or data.

### Durable guest boundary

Every user-triggered collection write must call the existing durable guest-state boundary:

```text
ensureDurableGuestState
```

This includes:

* Add bookmark
* Remove bookmark
* Create list
* Rename list
* Delete list
* Add entry
* Remove entry

Start the durability request at the user action rather than waiting until after all other work finishes.

Do not call it merely because the Saved page was opened.

Passive reads must not mint a device profile.

### Mutation queue

Do not add collection changes to `mutation_queue` in Phase 14.

Online sync begins later.

---

## 10. Reads and UI synchronisation

Create one collections snapshot containing:

```ts
type CollectionsSnapshot = {
  bookmarks: BookmarkRecord[];
  lists: CustomListRecord[];
  bookmarkedEntryIds: ReadonlySet<number>;
  listsById: ReadonlyMap<string, CustomListRecord>;
};
```

Adapt to project conventions.

Requirements:

* Read bookmarks and lists in one consistent transaction.
* Use the existing bounded-read helper for reads that gate rendering.
* Do not query IndexedDB once per library card.
* Do not query IndexedDB once per session-result row.
* Do not instantiate one independent subscription per bookmark button.
* Keep one parent snapshot and pass state/actions down.
* Refresh after successful writes.
* Refresh when the page regains visibility.
* Provide a recoverable retry state.

A collections write must update every mounted consumer consistently.

A bookmark changed on the detail page should be reflected when returning to the library.

---

## 11. Race-safe writes

Rapid actions must not produce stale collection state.

Test and handle:

* Double-clicking a bookmark toggle
* Bookmarking while another collection write is pending
* Adding the same entry to one list twice
* Two rapid list membership changes
* Rename followed immediately by another rename
* Delete while a membership dialog is open
* A delayed earlier write resolving after a later intent

Use one of:

* Per-record mutation serialisation
* Explicit operation tokens
* Transactional re-read before writes
* Another cohesive race-safe strategy

Do not allow an older async result to overwrite a newer accepted UI state.

Disable or clearly mark the relevant control while its write is pending.

Avoid globally blocking all collection controls because one unrelated bookmark is saving.

---

## 12. Bookmark toggle component

Create a reusable bookmark control.

Requirements:

* Uses `aria-pressed`
* Has a visible focus state
* Has an accessible label that identifies the entry
* Communicates saved/unsaved state without colour alone
* Shows pending state
* Shows a user-safe write error
* Restores the previous visible state on failed writes
* Has at least an approximately 44×44px target
* Uses the existing restrained design system
* Does not manually type Arabic
* Does not expose the raw entry ID as its only learner-facing label

Suggested accessible labels:

```text
Save “to preserve”
Remove “to preserve” from bookmarks
```

An icon-only visual is acceptable only with a complete accessible name.

---

## 13. Library card integration

The existing library entry card is currently one large `<Link>`.

Do not place a bookmark `<button>` inside that link.

Nested interactive elements are invalid and produce unreliable keyboard and touch behaviour.

Restructure each card so it contains:

* A separate detail link covering the vocabulary information
* A sibling bookmark button
* No nested interactive controls
* Clear focus styles for both controls
* Existing entry metadata
* Existing duplicate-entry distinguishability
* Existing virtualisation compatibility

The bookmark button must not navigate to the detail page.

Clicking the vocabulary content must continue to navigate.

Preserve:

* Arabic display through `<ArabicText>`
* Result list semantics
* Virtualised measurement
* Stable entry keys
* Mobile wrapping
* Existing library search/filter/sort behaviour

### Library page action

Add an obvious route from the Library page to:

```text
/library/saved
```

Suggested text:

```text
Saved vocabulary
```

Do not add another primary bottom-navigation item unless the current navigation design clearly supports it without displacement.

---

## 14. Vocabulary detail integration

Replace the existing bookmark placeholder on the detail page.

The detail header or primary action area should contain:

* Bookmark toggle
* Add to list action
* Current membership summary when useful

Remove outdated copy claiming bookmarking is unavailable.

The “Add to list” action must open an accessible dialog where the learner can:

* See existing lists
* See which lists already contain the entry
* Add/remove the entry
* Create a new list and add the entry atomically

Do not repeat the whole detail page inside the dialog.

The existing progress placeholder should be updated only when Phase 12 already provides enough data to show actual progress safely. Do not add unrelated detail-page analytics as part of Phase 14.

---

## 15. Saved Vocabulary page

Create:

```text
/library/saved
```

Use a client page backed by the verified learner release and collections snapshot.

Suggested structure:

```text
Saved vocabulary
├── Bookmarks
│   ├── count
│   ├── Study bookmarks
│   └── bookmarked entries
└── Custom lists
    ├── Create list
    └── list cards
```

### Bookmarks section

Show:

* Number of resolvable bookmarks
* Empty state
* Study bookmarks action
* Bookmarked entries
* Remove-bookmark action
* Detail link
* Optional add-to-list action

Ordering should be explicit and deterministic.

A sensible default is:

```text
newest bookmark first
stable entry ID tie-break
```

Do not order by Arabic locale unless that is an explicit learner-selected choice.

### Custom-list section

Each list card should show:

* Name
* Entry count
* Last updated context
* Open list
* Study list
* Rename
* Delete

Do not show raw list IDs.

### Empty states

For no bookmarks:

```text
Save words from the Library or after a study session to find them here.
```

For no lists:

```text
Create a list to group vocabulary you want to practise together.
```

These are not errors.

---

## 16. Custom-list routes

Create a stable route such as:

```text
/library/saved/lists/[id]
```

Validate the route parameter against the current collections snapshot.

Unknown or deleted IDs show a safe not-found state.

The page should show:

* List name
* Entry count
* Rename action
* Delete action
* Study list action
* Entries in the list
* Remove-entry controls
* Add-entries action
* Link back to Saved Vocabulary

### Add entries

Provide a searchable entry selector using the verified learner release.

Requirements:

* Search by Arabic forms and base meaning using existing library search utilities where suitable
* Exclude entries already in the list, or visibly mark them as already added
* Allow multiple entries to be added efficiently
* Preserve exact entry IDs
* Do not duplicate the 455-entry content in local collection records
* Do not bypass existing content verification

A lightweight searchable dialog is sufficient.

Do not build a second full Library page.

---

## 17. List deletion

List deletion requires explicit confirmation naming the list.

Example:

```text
Delete “Revision week”?
```

Explain:

* The list will be deleted.
* Vocabulary progress is not affected.
* Bookmarks are not affected.
* Study attempts are not affected.

Deletion must never remove:

* Bookmark records
* Vocabulary data
* Study components
* Attempts
* Events
* Progress
* Other lists

After deletion:

* Close the dialog
* Navigate safely back when deleting from the list-detail route
* Remove it from Custom Session choices
* Make any stale direct route show not found
* Do not reuse the deleted ID

---

## 18. Session-result integration

Add bookmark controls to both:

* Shared MC/quiz results
* Flashcard session summary

### Unique entries

Show each distinct studied entry once.

Do not display duplicate rows because:

* Several components belonged to one entry
* An item was reinforced
* The same entry appeared multiple times

Preserve first-seen order or another explicit deterministic order.

### Result row

Each row may include:

* Base meaning
* Detail link
* Bookmark toggle
* Optional Add to list action

The Phase 14 scope requires the bookmark toggle.

Adding to a list from results is encouraged when it can reuse the same accessible dialog without complicating the session state.

### Test mode

Do not interfere with test-mode correctness withholding.

Bookmark/list controls appear on the completed results screen, never before hidden feedback is released.

### Undo

Undoing the last study attempt must not automatically undo a bookmark/list action.

Study history and curation are separate user actions.

---

## 19. Custom Session collection filters

Replace the current disabled:

```text
Bookmarks & lists
Coming soon
```

placeholder with working filters.

Extend the pure custom-session filter contract.

Suggested shape:

```ts
type CollectionFilter = {
  includeBookmarks: boolean;
  listIds: readonly string[];
};
```

An equivalent serialisable design is acceptable.

### Semantics

Collection selection is:

* Union within the collection axis
* Intersection with every other filter axis

Examples:

```text
Bookmarks selected
→ entries that are bookmarked

List A + List B selected
→ entries in List A OR List B

Bookmarks + List A selected
→ bookmarked entries OR entries in List A

Bookmarks + bāb X selected
→ bookmarked entries AND bāb X

List A + maṣdar + due selected
→ components from entries in List A
  AND matching maṣdar
  AND currently due
```

No collection selection means:

```text
all entries
```

An explicitly selected empty bookmark set or empty list means:

```text
no matching entries
```

and must use the existing empty-result guard.

Do not silently interpret an empty selected list as “all entries.”

### Pure filtering

The pure filter engine must receive prepared collection membership.

It must not import Dexie.

Conceptually:

```ts
type CollectionMembership = {
  bookmarkedEntryIds: ReadonlySet<number>;
  listEntryIdsById: ReadonlyMap<string, ReadonlySet<number>>;
};
```

Adapt to current pure-module conventions.

### Current-release validation

Only entry IDs in the active verified release may enter a session plan.

Stale collection IDs are ignored.

Eligibility remains enforced by:

```text
deriveAllComponents
```

Collection membership narrows an already valid component universe; it never creates a component.

### Study Again

Custom Session “Study again” must re-read:

* Scheduling state
* Weakness state
* Current clock
* Bookmarks
* Lists

A list edit made after the previous session must affect the next plan.

Do not reuse a stale collection snapshot indefinitely.

---

## 20. Direct study actions

From Saved Vocabulary:

```text
Study bookmarks
Study this list
```

should open the existing Custom Session setup with the relevant collection preselected.

Prefer URL presets such as:

```text
/study/custom?collection=bookmarks
/study/custom?list=<validated-list-id>
```

Exact URL design may differ.

Requirements:

* Parse and validate presets.
* Unknown list IDs fail safely.
* Presets populate the collection controls.
* Learner may still choose mode, direction, forms, count, timing and test mode.
* Do not automatically begin a session without showing the configured collection context unless the existing product pattern strongly supports it.
* Reload preserves the preset when URL-backed.
* Raw entry ID arrays never appear in the URL.
* Raw list content never appears in the URL.

A bookmarked-only session must be demonstrable with one additional Start action.

---

## 21. URL and navigation safety

Validate all collection URLs.

Allowed identifiers:

```text
bookmarks
validated stable list ID
```

Reject:

* Arbitrary JSON
* Comma-separated entry ID payloads
* Component keys
* Filesystem-like paths
* Unknown list IDs
* Empty IDs
* Overlong values

Use URL encoding for list IDs even when UUIDs are currently safe.

A deleted-list URL should not crash or start an unrestricted session.

---

## 22. Export-my-data

The existing export already includes:

```text
bookmarks
lists
```

Preserve export schema version 1 when the record shapes remain unchanged.

Add tests proving:

* Created bookmarks appear in export.
* Created lists appear in export.
* Canonical list membership appears.
* Rename appears.
* Removed entries disappear from list membership.
* Deleted lists disappear.
* Bookmarks remain after deleting a list.
* Content artifacts remain excluded.
* `daily_activity` remains excluded as a rebuildable cache.
* Export is internally consistent.

Do not add a second collection-export mechanism.

Do not include resolved Arabic or meaning strings in bookmark/list records.

---

## 23. Data integrity and release changes

Entry IDs are stable content identities.

Requirements:

* Bookmarks/lists resolve against the currently loaded release.
* Duplicate-māḍī entries remain distinct.
* A list can contain both members of a protected duplicate group.
* Removing one duplicate must not remove the other.
* Unknown IDs are hidden from current views and plans without destructive cleanup.
* No collection record stores copied Arabic.
* No collection record stores copied meanings.
* No collection record stores eligibility metadata.
* Content-release checksum rules remain untouched.

---

## 24. UI write-error behaviour

Every collection write must have an honest failure path.

For failed bookmark writes:

* Restore the previous visible state.
* Show a concise error.
* Keep retry possible.

For failed list create/rename/delete/membership writes:

* Keep the dialog open where appropriate.
* Preserve entered text.
* Show an error near the action.
* Do not claim success.
* Do not navigate away on failure.
* Avoid duplicate list creation when retrying.

Do not display raw Dexie errors or stack traces.

Suggested copy:

```text
Couldn’t update your saved vocabulary. Please try again.
```

---

## 25. Accessibility

Requirements:

* No button nested inside a link
* Bookmark buttons use `aria-pressed`
* Dialogs have titles and descriptions
* Dialog focus is trapped appropriately
* Focus returns to the invoking control on close
* Delete confirmation names the list
* Saving/error status uses appropriate live regions
* List actions have distinct accessible names
* Entry controls identify which vocabulary entry they affect
* Keyboard-only list creation and membership management works
* Touch targets are approximately 44×44px
* No meaning is conveyed through colour alone
* Empty states are announced as ordinary content, not errors
* Arabic remains inside `<ArabicText>`
* No global RTL changes
* No serious or critical axe violations
* Dark-mode contrast remains sufficient
* Reduced-motion behaviour remains safe
* 200% zoom remains usable
* No horizontal overflow at 320px

Perform and document a manual accessibility checklist for:

* Library bookmark control
* Detail-page Add to list dialog
* Saved Vocabulary page
* List deletion confirmation
* Custom Session collection filter
* Session-result bookmark controls

Do not claim an NVDA or VoiceOver pass unless it was actually performed.

---

## 26. Responsive design

### Mobile

At 320px:

* Card content and bookmark button do not overlap.
* Bookmark button remains reachable.
* Saved sections stack.
* List action menus or buttons wrap safely.
* Dialogs fit the viewport.
* Search results do not overflow.
* Long list names wrap or truncate accessibly.
* Custom Session collection choices remain usable.
* Bottom navigation is unobstructed.
* Session-result collection controls fit.

### Desktop

* Saved Vocabulary uses a restrained responsive layout.
* List management does not resemble an admin table.
* Vocabulary remains the visual focus.
* Actions are grouped consistently.
* Large whitespace and existing shell hierarchy are preserved.

---

## 27. Pure unit tests

Create tests under:

```text
tests/collections/
```

Test at least:

### Name validation

* Whitespace-only rejected
* Trimmed name accepted
* Internal whitespace collapsed
* NFC normalisation
* Maximum length
* Case-insensitive duplicate rejected
* Renaming to own equivalent name accepted
* Maximum-list policy

### Membership canonicalisation

* Numeric sorting
* Deduplication
* Invalid IDs rejected
* Unknown current-release IDs excluded from active membership
* Duplicate protected entries remain separate
* Removing missing membership is idempotent

### Record creation

* Injected UUID used
* Injected clock used
* Valid timestamps
* Stable deterministic result for fixed inputs

### Collection filters

* No selection keeps all eligible entries
* Bookmarks only
* One list
* Multiple lists use union semantics
* Bookmarks plus list use union semantics
* Collection plus bāb uses intersection
* Collection plus form uses intersection
* Collection plus state uses intersection
* Selected empty collection returns no entries
* Unknown selected list returns no entries or a safe invalid selection
* Stale entry IDs never produce components
* Eligibility remains enforced
* Input order does not affect the final eligible component set

---

## 28. Persistence tests

Use fake IndexedDB.

Test:

* Bookmark add
* Bookmark remove
* Bookmark idempotence
* Rapid bookmark operations
* Bookmark write failure
* Create list
* Create list with initial entry atomically
* Duplicate name rejection
* Rename list
* Rename collision
* Delete list
* Add entry
* Add duplicate entry
* Remove entry
* Remove missing entry
* Canonical membership after every write
* Unrelated bookmarks preserved
* Other lists preserved
* Durable guest-state boundary called
* Passive read does not mint a profile
* Read snapshot consistency
* Missing lists/bookmarks produce empty snapshot
* Unknown stored IDs handled safely
* Existing Phase 12/13 stores unchanged
* No mutation-queue row created
* No DB version change

Add a failure-injection test proving create-list-with-entry cannot persist only half the operation.

---

## 29. Existing database tests

Because no schema version change is expected, preserve:

```text
SAFWA_DB_VERSION = 3
```

Add or update tests proving:

* Fresh v3 database includes bookmarks and lists.
* Existing v1→v3 migration remains valid.
* Existing v2→v3 migration remains valid.
* Existing v3 data remains readable.
* Populated bookmark/list records survive database reopen.
* Content cache remains untouched.
* Study state remains untouched.
* `daily_activity` remains untouched.

Do not create a fake Phase 14 migration test when no migration exists.

---

## 30. Component tests

Add tests for:

* Bookmark toggle unsaved state
* Bookmark toggle saved state
* Accessible pressed state
* Pending state
* Failed-write rollback
* Library card has separate link and button
* Bookmark click does not navigate
* Detail bookmark state
* Add-to-list dialog
* Existing membership state
* Create list from entry
* Add/remove membership
* Saved Vocabulary empty states
* Bookmarked-entry list
* Custom-list cards
* Rename dialog
* Delete confirmation
* List detail
* Add-entry search
* Remove-entry action
* Custom Session bookmark filter
* Custom Session list filter
* Selected empty list guard
* Direct URL preset
* Deleted/invalid list preset
* MC results unique entries
* Flashcard results unique entries
* Session-result bookmark controls
* No raw list IDs exposed
* Loading/error/retry states

Avoid tests that only assert Tailwind classes.

---

## 31. Playwright E2E

Create a dedicated Phase 14 E2E suite.

### 31.1 Bookmark from Library

1. Open Library.
2. Bookmark one entry.
3. Confirm the button state.
4. Confirm no navigation occurred.
5. Reload.
6. Confirm the bookmark remains.
7. Open Saved Vocabulary.
8. Confirm the exact entry appears.

Use values from the loaded learner release.

### 31.2 Bookmark from detail

1. Open a detail page.
2. Bookmark the entry.
3. Navigate back to Library.
4. Confirm the library card reflects the bookmark.
5. Remove the bookmark.
6. Confirm Saved Vocabulary updates.

### 31.3 Protected duplicate entries

Bookmark both entries from one protected duplicate-māḍī group.

Confirm:

* Both appear separately.
* Removing one does not remove the other.
* Their distinct entry IDs/detail routes remain correct.

Do not manually type the Arabic values.

### 31.4 Create and manage list

1. Open an entry detail.
2. Choose Add to list.
3. Create a new list.
4. Confirm the entry is added atomically.
5. Open Saved Vocabulary.
6. Open the list.
7. Add another entry.
8. Rename the list.
9. Reload.
10. Confirm name and membership persist.
11. Remove one entry.
12. Confirm the other remains.

### 31.5 Delete list

1. Create a list with entries.
2. Bookmark one of those entries independently.
3. Delete the list through confirmation.
4. Confirm:

   * List is gone.
   * Bookmark remains.
   * Progress remains.
   * Direct deleted-list route is safe.
   * Custom Session no longer offers it.

### 31.6 Session-result bookmark

Complete:

* One MC session
* One flashcard session

From each result screen:

* Bookmark a studied entry.
* Confirm each distinct entry appears once.
* Confirm reinforcement does not create duplicate result rows.
* Confirm the bookmark appears on Saved Vocabulary.

### 31.7 Bookmarked-only Custom Session

1. Bookmark a known subset of entries.
2. Open Custom Session.
3. Select Bookmarks.
4. Start the session.
5. Inspect every question’s `data-entry-id`.
6. Confirm every entry is bookmarked.
7. Confirm at least one question is present.
8. Confirm unbookmarked entries never appear.

### 31.8 List-only Custom Session

1. Create a list with a known subset.
2. Open Custom Session from “Study this list.”
3. Confirm the list is preselected.
4. Apply a mode/form filter.
5. Start.
6. Confirm every question belongs to the list and matches all other filters.

### 31.9 Collection union/intersection

Test:

```text
List A OR List B
```

within the collection axis, then:

```text
(List A OR List B) AND selected bāb
```

across axes.

Confirm exact set membership programmatically.

### 31.10 Selected empty collection

Select empty Bookmarks or an empty list.

Confirm:

* No unrestricted session starts.
* Empty-result guard appears.
* It suggests changing the collection filter.
* No question from outside the selected collection appears.

### 31.11 Study Again refresh

1. Start a list-filtered session.
2. Finish it.
3. Modify the list in another navigation flow or seeded transaction.
4. Use Study again.
5. Confirm the fresh plan reflects the current membership.

Do not require the active in-progress session to mutate when the list changes.

### 31.12 Export

Create bookmarks and lists, download Export My Data and confirm:

* Bookmarks are present.
* Lists are present.
* Membership is canonical.
* No content artifact is embedded.
* No `daily_activity` cache is embedded.

### 31.13 Browser restart persistence

Use a persistent Playwright context where supported.

Confirm bookmarks and lists survive the same restart mechanism used by existing guest-persistence tests.

### 31.14 Mobile

At 320px:

1. Bookmark from Library.
2. Open Saved Vocabulary.
3. Create a list.
4. Add an entry.
5. Start a list session.
6. Bookmark from results.

Confirm no horizontal overflow and all actions remain reachable.

### 31.15 Accessibility

Run axe on:

* Library with bookmark controls
* Detail page with collection actions
* Empty Saved Vocabulary
* Populated Saved Vocabulary
* Custom-list detail
* Add-to-list dialog
* Delete confirmation
* Custom Session collections filter
* Session results
* Mobile Saved Vocabulary
* Dark-mode Saved Vocabulary

Fail on serious or critical violations.

---

## 32. Existing behaviour preservation

All existing Phase 0–13 guarantees must remain green:

* Content verification
* Arabic integrity
* Library search/filter/sort
* Virtualisation
* Duplicate-entry safety
* Detail pages
* Guest identity
* Export
* Study engine
* FSRS
* Flashcards
* MC quizzes
* Timed/test modes
* Bāb/root quizzes
* Mixed revision
* Custom Session filters
* Hints
* Dashboard
* Progress formulas
* Timezone immutability
* Daily targets
* Weakness v2
* Weak-area groups
* Weak drills
* Mobile navigation
* Accessibility

Do not weaken an existing test to accommodate collections.

---

## 33. Performance

Requirements:

* One collection snapshot per relevant page/session setup.
* No IndexedDB query per virtualised card.
* No IndexedDB query per results row.
* Canonicalise membership once per write.
* Use sets/maps for membership checks.
* Avoid repeated `Array.includes` scans inside component-universe loops where prepared sets can be used.
* Do not derive all components separately for every collection control.
* Preserve current active-content load coalescing.
* Do not duplicate the learner release in local collection records.
* Do not add a global state library.

The current maximum of 455 entries makes in-memory membership sets appropriate.

---

## 34. Privacy and safety

Do not render or log:

```text
device IDs
component keys
attempt IDs
review-event IDs
question seeds
answer references
sync statuses
release checksums
raw IndexedDB errors
```

Custom list names are user-provided local text.

Render them as ordinary React text.

Do not use:

```text
dangerouslySetInnerHTML
```

Do not transmit list names or memberships off-device.

Do not add telemetry.

---

## 35. Documentation

Update relevant documentation to record:

* Local bookmark identity
* Local custom-list representation
* Name normalisation and uniqueness
* Membership canonicalisation
* Saved Vocabulary route
* Session-result bookmarking
* Custom Session collection-axis semantics
* Union within collection axis
* Intersection across filter axes
* Selected empty collection behaviour
* Study-again refresh behaviour
* Export preservation
* Durable guest-state writes
* Future server mapping without current sync
* No Dexie migration in Phase 14

Update only necessary sections of:

```text
docs/PRODUCT_REQUIREMENTS.md
docs/ARCHITECTURE.md
docs/DATA_MODEL.md
docs/TEST_STRATEGY.md
docs/phases/IMPLEMENTATION_PHASES.md
```

Create or update:

```text
docs/phases/phases-14.md
```

when the repository’s phase-document convention requires the implementation prompt to be retained.

Do not rewrite unrelated planning sections.

Do not hand-type Arabic values into documentation.

---

## 36. Quality gate

Run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/quality-gate.ps1
```

Also run:

```powershell
pnpm test:coverage

git diff --check
git status --short
```

The final gate must pass after the final correction cycle.

Verify:

* No generated content changes.
* Nothing under `data/` changed.
* Dexie remains schema v3.
* Export schema remains version 1.
* No server dependency was added.
* No sync work was added.
* No Phase 15 work was added.

---

## 37. Manual demonstration

Demonstrate:

1. Bookmark from the virtualised Library.
2. Confirm the card does not navigate when bookmarking.
3. Reload and show persistence.
4. Bookmark from a detail page.
5. Open Saved Vocabulary.
6. Create a list.
7. Create another list from an entry and add it atomically.
8. Add and remove entries.
9. Rename a list.
10. Delete a list with confirmation.
11. Show bookmarks survive list deletion.
12. Bookmark from MC results.
13. Bookmark from flashcard results.
14. Open Custom Session.
15. Select Bookmarks.
16. Run a bookmarked-only session.
17. Select a list.
18. Run a list-only session.
19. Combine a list with another filter.
20. Show selected empty-list guard.
21. Change membership and use Study again.
22. Export collections.
23. Show persistence after reload/restart.
24. Show protected duplicate entries remain distinct.
25. Show desktop layout.
26. Show 320px mobile layout.
27. Show dark mode.
28. Show keyboard-only operation.
29. Show axe results.
30. Confirm Dashboard, Progress and Weak Areas remain unchanged.

---

## 38. Acceptance criteria

Phase 14 is complete only when:

* Bookmark toggle works in Library.
* Library card contains no nested interactive controls.
* Bookmark toggle works on detail pages.
* Bookmark toggle works in MC results.
* Bookmark toggle works in flashcard results.
* Bookmark state persists.
* Saved Vocabulary page exists.
* Bookmarked entries can be viewed and removed.
* Lists can be created.
* List names are validated.
* Duplicate normalised names are rejected.
* Lists can be renamed.
* Lists can be deleted with confirmation.
* Entries can be added.
* Entries can be removed.
* Membership is sorted and unique.
* Create-list-with-entry is atomic.
* Unknown stored IDs do not crash or enter study.
* Protected duplicate entries remain distinct.
* Custom Session collection placeholder is removed.
* Bookmarks can filter Custom Session.
* Lists can filter Custom Session.
* Multiple selected collections use union semantics.
* Collections intersect with other filter axes.
* Explicitly selected empty collections produce no session.
* “Study bookmarks” opens a bookmarked context.
* “Study this list” opens the selected list context.
* URL presets are validated.
* Study Again refreshes collection membership.
* All study components still come through eligibility derivation.
* Collection writes trigger durable guest state.
* Passive reads do not create a profile.
* Export includes bookmarks/lists.
* `daily_activity` remains excluded from export.
* No Dexie migration was introduced unnecessarily.
* No mutation-queue writes were introduced.
* No server or sync code was added.
* Mobile and desktop layouts work.
* Axe has no serious or critical violations.
* Full Phase 0–14 quality gate passes.
* Claude reviewer approves the final bytes.
* Codex reviewer approves the final bytes.
* GitHub CI passes.
* No Phase 15 work is present.

---

## 39. Final inspection

Run:

```powershell
git status
git diff --stat
git diff --check
git diff
```

Confirm:

* No files under `data/` changed.
* No generated content artifact changed.
* No database-version bump.
* No export-schema bump.
* No copied Arabic or meanings in collection records.
* No nested button inside a Library link.
* No per-card IndexedDB reads.
* No stale collection snapshot used by Study Again.
* No unrestricted fallback from an empty selected list.
* No raw IDs in learner-facing UI.
* No server code.
* No sync code.
* No Phase 15 implementation.
* Only intentional Phase 14 changes remain.

---

## 40. Commit

Commit with:

```text
Phase 14: add bookmarks and custom lists
```

Push and open a draft PR through `/phase-loop`.

Do not merge automatically.

---

## 41. Final response

Provide:

1. Preflight results.
2. Base commit.
3. Files created and modified.
4. Collections module architecture.
5. Bookmark identity and validation.
6. Custom-list record contract.
7. Name normalisation.
8. Membership canonicalisation.
9. Race-safe write design.
10. Durable guest-state integration.
11. Collections snapshot design.
12. Library-card restructuring.
13. Detail-page integration.
14. Saved Vocabulary page structure.
15. Custom-list detail flow.
16. Create-list-with-entry transaction.
17. Rename behavior.
18. Delete behavior.
19. Session-result bookmark integration.
20. Distinct-entry result handling.
21. Custom Session collection filter shape.
22. Union/intersection semantics.
23. Empty selected-collection behavior.
24. Direct study URL design.
25. Study-again refresh behavior.
26. Export behavior.
27. Unknown/stale entry-ID behavior.
28. Protected duplicate-entry behavior.
29. Accessibility measures.
30. Mobile behavior.
31. Pure unit tests added.
32. Persistence tests added.
33. Component tests added.
34. E2E tests added.
35. Exact test counts.
36. Full quality-gate results.
37. Existing Phase 0–13 regression results.
38. Confirmation Dexie remains v3.
39. Confirmation export remains schema version 1.
40. Confirmation generated artifacts are unchanged.
41. Confirmation `data/` is unchanged.
42. Final git status.
43. Commit SHA.
44. Draft PR URL.
45. Reviewer outcomes and correction cycles.
46. Remaining concerns or deferred Phase 15 work.

Stop after Phase 14.

Do not begin Phase 15.
