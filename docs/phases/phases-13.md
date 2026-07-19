# Phase 13 — Weak Areas and Targeted Practice

Implement **Phase 13 — Weak areas** for Safwa.

Use the established `/phase-loop` workflow:

```text
/phase-loop Phase 13 — Weak areas and targeted practice. Implement exactly the Phase 13 requirements in docs/IMPLEMENTATION_PHASES.md. Extend the completed Phase 12 analytics layer with weakness heuristic v2, weakness aggregation and exact weak-set drill sessions. Do not begin Phase 14.
```

Work only on Phase 13.

Do not begin bookmarks, custom lists, accounts, server work or Phase 14.

---

## 1. Required branch

Create:

```text
phase/13-weak-areas
```

from the latest merged `origin/main`.

Phase 12 must already be merged.

Before editing, confirm that `main` contains:

* Progress Dashboard
* Detailed Progress page
* Exact progress formulas
* Streak calculations
* Timezone preference
* `daily_activity` derived cache
* Phase 12 analytics persistence snapshot
* Guest Alpha milestone completion

If Phase 12 is absent, incomplete or unmerged, stop and report that rather than implementing Phase 13 against Phase 11.

---

## 2. Read the current repository first

Read:

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

Inspect the current implementation, especially:

```text
app/(shell)/page.tsx
app/(shell)/progress/page.tsx
app/(shell)/settings/page.tsx
app/(shell)/study/custom/page.tsx

components/dashboard/*
components/progress/*
components/study/custom-session.tsx
components/study/mixed-session.tsx
components/study/quiz-runner.tsx

lib/form-metadata.ts
lib/preferences/use-session-defaults.ts
lib/preferences/use-timezone.ts

modules/analytics/*
modules/content/constants.ts
modules/content/db.ts
modules/content/schema.ts

modules/profile/session-defaults.ts
modules/profile/settings.ts
modules/profile/timezone.ts

modules/scheduler/due.ts
modules/scheduler/fsrs.ts
modules/scheduler/states.ts
modules/scheduler/events.ts

modules/study-engine/attempts.ts
modules/study-engine/components.ts
modules/study-engine/natural-key.ts

modules/study-session/custom.ts
modules/study-session/mixed.ts
modules/study-session/persistence.ts
```

Inspect all Phase 12 tests and E2E fixtures.

Search the repository for:

```text
computeWeakScores
weakScore
componentStateClasses
dailyActivity
AnalyticsPersistenceSnapshot
localDateAtEvent
isFirstAttempt
isReinforcement
promptField
sourceField
fsrs.lapses
learnerState
effectiveLearnerState
```

Follow the actual Phase 12 architecture rather than assuming the proposed filenames above were used unchanged.

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
* The branch starts from the latest `origin/main`.
* Phase 12 is merged.
* The complete Phase 12 quality gate is green.
* Dashboard and Progress E2E tests pass.
* No generated artifact is stale.
* Nothing under `data/` has changed.

Do not stash, reset or discard user work.

---

## 4. Phase objective

Provide honest and actionable answers to:

* Which vocabulary areas does the learner struggle with?
* Which bābs need more practice?
* Which verb types need more practice?
* Which Arabic source forms cause difficulty?
* Is recognition or recall weaker?
* Which study skills are weakest?
* Which current learner states contain the most difficulty?
* Which exact study components should be practised next?

Phase 13 must deliver:

* A dedicated weak-areas page.
* Aggregation by:

  * Bāb
  * Eligible verb type
  * Source form
  * Direction
  * Skill
  * Current learner state
* Weakness heuristic v2:

  * Recent first-attempt accuracy
  * FSRS lapses
  * Recency
* Ranked, explainable weak areas.
* A drill-session launch for an exact weak set.
* Integration with the existing Progress page.
* Integration with mixed-session weak ordering.
* Refresh after study and undo.
* Mobile and accessibility support.

---

## 5. Non-goals

Do not implement:

* Bookmarks
* Custom lists
* Bookmark/list session filters
* Authentication
* PostgreSQL
* Drizzle
* Sync
* Guest merge
* PWA work
* Notifications
* Achievements
* Leaderboards
* External analytics
* Teacher reporting
* AI-generated explanations
* New content fields
* Typed Arabic answers
* A raw answer-history page
* New scheduler rules
* A second FSRS card
* A new study-component identity
* New vocabulary data
* Phase 14

Do not expose raw attempts, answer references or internal IDs to learners.

---

## 6. Architecture

Extend the Phase 12 analytics module.

Suggested structure:

```text
modules/
  analytics/
    weakness.ts
    weakness-evidence.ts
    weakness-groups.ts
    weakness-persistence.ts
    index.ts

  study-session/
    weak-drill.ts
```

Suggested UI:

```text
app/
  (shell)/
    progress/
      weak-areas/
        page.tsx

    study/
      weak/
        page.tsx

components/
  progress/
    weak-areas-page-client.tsx
    weakness-summary.tsx
    weakness-dimension-tabs.tsx
    weakness-group-list.tsx
    weakness-group-card.tsx
    weakness-empty-state.tsx
    weakness-explanation.tsx

  study/
    weak-drill-session.tsx
```

Exact filenames may differ.

### Pure logic

The following must remain pure TypeScript:

* Evidence preparation
* Component weakness calculation
* Group aggregation
* Ranking
* Weak drill-plan construction
* URL parameter validation

Pure modules must have:

* No React
* No Dexie
* No DOM
* No ambient `Date.now()`
* Injected `nowMs`
* Deterministic output
* Exhaustive unit tests

### Persistence

Reuse the Phase 12 analytics snapshot and validity rules.

Do not build another independent attempt/event loading system.

Database interaction belongs in a browser-only persistence adapter.

---

## 7. Reuse Phase 12 validity rules

Weakness analytics must consume the same honest source records as the Phase 12 dashboard.

Reuse or extract shared helpers for:

* Valid full attempt records
* Revoked/rejected attempt exclusion
* Current effective component state
* Stale/ineligible component removal
* Current release component universe
* Immutable event timestamps
* Content-release matching

Do not let Dashboard, Progress and Weak Areas disagree about whether an attempt or component is valid.

Requirements:

* Corrupt legacy rows are skipped safely.
* Missing full attempt payloads do not create analytics evidence.
* Components not derivable from the current release are excluded.
* Ineligible fields cannot influence grouping or drilling.
* Reinforcement attempts remain available as study activity but do not influence first-attempt accuracy.
* Revoked or rejected attempts do not influence weakness.
* Conflict-demoted scheduling events do not influence FSRS weakness.
* No raw cache row is trusted as authoritative without validation.

---

## 8. Weakness evidence model

Create a prepared evidence model rather than repeatedly interpreting raw records in each aggregation.

Conceptually:

```ts
type WeaknessAttemptEvidence = {
  attemptId: string;
  componentKey: string;
  entryId: number;
  skillType: SkillType;
  direction: Direction | null;
  analysisForm: SourceQuizFormField | null;
  isCorrect: boolean;
  occurredAtMs: number;
};

type WeaknessComponentEvidence = {
  componentKey: string;
  entryId: number;
  skillType: SkillType;
  direction: Direction | null;
  sourceField: SourceQuizFormField | null;
  effectiveState: LearnerState;
  fsrsLapses: number;
  firstAttempts: WeaknessAttemptEvidence[];
};
```

Adapt this to the current Phase 12 analytics types.

### First-attempt accuracy

Only include attempts satisfying:

```text
isFirstAttempt === true
isReinforcement === false
```

Within-session reinforcement must not:

* Improve the weakness score
* Erase the failed first attempt
* Count as a second first attempt
* Create duplicate component evidence

A wrong first attempt followed by a successful reinforcement remains weakness evidence.

### Attempt time

Use the attempt’s immutable recorded UTC instant.

Do not use:

* IndexedDB insertion order
* Current local date
* Session completion time
* `Date.now()` inside the pure module

Invalid or non-finite timestamps are skipped safely.

---

## 9. Correct source-form attribution

This is a load-bearing rule.

### Translation components

For:

```text
meaning_recognition
meaning_recall
```

the analysis source form is:

```text
attempt.sourceField
```

### Entry-level skills

For:

```text
bab_identification
root_identification
verb_type_identification
```

the component has no source field.

The form used in the question is recorded as:

```text
attempt.promptField
```

When `promptField` is one of the six source forms, use it as the form attribution.

This means:

* A bāb attempt prompted with māḍī belongs to the māḍī form evidence.
* A later attempt for the same bāb component prompted with muḍāriʿ belongs to the muḍāriʿ form evidence.
* Do not assign every bāb attempt to māḍī merely because māḍī is the default.
* Do not use the component identity to infer prompt form.
* Do not duplicate the complete entry-level history into every source-form group.

Add direct regression tests for prompt-form-varied bāb attempts.

---

## 10. Weakness heuristic v2

Replace the v1 recent-error fraction with a documented deterministic v2 score.

The implementation may use differently named helpers, but it must preserve the following semantics.

### Constants

Define named exported constants such as:

```text
Recent first-attempt window:       10
Accuracy half-life:                30 days
Recent-failure half-life:          14 days
Lapse saturation:                  3 lapses
Weak threshold:                    documented constant
```

Do not scatter unexplained numeric values through the code.

### Inputs

For each component, use:

* Up to the ten most recent valid first attempts
* Correct/incorrect outcome
* Attempt UTC timestamp
* Current FSRS `lapses`
* Effective learner state
* Injected `nowMs`

### Recency-decayed attempt weight

For each first attempt:

```text
ageDays = max(0, nowMs - occurredAtMs) / dayMs

weight = 0.5 ^ (ageDays / accuracyHalfLifeDays)
```

A future timestamp should be clamped to age zero or rejected under the shared plausibility policy.

### Accuracy signal

Calculate:

```text
weightedErrorRate =
  weighted incorrect mass / weighted attempt mass
```

Also calculate an evidence-confidence factor so one very old incorrect attempt does not remain permanent maximum weakness.

For example:

```text
evidenceConfidence =
  min(weighted attempt mass / 3, 1)

accuracySignal =
  weightedErrorRate * evidenceConfidence
```

### Lapse signal

Use the component’s current FSRS lapse count:

```text
lapseSignal =
  min(max(lapses, 0) / lapseSaturation, 1)
```

Invalid lapse values fail safely to zero.

Do not rederive FSRS lapses from the count of all incorrect attempts.

### Recent-failure signal

Find the latest incorrect first attempt.

When one exists:

```text
recentFailureSignal =
  0.5 ^ (daysSinceLatestIncorrect / recentFailureHalfLifeDays)
```

Otherwise:

```text
recentFailureSignal = 0
```

### Composite score

Use an explicit weighted combination such as:

```text
weaknessScore =
  0.65 * accuracySignal
  + 0.25 * lapseSignal
  + 0.10 * recentFailureSignal
```

The exact weights may be adjusted only with a clear documented reason and tests proving the required ordering properties.

The score must be:

* Finite
* Deterministic
* Clamped to 0–1
* Kept as an unrounded internal value
* Rounded only for optional presentation

### Qualification

A component qualifies as weak only when:

* It is a valid eligible materialised component.
* It has actual failure evidence:

  * At least one incorrect first attempt, or
  * At least one FSRS lapse.
* It exceeds the documented threshold.
* It is not effectively mastered and not due.

A mastered, non-due component must not be called weak merely because it has an old historical lapse.

A due mastered component belongs to the scheduler’s due tier. Do not mislabel ordinary due revision as weakness unless independent failure/lapse evidence exists.

A new, untouched component is not weak.

An all-correct component is not weak.

### Explainability fields

Return the signals separately:

```ts
type ComponentWeakness = {
  score: number;
  accuracySignal: number;
  lapseSignal: number;
  recentFailureSignal: number;
  firstAttemptCount: number;
  incorrectFirstAttemptCount: number;
  firstAttemptAccuracy: number | null;
  lapses: number;
  lastAttemptAtMs: number | null;
  lastIncorrectAtMs: number | null;
  qualifiesAsWeak: boolean;
};
```

Do not expose the internal component key in learner-facing UI.

---

## 11. Integrate v2 everywhere weakness is used

There must be one authoritative weakness implementation.

Update:

* Mixed revision weak ranking
* Phase 11 Custom Session `weak` state filter
* Weak Areas ranking
* Weak drill planning
* Any Progress weak-area teaser

Remove or retire the old v1 calculation where it is no longer needed.

Do not maintain:

```text
computeWeakScoresV1
computeWeakScoresV2
dashboardWeakScore
customSessionWeakScore
```

as conflicting implementations.

A compatibility wrapper may remain temporarily only when it delegates directly to the v2 result.

Mixed revision must continue:

```text
due → weak → new
```

but its weak tier now uses v2 scores.

All-correct non-due learning cards must still wait until FSRS says they are due.

---

## 12. Aggregation dimensions

Create ranked aggregate rows for six dimensions.

### 12.1 Bāb

Group by the entry’s eligible bāb.

Display:

* Dataset-provided Arabic bāb pair
* Learner-safe secondary label when already available
* Weak component count
* Attempted component count
* First-attempt accuracy
* Lapses
* Practice priority
* Last practised date

Do not show internal bāb IDs as the main label.

Do not manually type Arabic bāb patterns.

### 12.2 Verb type

Group only when:

```text
entry.quiz_eligibility.verb_type === true
```

Entries 369 and 372 must not:

* Enter a verb-type group
* Affect a verb-type weakness score
* Appear in a verb-type drill
* Reveal their unresolved classification

They remain available in other valid dimensions.

Use the dataset-provided Arabic display through `<ArabicText>`.

### 12.3 Source form

Use the attribution rules from section 9.

Display all forms using the existing shared form metadata.

Form-specific accuracy must use only attempts actually prompted or answered through that form.

For entry-level components:

* Form-specific first-attempt evidence is allowed.
* Do not duplicate the component’s complete FSRS lapse count into every form it has ever used.
* Any lapse contribution to a form must be uniquely and honestly attributable.
* When unique attribution is unavailable, display form-specific accuracy/recency without inventing a lapse count.

Document this limitation clearly in code.

### 12.4 Direction

Group translation components by:

```text
arabic_to_english
english_to_arabic
```

Entry-level skills have no direction and must not be assigned a fake direction.

They remain represented through the skill and form dimensions.

Display learner-facing labels:

```text
Arabic → English recognition
English → Arabic recall
```

### 12.5 Skill

Group by all current skill types:

* Meaning recognition
* Meaning recall
* Bāb identification
* Root identification
* Verb-type identification

Use shared learner-facing skill metadata.

Do not expose raw skill IDs as primary copy.

### 12.6 Current state

Group weak evidence by the component’s current effective state at `nowMs`.

Use the shared effective-state helper from Phase 12.

Possible learner-facing groups include:

* Learning
* Needs review

A component that is effectively mastered and not due should not be in the weak set.

Untouched Not started components have no weakness evidence and should not be surfaced as a weak area.

---

## 13. Group statistics

Each aggregate should expose exact, explainable metrics such as:

```ts
type WeaknessGroup = {
  dimension: WeaknessDimension;
  value: string;
  weakComponentCount: number;
  attemptedComponentCount: number;
  firstAttemptCount: number;
  incorrectFirstAttemptCount: number;
  firstAttemptAccuracy: number | null;
  lapseCount: number;
  weaknessScore: number;
  lastAttemptAtMs: number | null;
};
```

### Accuracy denominator

Accuracy is:

```text
correct valid first attempts /
all valid first attempts in the group
```

Do not include:

* Reinforcement
* Untouched components
* Missing attempts
* Invalid attempts

Do not use the total eligible-component count as the accuracy denominator.

### Group score

The group score must be evidence-weighted.

Requirements:

* One isolated failure must not automatically outrank a heavily practised group with sustained difficulty without considering evidence.
* A large group must not rank highly merely because it contains many entries.
* Unattempted components contribute no weakness.
* Strong attempted components may reduce the group’s aggregate weakness.
* Scores are deterministic.
* Tie-breaking is stable.

A suitable approach is an evidence-weighted mean of component weakness scores, with each component’s weight capped to prevent one over-practised component dominating.

For form groups containing prompt-varied entry-level evidence, use the form-specific attempt evidence rather than duplicating one component-wide score across every observed form.

Document the chosen aggregation formula and its trade-offs.

### Minimum evidence

A group may surface when it has:

* At least two valid first attempts, or
* A genuine FSRS lapse, or
* A component exceeding a stronger single-component threshold

Keep the minimum-evidence rule explicit and tested.

Do not show a “weak area” from one accidental click without context unless its score is genuinely severe.

---

## 14. Ranking

Provide deterministic ranked results.

Default ordering:

1. Higher group weakness score
2. More weak components
3. More recent incorrect evidence
4. Stable learner-facing or ID tie-break

Do not rank alphabetically before weakness.

Return at least:

* Top five overall areas
* Full ranked list per dimension

The learner-facing UI should avoid false precision.

Prefer:

```text
High priority
Medium priority
Lower priority
```

alongside honest metrics such as:

```text
6 of 10 first attempts correct
2 components need practice
1 lapse
```

Do not prominently display `0.643728` as though it were a clinical measurement.

---

## 15. Weak-area page

Create:

```text
/progress/weak-areas
```

The page should include:

* Heading
* Short explanation
* Top practice priorities
* Dimension selector/tabs
* Ranked list
* Attempt/accuracy context
* Last-practised context
* Drill action
* Loading state
* No-evidence state
* No-current-weakness state
* Recoverable error state
* Link back to Progress

Suggested tabs:

```text
Overview
Bāb
Verb type
Form
Direction
Skill
State
```

### Empty states

Distinguish:

#### No study evidence

```text
Study a few items to discover which areas need more practice.
```

#### Evidence exists but no current weakness

```text
No clear weak areas right now.
```

Do not show empty results as an error.

### Progress integration

Update `/progress` to include:

* A concise Weak Areas section
* Top one to three areas
* Link to the full page

Do not clutter the root Dashboard with a complete analysis table.

A small Dashboard link or summary is acceptable when Phase 12 already reserved space for weak areas.

---

## 16. Learner-facing copy

Use supportive and factual wording.

Prefer:

```text
Needs practice
Practice priority
Recent accuracy
Review this area
```

Avoid:

```text
Bad at
Failed
Worst
Poor learner
```

Explain that:

* Weakness is based on recent first attempts, review lapses and recency.
* Reinforcement recoveries do not erase the initial difficulty.
* The ranking changes as the learner studies.
* Untouched content is not treated as weak.

Keep the explanation concise in the main UI, with optional expandable detail.

---

## 17. Drill-session route

Create a route such as:

```text
/study/weak
```

Use validated URL parameters, for example:

```text
dimension
value
```

Examples conceptually:

```text
/study/weak?dimension=bab&value=<validated-id>
/study/weak?dimension=form&value=mudari
/study/weak?dimension=skill&value=meaning_recall
```

Do not put:

* Raw component keys
* Attempt IDs
* Device IDs
* Answer references
* Arbitrary JSON
* Unvalidated route destinations

into the URL.

Unknown or invalid parameters must show a safe not-found/invalid-set state.

---

## 18. Exact weak-set planning

The drill must practise the exact weak set, not a broad content filter that reintroduces strong or untouched components.

Create a pure planner such as:

```ts
buildWeakDrillPlan(
  entries,
  componentWeakness,
  requestedGroup,
  sessionDefaults,
  seed,
  nowMs,
)
```

Requirements:

* Starts only from currently qualifying weak components.
* Matches the selected group exactly.
* Excludes strong components.
* Excludes untouched components.
* Excludes stale/ineligible components.
* Uses exact component identities.
* Sorts by weakness score descending.
* Uses recency and stable identity as tie-breakers.
* Applies the current session question-count default.
* Is deterministic for the same inputs and seed.
* Produces a plan accepted by the existing shared QuizRunner.
* Does not create a new question engine.
* Does not change natural keys.
* Does not change FSRS rules.

### Entry-level prompt form

For a form-specific drill of an entry-level component:

* Use the selected weak form as `promptForm`.
* Verify the prompt form remains quiz-eligible for the entry.
* Do not silently fall back to another form and still call it a form-specific drill.
* Exclude a component when the selected form is no longer eligible.

For non-form group drills, use the existing deterministic eligible prompt-form policy.

### Direction and mode

Use the component’s real identity.

A mixed weak set may include:

* Recognition
* Recall
* Bāb
* Root
* Verb type

The shared runner must render each question according to its component.

Do not coerce all components into vocabulary recognition.

---

## 19. Drill-session behaviour

The weak drill should use a sensible zero-configuration setup:

* Immediate feedback
* Untimed
* Current saved option-count default
* Current saved question-count default
* Existing hint support
* Existing undo
* Existing persistence
* Existing result summary

Do not add another session-configuration form.

Provide:

* Weak-area context before the first question
* Question progress
* Existing feedback
* Results
* “Study this area again”
* Link back to Weak Areas

### Refresh on Study again

“Study this area again” must:

1. Read a fresh analytics snapshot.
2. Recompute weakness.
3. Rebuild the selected group.
4. Exclude components that are no longer weak.
5. Show an encouraging empty state when the area no longer qualifies.

Do not replay the stale original component list indefinitely.

---

## 20. Interaction with daily targets

Weak-drill sessions are explicit learner-chosen sessions and are not limited by the remaining daily target allowance.

However, their scheduling events still contribute to the real daily progress totals under the existing Phase 12 rules.

Do not introduce a second target counter.

Do not suppress legitimate review events merely because the daily target was reached.

The Dashboard must continue showing actual completed counts, even when they exceed the target.

---

## 21. Updating mixed revision

Replace v1 scores in mixed revision with v2.

Preserve:

```text
due → weak → new
```

Requirements:

* Due remains above weak.
* A genuine weak item is ordered by v2 score.
* All-correct, non-due learning items remain excluded.
* Reinforcement does not remove weakness evidence.
* A recently failed component ranks above an otherwise equivalent old failure.
* More lapses increase priority.
* Mastered, non-due items remain excluded.
* Existing pedagogical new-item ordering remains unchanged.
* Daily targets remain unchanged.
* Session cap remains unchanged.

---

## 22. Updating Custom Session weak filter

The Phase 11 `weak` state filter must use v2 qualification.

It must agree with:

* Weak Areas
* Weak drill planning
* Mixed revision

A component must not be:

* Weak in Custom Session
* Strong in Weak Areas
* Missing from mixed revision

under the same snapshot and time.

Add a shared contract test proving all three consumers agree.

---

## 23. Accuracy and lapse attribution safeguards

### Reinforcement

A recovery attempt must not improve first-attempt accuracy.

### Entry-level form accuracy

Use `promptField`, not the component source field.

### Translation form accuracy

Use `sourceField`.

### Direction

Entry-level attempts have no direction and are excluded from direction groups.

### Verb type

Unverified verb type cannot select or label an entry.

### Lapses

Do not duplicate one component’s total lapse count across multiple prompt-form buckets.

### Current state

Use current effective state, not a stale stored label.

### Content versions

Only analyse attempts whose release/content identity is still supported by the loaded analytics policy.

Do not join an attempt to a different entry merely because the numeric ID matches across an unsupported release.

Follow the Phase 12 content-version handling.

---

## 24. Unit tests — heuristic v2

Add comprehensive tests under:

```text
tests/analytics/weakness*.test.ts
```

Test:

1. No attempts and no lapses → score zero.
2. All-correct attempts → not weak.
3. One recent incorrect first attempt creates weakness.
4. Reinforcement recovery does not erase the weakness.
5. Later correct first attempts reduce the score.
6. Recent failures weigh more than equivalent old failures.
7. Ancient isolated failure decays below the threshold.
8. Lapses increase the score.
9. Lapse saturation caps safely.
10. Invalid negative lapses fail safely.
11. Score remains finite and clamped.
12. Same inputs produce identical output.
13. Attempt input order does not change output.
14. Equal timestamps use stable attempt-ID ordering.
15. Future timestamp handling is deterministic.
16. Revoked attempt is excluded.
17. Rejected attempt is excluded.
18. Conflict-demoted event does not add lapse evidence.
19. Wrong-only `not_started` component can qualify.
20. Mastered non-due component is excluded.
21. Due-only all-correct component is not falsely called weak.
22. Untouched new components are not weak.
23. The recent-attempt window is enforced.

Use injected fixed times.

---

## 25. Unit tests — aggregation

Test every dimension.

### Bāb

* Errors in one bāb make that group surface.
* Other bābs do not inherit the attempts.
* Arabic display comes from content.

### Verb type

* Eligible classifications aggregate correctly.
* Entries 369/372 are excluded.
* Their unresolved values never appear in output.

### Form

* Translation attempt uses `sourceField`.
* Bāb attempt uses `promptField`.
* One bāb component attempted with māḍī and muḍāriʿ produces separate form evidence.
* Complete component history is not duplicated into both forms.
* Lapses are not duplicated across prompt-form buckets.

### Direction

* Recognition contributes only to Arabic→English.
* Recall contributes only to English→Arabic.
* Entry-level attempts do not enter either direction group.

### Skill

* Every current skill groups correctly.
* Raw skill IDs are mapped to learner-facing labels only in presentation.

### State

* Uses effective current state.
* Stale mastered-due becomes Needs review.
* Untouched Not started does not surface.

### Ranking

* Sustained difficulty outranks one low-confidence failure.
* Recent evidence affects ties.
* Strong evidence lowers a group score.
* Minimum evidence works.
* Ranking is deterministic.
* Empty evidence returns an empty list.

---

## 26. Unit tests — drill planning

Test:

* Only qualifying weak components enter the plan.
* Strong components are excluded.
* Untouched components are excluded.
* Stale/ineligible components are excluded.
* Group matching is exact.
* Bāb drill contains only the selected bāb.
* Verb-type drill excludes unresolved entries.
* Form drill contains only matching translation forms or matching entry-level prompt forms.
* Direction drill contains only that direction.
* Skill drill contains only that skill.
* State drill uses effective state.
* Highest scores are selected first.
* Session default count is honoured.
* Stable seeded result.
* Same inputs produce identical plan.
* Invalid URL dimension/value is rejected.
* Raw component keys are not required in the URL.
* Form-specific entry-level plan sets the selected `promptForm`.
* No fallback prompt form violates the selected group.

---

## 27. Component tests

Add tests for:

* No-study-evidence state
* No-current-weakness state
* Ranked overview
* Dimension switching
* Exact accuracy text
* Lapse text
* Last-practised text
* High/medium/lower priority labels
* Bāb Arabic rendering
* Verb-type Arabic rendering
* Shared form labels
* Direction labels
* Skill labels
* State labels
* Drill button
* Error and retry state
* Loading state
* Invalid drill request
* Drill empty state after improvement
* No raw IDs or component keys in learner-facing copy
* Supportive wording
* Accessible semantics

Avoid tests that only assert Tailwind class strings.

---

## 28. Playwright E2E

Create a dedicated Phase 13 suite.

### 28.1 No evidence

For a new guest:

* Open `/progress/weak-areas`.
* See the no-evidence state.
* See a Study action.
* Axe passes.
* No horizontal overflow at 320px.

### 28.2 Bāb weakness journey

Programmatically select a bāb with enough eligible material.

1. Start a bāb session.
2. Deliberately answer several first attempts incorrectly.
3. Complete any required reinforcement.
4. Navigate to Weak Areas.
5. Confirm the selected bāb appears near the top.
6. Confirm its accuracy reflects first attempts only.
7. Confirm the Arabic bāb pair is exact from the learner release.
8. Launch the drill.
9. Confirm every drill question belongs to that bāb.
10. Confirm no strong/unseen component entered the drill.

This is the Phase 13 acceptance journey.

### 28.3 Prompt-form-varied bāb accuracy

1. Complete bāb attempts using two different prompt forms.
2. Fail one form and answer the other correctly.
3. Open the Form dimension.
4. Confirm the failed form ranks weaker.
5. Confirm the attribution came from persisted `promptField`.

Use learner-release values programmatically.

### 28.4 Verb-type protection

Seed or complete attempts involving entries 369 and 372 through valid non-verb-type skills.

Confirm:

* They do not enter any verb-type group.
* Their unresolved verb-type labels do not appear.
* A verb-type drill never contains them.

### 28.5 Direction

Create failed recognition and successful recall evidence.

Confirm Arabic→English ranks weaker without contaminating English→Arabic.

### 28.6 Reinforcement

1. Fail a first attempt.
2. Complete the reinforcement correctly.
3. Open Weak Areas.
4. Confirm the failed first attempt remains weakness evidence.
5. Confirm the accuracy denominator includes one first attempt, not two.

### 28.7 Recency

Seed equivalent failed evidence at different ages.

Confirm the recent failure ranks higher.

### 28.8 Lapses

Seed components with equal recent accuracy but different valid FSRS lapse counts.

Confirm the higher-lapse component ranks higher.

### 28.9 Weak drill refresh

1. Launch a weak-area drill.
2. Answer weak components correctly.
3. Finish.
4. Select Study again.
5. Confirm the plan is recomputed.
6. Confirm resolved items disappear or reduce in priority.
7. If nothing remains, show the no-current-weakness state.

### 28.10 Mixed revision agreement

Seed:

* One due component
* One v2-weak component
* One all-correct non-due component
* New components

Confirm order:

```text
due → v2 weak → new
```

and confirm the all-correct non-due component is not included as weak.

### 28.11 Custom Session agreement

Select the Phase 11 `weak` filter.

Confirm it produces the same qualifying component set as the Weak Areas engine under the same snapshot.

### 28.12 Mobile

At 320px:

* Open overview
* Switch dimensions
* Open one group
* Launch a drill
* Complete a question
* Return to Weak Areas

Confirm:

* No horizontal overflow
* Bottom navigation remains usable
* Arabic labels are not clipped
* Buttons meet touch-target expectations

### 28.13 Accessibility

Run axe on:

* No-evidence page
* Populated overview
* Bāb dimension
* Form dimension
* Weak drill
* Mobile Weak Areas
* Dark-mode Weak Areas

Fail on serious or critical violations.

---

## 29. Preserve Phase 12 behavior

Do not regress:

* Overall word mastery
* Component mastery
* Per-skill progress
* Per-form progress
* Streaks
* Timezone handling
* Daily activity
* Due-today count
* Daily target progress
* Trend chart
* Dexie migration
* Activity cache reconstruction

Weakness analytics may reuse the Phase 12 snapshot but must not change its authoritative formulas.

---

## 30. Performance

There may be thousands of attempts over time.

Requirements:

* Read one consistent analytics snapshot.
* Prepare evidence once.
* Group through indexed maps.
* Avoid rescanning all attempts separately for every dimension.
* Avoid one IndexedDB query per component or group.
* Sort only prepared group/component results.
* Memoise expensive computations where useful.
* Recompute after meaningful data changes, not every render.
* Keep the page responsive on mobile.
* Do not add a global state framework.

An unbounded full-history read may be acceptable for the current guest stage only when the Phase 12 persistence architecture already does this and the limitation is documented.

Prefer designing the pure API so future server aggregates can replace the local input without rewriting UI logic.

---

## 31. Privacy and safety

Do not render or log:

```text
component keys
attempt IDs
event IDs
device IDs
question seeds
answer references
correct answers
selected answers
parent event IDs
client revisions
sync statuses
release checksums
raw attempt history
```

The page displays aggregates and learner-safe content labels only.

No analytics leave the device.

Do not add telemetry.

---

## 32. Documentation

Update the relevant documentation to record:

* Weakness heuristic v2 formula
* Constants and weights
* First-attempt-only accuracy
* Reinforcement exclusion
* Recency-decay behavior
* FSRS lapse signal
* Weak qualification threshold
* Mastered/due distinction
* Source-form attribution rules
* Entry-level `promptField` attribution
* Group aggregation
* Minimum evidence
* Exact weak-set drill behavior
* Mixed-session v2 integration
* Custom-session weak-filter integration
* No external analytics

Update only the necessary sections of:

```text
docs/PRODUCT_REQUIREMENTS.md
docs/ARCHITECTURE.md
docs/DATA_MODEL.md
docs/TEST_STRATEGY.md
docs/IMPLEMENTATION_PHASES.md
```

Do not rewrite unrelated planning material.

Do not insert hand-typed Arabic into documentation.

---

## 33. Quality gate

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

The final quality gate must remain green for all Phases 0–13.

Run it again after the final reviewer correction.

---

## 34. Manual demonstration

Demonstrate:

1. New guest no-evidence state.
2. Deliberately fail several questions in one bāb.
3. Complete reinforcement.
4. Open Weak Areas.
5. Show the bāb ranked.
6. Show first-attempt-only accuracy.
7. Switch to Form.
8. Show prompt-form-specific bāb evidence.
9. Switch to Direction.
10. Switch to Skill.
11. Switch to State.
12. Launch the bāb weak drill.
13. Confirm every question belongs to the group.
14. Complete the drill.
15. Recompute the weak set.
16. Show reduced or cleared weakness.
17. Show mixed revision using v2 order.
18. Show the custom-session weak filter agreeing.
19. Show entries 369/372 absent from verb-type analysis.
20. Show desktop and 320px mobile layouts.
21. Show dark mode.
22. Show keyboard navigation.
23. Show axe results.
24. Show that Dashboard and Progress still calculate correctly.

---

## 35. Acceptance criteria

Phase 13 is complete only when:

* `/progress/weak-areas` exists.
* Weakness uses recent first-attempt accuracy.
* Reinforcement does not improve first-attempt accuracy.
* Weakness incorporates FSRS lapses.
* Weakness incorporates recency.
* The score is deterministic and explainable.
* Untouched content is not weak.
* All-correct content is not weak.
* Mastered, non-due content is not weak.
* Recent failures outrank equivalent old failures.
* Lapses increase priority.
* Aggregation exists for bāb.
* Aggregation exists for eligible verb type.
* Aggregation exists for source form.
* Aggregation exists for direction.
* Aggregation exists for skill.
* Aggregation exists for current state.
* Translation form attribution uses `sourceField`.
* Entry-level form attribution uses `promptField`.
* Prompt-varied bāb attempts produce correct form-specific accuracy.
* Entries 369/372 never appear in verb-type analysis or drills.
* Group metrics use valid first attempts only.
* Ranking uses minimum evidence.
* Learner-facing wording is supportive.
* The Progress page links to Weak Areas.
* Drill routes use validated group identifiers.
* Raw component keys do not enter URLs.
* Weak drill uses the exact weak component set.
* Strong and untouched items do not enter the drill.
* Form drills preserve selected prompt form.
* Study again recomputes the weak set.
* Mixed revision uses v2.
* Custom Session weak filtering uses v2.
* All three consumers agree.
* Existing Phase 12 metrics remain unchanged.
* Mobile and desktop layouts work.
* Axe reports no serious or critical violations.
* No Phase 14 work is included.
* No generated content changes.
* Nothing under `data/` changes.
* Full quality gate passes.
* Claude reviewer approves the final bytes.
* Codex reviewer approves the final bytes.
* GitHub CI passes.

---

## 36. Final inspection

Run:

```powershell
git status
git diff --stat
git diff --check
git diff
```

Confirm:

* No generated artifacts changed.
* No files under `data/` changed.
* No schema migration was added without a demonstrated need.
* No raw history page was added.
* No external analytics was added.
* No duplicate weakness algorithm remains.
* No broad-filter drill includes strong content.
* No unverified verb type is rendered.
* No Arabic value was manually reconstructed.
* No Phase 14 implementation exists.
* Only intentional Phase 13 changes remain.

---

## 37. Commit

Commit with:

```text
Phase 13: add weak-area insights and drills
```

Push and open a draft PR through `/phase-loop`.

Do not merge automatically.

---

## 38. Final response

Report:

1. Preflight results.
2. Base commit.
3. Files created and modified.
4. Phase 12 analytics reused.
5. Evidence-preparation design.
6. First-attempt filtering.
7. Reinforcement handling.
8. Weakness v2 formula.
9. Formula constants and weights.
10. Accuracy signal.
11. Lapse signal.
12. Recency signal.
13. Qualification threshold.
14. Mastered/due behavior.
15. Source-form attribution.
16. Prompt-form-varied bāb behavior.
17. Bāb aggregation.
18. Verb-type aggregation.
19. Form aggregation.
20. Direction aggregation.
21. Skill aggregation.
22. State aggregation.
23. Group ranking and minimum evidence.
24. Learner-facing priority labels.
25. Weak Areas UI structure.
26. Progress-page integration.
27. Drill URL design.
28. Exact weak-set planning.
29. Form-specific entry-level drill handling.
30. Study-again refresh behavior.
31. Mixed-session v2 integration.
32. Custom-session weak-filter integration.
33. Unit tests added.
34. Component tests added.
35. E2E tests added.
36. Exact test counts.
37. Full quality-gate results.
38. Existing Phase 0–12 regression results.
39. Accessibility results.
40. Mobile results.
41. Confirmation entries 369/372 remain protected.
42. Confirmation generated artifacts are unchanged.
43. Confirmation `data/` is unchanged.
44. Final git status.
45. Commit SHA.
46. Draft PR URL.
47. Reviewer outcomes and correction cycles.
48. Remaining concerns or deferred Phase 14 work.

Stop after Phase 13.

Do not begin Phase 14.
