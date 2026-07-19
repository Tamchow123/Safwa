# Phase 12 — Progress Dashboard and Streaks

Implement **Phase 12 — Progress dashboard & streaks 🏁 Guest Alpha** for Safwa.

Use the existing `/phase-loop` workflow so implementation, quality gates, Claude review, Codex review, corrections, commit, push and draft PR creation happen through the established automated process.

```text
/phase-loop Phase 12 — Progress dashboard and streaks. Implement exactly the Phase 12 requirements from docs/IMPLEMENTATION_PHASES.md and the authoritative progress formulas from docs/PRODUCT_REQUIREMENTS.md §5–6. This phase completes the Guest Alpha milestone. Do not begin Phase 13.
```

Work only on Phase 12.

Do not begin Phase 13, Phase 14 or any server/account work.

---

## 1. Required branch

Create the phase branch from the latest merged `origin/main`:

```text
phase/12-progress-dashboard-streaks
```

Before implementation, verify that `main` contains the merged Phase 11 work, including:

```text
Phase 11: custom session configuration
```

The branch must contain the latest Phase 10 prioritisation correction and Phase 11 custom-session implementation.

Do not work from an outdated branch.

---

## 2. Read the current repository first

Before editing anything, read:

```text
CLAUDE.md
README.md

docs/PRODUCT_REQUIREMENTS.md
docs/ARCHITECTURE.md
docs/DATA_MODEL.md
docs/IMPLEMENTATION_PHASES.md
docs/TEST_STRATEGY.md
docs/RISK_REGISTER.md

docs/adr/002-client-side-fsrs.md
docs/adr/003-versioned-content-releases.md
docs/adr/004-study-component-granularity.md
```

Read the current implementation, especially:

```text
app/(shell)/page.tsx
app/(shell)/progress/page.tsx
app/(shell)/settings/page.tsx

components/navigation/nav-items.ts
components/register-prompt.tsx
components/content/use-active-content.ts
components/settings/study-defaults-settings.tsx

lib/preferences/use-session-defaults.ts

modules/content/constants.ts
modules/content/db.ts
modules/content/schema.ts

modules/profile/settings.ts
modules/profile/session-defaults.ts
modules/profile/persistence.ts
modules/profile/device.ts

modules/study-engine/components.ts
modules/study-engine/attempts.ts
modules/study-engine/natural-key.ts

modules/scheduler/fsrs.ts
modules/scheduler/states.ts
modules/scheduler/due.ts
modules/scheduler/events.ts
modules/scheduler/chain.ts

modules/study-session/persistence.ts
modules/study-session/mixed.ts
modules/study-session/custom.ts

components/study/study-shared.tsx
components/study/quiz-runner.tsx
components/study/flashcard-session.tsx
components/study/mixed-session.tsx
components/study/custom-session.tsx

e2e/fixtures.ts
e2e/helpers/learner-release.ts
e2e/bab-root-mixed.spec.ts
e2e/custom-session.spec.ts
e2e/settings.spec.ts

package.json
playwright.config.ts
scripts/quality-gate.ps1
.github/workflows/ci.yml
```

Search the complete repository for:

```text
browserClock(
localDateAtEvent
timezoneAtEvent
timezoneSource
responseTimeMs
studyComponents
studyAttempts
reviewEvents
sessionDefaults
learnerState
isDue(
daily_activity
```

Do not assume the earlier planning baseline still reflects every implementation detail. Follow the current source code where it is stricter or more developed.

---

## 3. Preflight

Run:

```powershell
git status --porcelain
git branch --show-current
git fetch origin
git log --oneline -12 origin/main

node --version
pnpm --version
python --version

pnpm install --frozen-lockfile

powershell -ExecutionPolicy Bypass -File scripts/quality-gate.ps1
```

Confirm:

* Working tree is clean.
* Branch was created from the latest `origin/main`.
* Phase 11 is merged.
* All existing tests pass before editing.
* Generated content artifacts are current.
* Nothing under `data/` is modified.
* The active learner release still contains 455 entries.
* The existing Phase 8–11 study journeys remain green.

Stop and report rather than implementing on an outdated or dirty base.

---

## 4. Phase objective

Deliver honest, local-first progress visibility for a guest learner.

Phase 12 must provide:

* A useful Dashboard at `/`.
* A detailed Progress page at `/progress`.
* Overall word-mastery completion.
* Component mastery.
* Per-skill progress.
* Per-form progress.
* Words started, learning and mastered.
* Current study streak.
* Study time.
* Reviews due today.
* Daily new-item and review-target progress.
* A recent-activity trend chart.
* An IANA timezone setting.
* Immutable historical event dates.
* A rebuildable `daily_activity` Dexie cache.
* Responsive and accessible desktop/mobile presentation.
* An end-to-end guest journey proving the dashboard updates after study.

This phase completes **Guest Alpha**.

Guest Alpha does not mean Core MVP, account support, sync or offline PWA support.

---

## 5. Non-goals

Do not implement:

* Weak-area analysis or rankings — Phase 13
* Weak-area drill sessions — Phase 13
* Bookmarks or custom-list functionality — Phase 14
* Authentication
* PostgreSQL
* Drizzle
* Server APIs
* Cross-device sync
* Guest-to-account merge
* Service workers or PWA work
* Notifications
* Achievements or additional gamification
* Leaderboards
* Reset controls unless already required by an existing phase
* A full answer-history page
* User-editable content
* New vocabulary fields
* Generated English form translations
* Data migrations outside IndexedDB
* Any changes under `data/`
* Phase 13 work

Do not transmit analytics or learner data to an external service.

All Phase 12 analytics remain local.

---

## 6. Architecture

Create a dedicated analytics module:

```text
modules/
  analytics/
    progress.ts
    activity.ts
    streaks.ts
    dates.ts
    persistence.ts
    index.ts
```

Exact filenames may differ, but maintain these boundaries.

### Pure modules

The following must remain pure TypeScript:

```text
progress.ts
activity.ts
streaks.ts
dates.ts
```

They must have:

* No React imports
* No Dexie imports
* No DOM access
* No ambient `Date.now()`
* No ambient browser timezone reads
* Injected `nowMs`
* Explicit timezone inputs
* Deterministic output
* Exhaustive unit tests

### Persistence adapter

Dexie interaction belongs in:

```text
modules/analytics/persistence.ts
```

or an equivalently cohesive browser-only adapter.

The persistence adapter may:

* Read attempts, events and component state.
* Rebuild the derived daily-activity cache.
* Return one consistent analytics snapshot.

Do not import Dexie into the pure formulas.

### UI

Use shared, focused components such as:

```text
components/
  dashboard/
    dashboard-client.tsx
    overview-card.tsx
    mastery-overview.tsx
    word-state-summary.tsx
    streak-card.tsx
    study-time-card.tsx
    due-today-card.tsx
    daily-target-card.tsx
    activity-trend.tsx
    dashboard-loading.tsx
    dashboard-empty.tsx
    dashboard-error.tsx

  progress/
    progress-page-client.tsx
    component-mastery-section.tsx
    skill-progress-list.tsx
    form-progress-list.tsx
    course-group-progress.tsx

  settings/
    timezone-settings.tsx
```

Exact filenames may differ.

Do not create one enormous dashboard component containing the formulas, database reads and presentation.

---

## 7. Authoritative progress formulas

Implement the formulas in `PRODUCT_REQUIREMENTS.md §5–6` exactly.

All denominators come from the loaded learner release and the shared component derivation functions.

Never use the number of materialised Dexie rows as a denominator.

### 7.1 Eligible component universe

Use:

```text
deriveAllComponents(entries)
```

as the source of the eligible component universe.

The current release should derive:

```text
Total entries:              455
All eligible components:    6,793
Essential components:       2,717
```

Current expected per-skill denominators:

```text
meaning_recognition:        2,716
meaning_recall:             2,716
bab_identification:           455
root_identification:          453
verb_type_identification:     453
```

Current expected per-form denominators across recognition and recall:

```text
madi:       910
mudari:     908
masdar:     890
ism_fail:   908
amr:        908
nahi:       908
```

Derive these values at runtime.

Do not hardcode them into production formulas.

It is appropriate for tests to assert these expected counts against the current immutable release.

Entries 369 and 372 must remain excluded from root and verb-type denominators.

### 7.2 Effective component state

Stored `learnerState` may become stale as time passes.

For example, a component stored as `mastered` becomes `needs_review` when:

* Its FSRS card becomes due.
* Its card enters relearning.

Create or extract one shared pure helper for effective state at `nowMs`.

Prefer placing this in:

```text
modules/scheduler/states.ts
```

Conceptually:

```ts
effectiveLearnerState(
  storedState: LearnerState | undefined,
  card: SchedulerCard | null,
  nowMs: number,
): LearnerState
```

Use the same helper in:

* Dashboard analytics
* Progress analytics
* Phase 11 custom-session state filtering
* Any other current state consumer

Do not maintain two subtly different “effective state” implementations.

Requirements:

* No card → `not_started`
* Stored mastered + due → `needs_review`
* Stored mastered + relearning → `needs_review`
* Otherwise preserve the valid projection
* Missing/corrupt optional state fails safely
* A stale or ineligible stored component never enters analytics

### 7.3 Overall completion

```text
Numerator:
entries whose complete essential-component set is Mastered

Denominator:
455
```

An entry is mastered only when every eligible essential component is effectively mastered.

Essential components remain:

* Māḍī recognition
* Muḍāriʿ recognition when eligible
* Maṣdar recognition when eligible
* Māḍī recall
* Bāb identification
* Root identification when eligible

Extended components never block word mastery.

Do not infer word mastery from a row count or a single vocabulary attempt.

### 7.4 Component mastery

```text
Numerator:
effectively Mastered eligible components

Denominator:
all eligible components in the enabled skill set
```

There is no user-configurable enabled-skill set yet, so Phase 12 uses all currently derived skills.

Missing component rows count as not started.

### 7.5 Per-skill completion

For every current skill:

```text
Numerator:
effectively Mastered components of that skill

Denominator:
eligible derived components of that skill
```

Use learner-facing labels such as:

```text
Arabic → English recognition
English → Arabic recall
Bāb identification
Root identification
Verb-type identification
```

Do not show raw internal skill IDs as primary learner-facing labels.

### 7.6 Per-form completion

For each source form:

```text
Numerator:
effectively Mastered translation components using that source_field

Denominator:
eligible translation components using that source_field
```

Both directions count where eligible.

Use labels from the existing shared form metadata.

Do not create another form-label map.

### 7.7 Group completion

Provide a tested generic essential-component group calculation for:

* Bāb
* Eligible verb type
* Source grouping/book page

Formula:

```text
Numerator:
effectively Mastered essential components belonging to entries in the group

Denominator:
eligible essential components belonging to entries in the group
```

An ineligible verb type must not be used to classify entries into a verb-type progress group.

At minimum, test these formulas exhaustively.

A restrained Bāb/verb-type breakdown may be shown on `/progress`, but do not turn it into Phase 13 weak-area ranking.

### 7.8 Word-state counts

Expose:

```text
wordsStarted
wordsLearning
wordsMastered
wordsNotStarted
```

Definitions:

```text
Not started:
every essential component is effectively not_started

Mastered:
every essential component is effectively mastered

Learning:
at least one essential component has started,
but the entry is not mastered

Started:
inclusive count of every entry that is not Not started
```

Therefore:

```text
wordsStarted = wordsLearning + wordsMastered
```

A word containing a due or needs-review essential component is Learning, not Mastered.

Make this distinction explicit in code and tests.

### 7.9 Percentages

Keep exact integer numerators and denominators in analytics output.

Calculate presentation percentages separately.

Requirements:

* No denominator is silently replaced by one.
* A legitimate zero denominator renders safely as unavailable rather than `NaN`.
* Do not round the underlying values.
* Display rounding may use one decimal place.
* Progress bars should visually clamp to 0–100%, while text remains exact.

---

## 8. Activity derivation

Create a pure daily-activity derivation from raw attempts and review events.

Suggested record:

```ts
type DailyActivity = {
  localDate: string;
  attempts: number;
  reviews: number;
  newItems: number;
  studyMs: number;
};
```

### 8.1 Attempts

A valid local attempt requires:

* A stored full attempt payload.
* A valid immutable `localDateAtEvent`.
* A finite, non-negative `responseTimeMs`.
* A structurally usable attempt ID and component key.
* No evidence that the attempt was revoked or rejected.

Incorrect attempts count.

Hinted attempts count.

Reinforcement attempts count as study activity.

Do not count corrupted legacy rows that lack enough information for honest analytics.

### 8.2 Revoked/rejected attempts

Review events can identify an invalid or revoked scheduling attempt.

Exclude an attempt from activity/streak calculations when its linked event is:

```text
status = revoked
```

or has a rejected local sync lifecycle.

A `conflict_demoted` scheduling event must not count as a review/new-item scheduling event, but the learner’s underlying attempt may still count as study activity because the learning effort occurred.

Do not remove or mutate the attempt.

### 8.3 Attempt count

Count every valid submitted answer:

* Correct
* Incorrect
* Hinted
* Reinforcement
* Timed expiry
* Flashcard self-rating

### 8.4 Study time

Define Phase 12 study time honestly as:

```text
sum of valid attempt.responseTimeMs
```

This is active question-response time, not wall-clock time with the application open.

Document this in code and learner-facing explanatory copy where needed.

Include reinforcement time because it is genuine study activity.

Do not manufacture session-duration values from missing session-end timestamps.

Do not show second-level false precision.

Suggested formatting:

```text
under 1 minute
7 minutes
1 hr 24 min
```

### 8.5 New items and reviews

Use scheduling-authoritative events only:

```text
status === "scheduling"
```

Exclude:

* Reinforcement
* Conflict-demoted events
* Revoked events
* Pending-parent events
* Rejected events

Classify:

```text
parentEventId === null  → new item
parentEventId !== null  → review
```

This must agree with the existing Phase 10 daily-target accounting.

Prefer extracting/reusing one shared classification helper rather than duplicating the rules.

Undo must automatically refund the removed event after cache rebuild.

### 8.6 Immutable dates

Group activity using each attempt/event’s stored:

```text
localDateAtEvent
```

Never recalculate historical activity dates using the learner’s current timezone.

Timezone changes affect future attempts and events only.

---

## 9. Streak calculations

Create a pure streak module.

### 9.1 Study day

A study day is a stored local date containing at least one valid, non-revoked attempt.

Incorrect-only days count.

A difficult day must preserve the streak.

Review-event presence is not required because reinforcement attempts and some attempt types may not create scheduling events.

### 9.2 Current streak

Use the learner’s current effective local date only as the current-day anchor.

Recommended current-streak semantics:

* Activity today → count backwards from today.
* No activity today, but activity yesterday → retain the streak through today.
* No activity today or yesterday → current streak is zero.
* Duplicate attempts on one date count as one study day.
* Gaps break the streak.

Use calendar-date arithmetic over ISO `YYYY-MM-DD` strings.

Do not add or subtract 24-hour millisecond durations, because DST days are not always 24 hours.

A safe implementation may parse the date components and use UTC calendar arithmetic solely to move between date labels.

### 9.3 Longest streak

Calculate and expose `longestStreak` even if the main card emphasises the current streak.

It is useful for detailed progress and inexpensive to derive correctly.

### 9.4 Timezone changes

Tests must prove:

* Attempts retain their original stored local dates.
* A timezone change does not re-key historical daily activity.
* Consecutive stored dates remain consecutive even when their underlying offsets differ.
* DST changes do not break a date-based streak.
* A newly created event after a timezone change uses the new setting.

---

## 10. Timezone preference

Add a persistent timezone setting.

Suggested files:

```text
modules/profile/timezone.ts
lib/preferences/use-timezone.ts
components/settings/timezone-settings.tsx
```

### 10.1 Preference shape

Represent the distinction between browser-detected and explicit user choice.

For example:

```ts
type TimezonePreference =
  | { mode: "browser" }
  | { mode: "iana"; timezone: string };
```

Do not store an ambiguous empty string.

Add a settings key such as:

```text
timezone
```

to the existing typed settings keys.

### 10.2 Validation

Validate explicit zones using `Intl.DateTimeFormat` with the supplied `timeZone`.

Reject invalid IANA strings.

Stored invalid/corrupt values fall back safely to browser detection.

Do not accept arbitrary unvalidated strings merely because they came from IndexedDB.

### 10.3 Default

Default to:

```text
Browser timezone
```

Resolve the browser zone through:

```ts
Intl.DateTimeFormat().resolvedOptions().timeZone
```

Fallback to UTC only when the environment does not expose a usable zone.

### 10.4 Picker

Add an accessible timezone settings card.

Use:

```ts
Intl.supportedValuesOf?.("timeZone")
```

when available.

Provide a safe fallback containing at least:

* The currently detected zone when valid
* UTC

Requirements:

* Visible label
* Explanatory text
* Current browser timezone shown
* Browser-detected option
* IANA options
* Keyboard accessible
* Mobile usable
* Saving/error state
* Persist through the existing durable guest-setting path
* No network request
* No country/IP geolocation
* No timezone guessed from account location

A native `<select>` is acceptable and often preferable to a large custom combobox if implemented cleanly.

### 10.5 Event creation

Replace the current unconditional browser-detected clock path.

Create one shared effective clock resolver that returns:

```text
timezone
timezoneSource
now
```

Rules:

* Browser mode → detected zone + `browser_detected`
* Explicit IANA mode → selected zone + `user_setting`
* Safe fallback → UTC + appropriate safe source

All future attempts and review events must receive this clock.

Update every study path:

* Flashcards
* MC vocabulary
* Bāb quiz
* Root quiz
* Mixed revision
* Custom sessions
* Timed and test modes

Do not leave one runner using the old unconditional `browserClock()`.

### 10.6 Session consistency

Resolve and freeze the effective timezone for a mounted study session.

All events in that session use the same effective zone/source.

A settings change applies to sessions started after the change.

Do not rewrite an already-running session or previously stored event.

### 10.7 Dashboard date

Use the effective current timezone to derive:

* Current local date
* Yesterday
* Recent chart date range
* Current-streak anchor
* Daily-target row shown as today
* Due-today classification

Historical rows remain keyed by their stored dates.

---

## 11. Reviews due today

“Due today” must mean:

```text
eligible materialised components whose FSRS due instant
falls on or before the end of the current local calendar date
```

This includes overdue reviews.

A robust approach is:

1. Convert each `dueAtMs` instant into an ISO local date using the active timezone.
2. Count it when:

```text
dueLocalDate <= currentLocalDate
```

This avoids brittle assumptions that every local day lasts 24 hours.

Requirements:

* Only components still derivable from the loaded release count.
* Stale/ineligible stored component rows do not count.
* A future-day review does not count.
* An overdue review counts.
* A review later today counts.
* A missing FSRS card does not count.
* Current learner-state mastery calculations still use the exact current instant, not end-of-day.

The card should link to or clearly offer:

```text
Start studying
```

Do not create a new scheduler.

---

## 12. Daily-target progress

Use the existing Phase 11 session defaults:

```text
newPerDay
reviewsPerDay
```

Do not create duplicate target settings.

For the current local date, display:

```text
newItemsCompleted / newPerDay
reviewsCompleted / reviewsPerDay
```

Requirements:

* Counts come from scheduling events under the shared classification rule.
* Undo refunds progress.
* Reinforcement does not consume the target.
* Incorrect first attempts that produce scheduling events still consume the relevant target.
* Values may exceed the target through specific/manual modes.
* Text shows the real count.
* Visual bars may cap at 100%.
* A zero target renders as disabled/off, not division by zero.
* Changing the target changes the denominator only; it does not rewrite activity.

---

## 13. Recent activity trend

Show a recent activity chart over the latest 14 local calendar dates ending on the current date.

At minimum, visualise:

* Attempts per day

Optionally also allow:

* Study time
* New items
* Reviews

Keep the initial chart focused and readable.

### Chart implementation

Do not add a large chart dependency for this phase.

Prefer:

* Accessible semantic HTML
* CSS bars
* A small hand-authored SVG only when necessary
* A tabular/screen-reader summary

Requirements:

* Every bar has a programmatic date and value.
* Zero-activity dates remain represented.
* Tooltips are not the only way to access values.
* Keyboard access is not required for non-interactive bars, but values must be available to assistive technology.
* Avoid colour alone as the only differentiator.
* Dark mode works.
* Reduced motion disables chart animation.
* No horizontal overflow at 320px.
* Dates use learner-readable formatting while retaining exact ISO values in test attributes.

Do not use Arabic source strings in the chart.

---

## 14. Dexie `daily_activity` derived cache

Phase 12 introduces the documented derived cache.

### 14.1 Schema migration

Bump the Dexie schema additively:

```text
v1 → existing content cache
v2 → existing learner stores
v3 → daily_activity
```

Add:

```ts
type DailyActivityRecord = {
  localDate: string;
  attempts: number;
  reviews: number;
  newItems: number;
  studyMs: number;
  derivedAt: number;
};
```

Suggested store:

```text
daily_activity: "localDate"
```

Expose a typed table accessor.

Do not rename or recreate existing stores.

Do not alter existing primary keys or indexes.

### 14.2 Cache authority

`daily_activity` is a rebuildable derived cache.

The authoritative data remains:

* `study_attempts`
* `review_events`

The dashboard must never trust a stale or manually corrupted cache as learner truth.

### 14.3 Rebuild

Implement an atomic rebuild:

1. Read attempts and review events in one consistent read transaction.
2. Derive daily rows through the pure activity module.
3. In a write transaction:

   * Clear stale daily rows.
   * Write the complete newly derived set.
4. Return the derived snapshot.

A crash must not leave a partially rebuilt cache.

### 14.4 Refresh strategy

At minimum, rebuild or verify the cache when:

* Dashboard loads
* Progress page loads
* The page regains visibility after study in another route/tab
* The user activates an explicit retry/refresh action after an error

Navigating from a completed study session to the dashboard must show current values immediately.

A full incremental-maintenance system is not required.

Do not add one IndexedDB query per metric or per component.

### 14.5 Cache corruption

Tests must prove:

* Missing cache rows are rebuilt.
* Extra cache rows are removed.
* Incorrect counts are replaced.
* Undo is reflected after rebuild.
* The cache can be deleted without losing progress.
* Raw attempts/events remain unchanged during rebuild.

### 14.6 Migration

Test:

* Fresh v3 database creation.
* v1 → v3 preserves verified content cache.
* v2 → v3 preserves profile, settings, attempts, events, component state and other learner stores.
* Existing settings remain intact.
* No migration reads or rewrites Arabic content.

---

## 15. Analytics snapshot persistence adapter

Read the dashboard inputs in one consistent transaction where practical:

```text
study_components
study_attempts
review_events
daily_activity
settings
```

Suggested result:

```ts
type AnalyticsPersistenceSnapshot = {
  components: StoredComponentState[];
  attempts: AnalyticsAttempt[];
  events: AnalyticsEvent[];
  dailyActivity: DailyActivity[];
};
```

Do not query IndexedDB separately for every card or bar.

Do not expose Dexie record shapes directly to React components when a smaller analytics shape is sufficient.

Ignore stored components not present in the current release.

---

## 16. Dashboard route

Replace the placeholder at:

```text
/
```

The Dashboard should be an approachable summary rather than a dense analytics report.

Include:

* Page heading and concise explanation
* Existing `RegisterPrompt`
* Overall word completion
* Word counts
* Current streak
* Study time today
* Reviews due today
* Daily new target
* Daily review target
* Recent activity trend
* Clear “Start studying” action
* Link to detailed Progress page
* Loading state
* Genuine zero-progress state
* Recoverable error state
* Retry action

Suggested hierarchy:

```text
Dashboard
├── Primary progress overview
├── Today
│   ├── streak
│   ├── active study time
│   └── due today
├── Daily targets
├── Recent activity
└── View detailed progress
```

Do not display fake percentages or placeholder learner data.

A learner with no attempts should see a motivating but honest zero state.

---

## 17. Detailed Progress route

Replace the placeholder at:

```text
/progress
```

Show:

* Overall word completion
* Component mastery
* Words not started/started/learning/mastered
* Per-skill completion
* Per-form completion
* Current and longest streak
* Longer recent-activity summary
* Optional restrained Bāb/verb-type completion sections
* Exact numerator/denominator text
* Link to Study
* Loading/error/zero states

Do not show a raw answer-history table.

Do not implement Phase 13 weakness ranking.

If a weak-areas teaser remains, label it clearly as unavailable until a later phase and do not calculate pretend results.

---

## 18. Loading and error behaviour

### Loading

Use stable skeletons.

Avoid large layout shifts.

Announce loading accessibly.

### Empty progress

A brand-new learner should see:

```text
0 of 455 words mastered
0 components mastered
0-day streak
No activity yet
```

and a prominent study action.

This is not an error.

### Persistence/content error

Show a user-safe recoverable message and retry.

Do not show:

* Dexie object-store details
* Stack traces
* Raw exception messages
* Internal component keys
* Raw checksums
* Zod internals

Content continues to load through the verified Phase 3 loader.

---

## 19. Accessibility

Requirements:

* Correct heading hierarchy
* Semantic `<dl>` structures for summary statistics
* Progress bars have accessible names and exact values
* Use `aria-valuemin`, `aria-valuemax` and `aria-valuenow` where appropriate
* Do not use colour alone
* Trend values are available to screen readers
* Date labels are understandable
* Touch targets are at least approximately 44×44px
* Focus states remain visible
* Retry actions are keyboard accessible
* Timezone setting has a visible label
* Saving/error status is announced
* Dashboard updates use restrained `aria-live="polite"` regions
* No serious or critical axe violations
* Dark-mode contrast passes
* At 200% zoom, content remains usable
* At 320px, there is no horizontal overflow
* Reduced-motion users receive no decorative chart animation
* Arabic direction remains scoped to `<ArabicText>`; do not change global direction

Perform and document a manual screen-reader checklist for:

* Dashboard overview
* Progress bars
* Recent-activity chart
* Timezone picker

Do not claim an NVDA or VoiceOver pass unless it was actually performed.

---

## 20. Responsive design

### Mobile

At 320px:

* Summary cards stack cleanly.
* No metric truncates.
* Progress values wrap safely.
* Charts do not overflow.
* Bottom navigation remains unobstructed.
* Start-studying action is easy to reach.
* Timezone picker fits the viewport.
* Detailed progress sections remain readable.

### Desktop

* Use a restrained responsive grid.
* Avoid an admin-console appearance.
* Do not fill the screen with tiny KPI cards.
* Keep related metrics grouped.
* Maintain readable content width.
* Use whitespace and hierarchy consistently with the current application shell.

---

## 21. Pure analytics unit tests

Create comprehensive tests under:

```text
tests/analytics/
```

### 21.1 Denominator tests against the real release

Assert:

```text
455 entries
6,793 eligible components
2,717 essential components

2,716 meaning-recognition components
2,716 meaning-recall components
455 bāb components
453 root components
453 verb-type components

910 māḍī translation components
908 muḍāriʿ translation components
890 maṣdar translation components
908 ism-al-fāʿil translation components
908 amr translation components
908 nahy translation components
```

Load the generated learner release programmatically.

Do not hand-type Arabic.

### 21.2 Overall word mastery

Test:

* No materialised components → 0/455
* One mastered component does not master an entry
* Every essential component mastered → entry mastered
* Extended components do not block word mastery
* Missing optional root component for an ineligible entry does not block mastery
* Entry 369/372 essential denominator excludes root
* One due essential component removes word mastery
* One relearning essential component removes word mastery
* Component mastery can be high while word mastery remains lower
* Word mastery can differ from extended-component mastery

### 21.3 Word counts

Test exclusive and inclusive semantics:

```text
not started
started
learning
mastered
```

Assert:

```text
started = learning + mastered
```

### 21.4 Per-skill and per-form

Test exact numerators and denominators for seeded mixed states.

Test all five skills and all six source forms.

### 21.5 Groups

Test one fixture each for:

* Bāb
* Eligible verb type
* Book page/source grouping
* Ineligible verb-type exclusion

### 21.6 Effective state

Test:

* Stored mastered, not due
* Stored mastered, due
* Stored mastered, relearning
* Learning, not due
* Missing card
* Missing state
* Stale/ineligible stored component ignored

---

## 22. Activity and streak unit tests

Test:

* Correct attempt creates a study day.
* Incorrect-only day creates a study day.
* Hinted attempt counts.
* Reinforcement attempt counts toward attempts and study time.
* Reinforcement does not count toward new/review target progress.
* Timed expiry counts as an attempt.
* Revoked linked attempt is excluded.
* Rejected linked attempt is excluded.
* Conflict-demoted event does not consume a scheduling target.
* Conflict-demoted attempt still counts as study effort.
* Invalid legacy row is skipped safely.
* Study time sums finite valid response durations.
* Multiple attempts on one date create one streak day.
* Dates sort deterministically.
* Missing dates do not create activity.
* Undo/remove event refunds new or review progress after rebuild.
* Deleting an attempt removes its activity after rebuild.

### Streak fixtures

Test:

* Activity today
* Activity yesterday but not today
* Gap before yesterday
* Multiple consecutive dates
* Longest streak
* Duplicate date rows
* Leap day
* Month boundary
* Year boundary
* DST spring transition
* DST autumn transition
* Timezone change between events
* History remains keyed to original stored dates

Do not use 24-hour millisecond arithmetic for date succession.

---

## 23. Timezone tests

Test:

* Absent setting → browser detected.
* Explicit valid IANA setting → `user_setting`.
* Invalid stored setting → browser fallback.
* UTC is valid.
* Persistence uses the guest-durable settings path.
* The current browser zone appears in available choices.
* `Intl.supportedValuesOf` absence falls back safely.
* A session created after changing timezone uses the new zone.
* Existing attempt/event date fields remain unchanged.
* New attempt receives:

  * selected timezone
  * correct timezone source
  * correct local date
  * correct UTC offset
* DST offset differs correctly across seasonal instants.
* Every current study mode receives the effective clock.

Search-based tests should guard against future reintroduction of unconditional `browserClock()` usage in study paths.

---

## 24. Dexie and cache tests

Add tests for:

* Fresh schema v3.
* v1 → v3 migration.
* v2 → v3 migration.
* Content cache preserved.
* Learner stores preserved.
* Daily cache rebuild.
* Corrupt cache replacement.
* Extra-date removal.
* Empty cache reconstruction.
* Atomic rebuild failure.
* Raw source stores unchanged.
* Timezone setting survives migration.
* Session defaults survive migration.
* Export remains valid.

The daily cache must never become the only copy of activity.

---

## 25. Component tests

Add tests for:

* Dashboard zero state.
* Dashboard seeded progress.
* Exact numerator/denominator rendering.
* Word-state cards.
* Daily-target rendering.
* Zero target behaviour.
* Due-today card.
* Current-streak card.
* Study-time formatting.
* Trend chart labels and values.
* Per-skill progress.
* Per-form progress.
* Loading state.
* Error and retry state.
* Timezone setting load/save.
* Invalid timezone rejection.
* Accessible progress attributes.
* No fake weak-area output.
* No raw component keys displayed.

Avoid assertions tied only to Tailwind class strings.

---

## 26. Playwright E2E

Create a focused Phase 12 E2E suite.

Use programmatic IndexedDB helpers and the generated learner release.

### 26.1 New guest dashboard

Verify:

* `/` loads.
* Overall completion is 0/455.
* Streak is zero.
* Study time is zero.
* Daily targets use the current saved defaults.
* No horizontal overflow at 320px.
* Axe passes.
* Start-studying action works.

### 26.2 Study then dashboard updates

1. Begin a real guest study session.
2. Complete at least one first attempt.
3. Navigate to Dashboard.
4. Confirm:

   * Words started increases.
   * Attempt count/activity appears.
   * Study time is non-zero when a measurable response duration was recorded.
   * Streak becomes one.
   * New or review target progress updates correctly.
5. Navigate to `/progress`.
6. Confirm the relevant skill numerator updates.

Do not seed only UI state for this primary happy-path test; exercise the actual study persistence path.

### 26.3 Incorrect attempt

Complete an incorrect first attempt.

Verify:

* The day still counts toward the streak.
* The attempt appears in activity.
* Reinforcement does not create a second scheduling target count.

### 26.4 Undo

1. Complete a scheduling-relevant attempt.
2. Verify dashboard target progress.
3. Undo the attempt through the supported UI path.
4. Return to dashboard.
5. Verify the target count is refunded and activity reflects the remaining raw data.

### 26.5 Timezone change

At a fixed instant:

1. Record one attempt in browser-detected mode.
2. Save a different supported IANA timezone.
3. Start a new session and record another attempt.
4. Inspect IndexedDB.
5. Confirm:

   * Old attempt retains old timezone/date/source.
   * New attempt uses selected timezone and `user_setting`.
   * Dashboard activity contains the immutable stored date rows.
   * No historical row was re-keyed.

Select zones programmatically from supported values where possible.

### 26.6 DST and streak fixture

Seed valid attempts with immutable local dates around a DST transition.

Verify the rendered streak follows stored consecutive dates.

### 26.7 Due today

Seed:

* One overdue card
* One card due later today
* One card due tomorrow
* One stale ineligible component

Verify only the first two count.

### 26.8 Daily target settings

Change daily targets in Settings.

Verify dashboard denominators update without changing historical counts.

### 26.9 Mobile guest journey

At a 320px viewport:

1. Open Dashboard.
2. Start studying.
3. Complete a question.
4. Return to Dashboard.
5. Open Progress.
6. Change timezone in Settings.
7. Confirm no overflow and all primary actions remain reachable.

### 26.10 Accessibility

Run axe on:

* Empty Dashboard
* Populated Dashboard
* Detailed Progress
* Timezone Settings
* Mobile Dashboard
* Dark-mode Dashboard

Fail on serious or critical violations.

---

## 27. Existing test preservation

Retain all existing tests and guarantees from Phases 0–11:

* Content verification
* Arabic integrity
* Duplicate-entry safety
* Eligibility choke points
* Deterministic generation
* Flashcards
* MC vocabulary
* Timed/test modes
* Bāb/root quizzes
* Mixed-session prioritisation
* Daily target accounting
* Custom-session filters
* Option-count behaviour
* Hints and Hard/Again mapping
* Persistence and undo
* Mobile navigation
* Accessibility
* Settings durability
* Generated-artifact freshness

Do not weaken an existing test to accommodate Phase 12.

---

## 28. Performance

The current release contains 455 entries and approximately 6,793 eligible components.

This is small enough for deterministic in-memory derivation, but avoid wasteful architecture.

Requirements:

* One eligible-component derivation per loaded release.
* One consistent persistence snapshot.
* No IndexedDB query per component.
* No IndexedDB query per metric.
* Memoise expensive pure calculations where useful.
* Do not rebuild analytics on every animation frame.
* Do not repeatedly parse component keys when a prepared index can be built once.
* Daily-activity cache remains rebuildable.
* Trend rendering remains lightweight.
* Dashboard interaction stays responsive on mobile.

Do not add a global state framework.

---

## 29. Data and privacy safety

Dashboard UI must not expose:

```text
question seeds
correct-answer references
selected-answer references
component natural keys
device IDs
review-event IDs
parent event IDs
sync statuses
internal revisions
release checksums
raw attempt history
internal eligibility reasons
review provenance
```

Only aggregate learner-safe values may be rendered.

Do not transmit analytics off-device.

Do not log raw attempts to the browser console.

---

## 30. Documentation updates

Update only the documentation necessary to record implemented Phase 12 semantics.

At minimum document:

* Exact study-time definition
* Current-streak today/yesterday grace rule
* Longest-streak definition
* Effective-state handling when mastered cards become due
* Due-today definition
* Timezone preference shape
* Session-frozen timezone behaviour
* Historical date immutability
* Daily-activity cache rebuild policy
* Dashboard versus detailed Progress route
* Guest Alpha completion

Update:

```text
docs/PRODUCT_REQUIREMENTS.md
docs/ARCHITECTURE.md
docs/DATA_MODEL.md
docs/TEST_STRATEGY.md
docs/IMPLEMENTATION_PHASES.md
```

only where implementation decisions need to be made explicit.

Do not rewrite unrelated planning sections.

Any Arabic inserted into documentation must use the approved placeholder mechanism.

---

## 31. Quality gate

Run the full repository quality gate:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/quality-gate.ps1
```

Also run:

```powershell
pnpm test:coverage

git diff --check
git status --short
```

The final gate must include:

* Python vocabulary validation
* Arabic integrity verification
* Content build
* Documentation verification
* Generated artifact freshness
* Typecheck
* Lint
* Format check
* Unit/component tests
* Production build
* Desktop E2E
* Mobile E2E
* Phase-loop self-tests
* Push-guard tests

Run the complete gate again after the final correction.

---

## 32. Manual demonstration

Demonstrate:

1. Empty guest Dashboard.
2. Start studying from Dashboard.
3. Complete a real question.
4. Return to Dashboard and show updated progress.
5. Open detailed Progress.
6. Show per-skill progress.
7. Show per-form progress.
8. Show word-state counts.
9. Show daily targets.
10. Show recent activity.
11. Show current streak.
12. Show study-time calculation.
13. Show reviews due today.
14. Change timezone.
15. Start a new session.
16. Show the new attempt using the new timezone.
17. Show historical dates unchanged.
18. Show Dashboard on a 320px viewport.
19. Show dark mode.
20. Show keyboard-only navigation.
21. Show reduced-motion behaviour.
22. Show axe results.
23. Show the full guest journey without authentication.

Do not commit screenshots or videos unless they have a clear automated-test purpose.

---

## 33. Acceptance criteria

Phase 12 is complete only when:

* Dashboard placeholder is replaced.
* Progress placeholder is replaced.
* Overall completion is exact word mastery / 455.
* Entry mastery uses all and only eligible essential components.
* Extended components never block word mastery.
* Component mastery uses the complete eligible-component denominator.
* Per-skill formulas are exact.
* Per-form formulas are exact.
* Group formula helpers are exact.
* Entries 369/372 are excluded from root and verb-type denominators.
* Effective mastered state is re-evaluated against due/relearning status.
* Words started, learning and mastered follow documented semantics.
* Study days derive from valid stored attempts.
* Incorrect-only days preserve streaks.
* Current streak is date-based and DST-safe.
* Longest streak is correct.
* Study time is honestly derived from response time.
* Reviews due today use current IANA local-date semantics.
* Daily targets use Phase 11 settings.
* Reinforcement does not consume daily scheduling targets.
* Undo refunds daily target progress.
* Trend chart uses real stored activity.
* Timezone defaults to browser detection.
* Explicit IANA timezone persists.
* Future events use the selected timezone.
* Existing events remain immutable.
* All study modes use the shared effective clock.
* Dexie v3 migration preserves all existing data.
* `daily_activity` is rebuildable from raw attempts/events.
* Corrupt/stale cache rows cannot alter learner truth.
* Dashboard updates after real study activity.
* Mobile and desktop layouts work.
* Axe reports no serious or critical violations.
* No Phase 13 functionality is implemented.
* No generated content changes.
* No files under `data/` change.
* Full quality gate passes.
* Both automated reviewers approve the exact final workspace.
* GitHub CI passes on the draft PR.

---

## 34. Final inspection

Before committing, run:

```powershell
git status
git diff --stat
git diff --check
git diff
```

Confirm:

* No accidental data changes.
* No generated release changes.
* No server code.
* No authentication code.
* No Phase 13 weakness analysis.
* No raw learner history exposed.
* No external analytics.
* No duplicated state formula.
* No duplicated daily-target formula.
* No duplicated form labels.
* No unconditional browser-only timezone path remains in study runners.
* No chart dependency was added.
* Only intentional Phase 12 changes remain.

---

## 35. Commit

Commit with:

```text
Phase 12: add progress dashboard and streaks
```

Push the branch and open a draft PR through the existing `/phase-loop` workflow.

Do not merge automatically.

---

## 36. Final response

Provide:

1. Preflight results.
2. Current base commit.
3. Files created and modified.
4. Analytics module architecture.
5. Eligible-component denominator.
6. Essential-component denominator.
7. Per-skill denominators.
8. Per-form denominators.
9. Overall word-mastery formula.
10. Effective-state logic.
11. Word-state definitions.
12. Activity validity rules.
13. Study-time definition.
14. New/review event classification.
15. Current-streak semantics.
16. Longest-streak semantics.
17. DST handling.
18. Timezone preference design.
19. How every study mode receives the timezone clock.
20. Historical immutability proof.
21. Due-today definition.
22. Daily-target calculation.
23. Trend-chart implementation.
24. Dexie v3 migration.
25. Daily-cache rebuild policy.
26. Cache-corruption recovery.
27. Dashboard component structure.
28. Detailed Progress component structure.
29. Accessibility measures.
30. Mobile behaviour.
31. Unit tests added.
32. Component tests added.
33. E2E tests added.
34. Exact test counts.
35. Exact commands run.
36. Result of every quality-gate stage.
37. Confirmation existing Phase 0–11 tests remain green.
38. Confirmation generated artifacts are unchanged.
39. Confirmation `data/` is unchanged.
40. Final git status.
41. Commit SHA.
42. Draft PR URL.
43. Reviewer outcomes and correction cycles.
44. Remaining concerns or deliberately deferred Phase 13 work.

Stop after Phase 12.

Do not begin Phase 13.
