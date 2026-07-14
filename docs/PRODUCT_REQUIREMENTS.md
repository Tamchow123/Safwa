# Safwa — Product Requirements

Status: planning baseline (Architecture Plan v4, approved 2026-07-14).
Arabic examples in this document are inserted via the programmatic
placeholder mechanism described in `CLAUDE.md` — never hand-typed.

## 1. Product vision

Safwa helps students of the _Cream of Arabic_ / _Safwa-tul-Maṣādir_ material
memorise Arabic vocabulary the way Quizlet teaches vocabulary — but with
ṣarf-aware depth: every verb's supplied forms, its three-letter root, its bāb,
and its morphological category are each independently learnable skills with
spaced repetition, weak-area analysis and honest mastery tracking.

## 2. Target users

- Students working through the Cream of Arabic syllabus (primary).
- Independent learners of classical Arabic morphology.
- Anyone: the app is public, and **no account is required to study**.

Explicitly not targeted in the initial releases: teachers/classrooms, children
(no COPPA-style features), native-app users.

## 3. Scope

### 3.1 MVP (through the Core MVP milestone)

- Vocabulary library (search, filter, sort, browse, detail pages).
- Flashcards (both directions, field selection, flip/swipe/keyboard, undo).
- Multiple-choice quizzes: Arabic→English, English→Arabic.
- Identify-the-bāb quiz; identify-the-root quiz (multiple choice).
- Mixed revision ("start studying" with zero configuration).
- Custom session configuration (filters, counts, timed mode, test mode).
- FSRS spaced repetition per study component; due reviews.
- Progress dashboard: word + component mastery, per-skill bars, streaks,
  daily targets, trends.
- Weak areas by bāb / verb type / form / direction / skill / state.
- Bookmarks and simple custom lists.
- Guest usage with IndexedDB persistence.
- Registration/login (email + password, verification, reset), server-backed
  progress, cross-device sync, guest→account merge.
- Settings incl. dark mode, Arabic font size, timezone, daily targets.
- Granular progress resets.

### 3.2 Post-MVP (explicitly excluded from MVP)

- Typed Arabic and English answers (architecture must not block it; see §10).
- Full thulāthī mazīd fīh learning mode — **the 21 seed candidates are not a
  launchable dataset**; a larger verified dataset is prerequisite.
- Pronunciation audio; conjugation quizzes for pronouns.
- Detailed wrong-answer explanations.
- Push notifications (in-app reminders may ship earlier); gamification beyond
  streaks; achievements.
- Teacher/classroom features; native mobile apps.
- Admin area may lag the learner MVP (it is phase 21) but is required before
  content editing happens anywhere other than the JSON + scripts pipeline.

## 4. Functional requirements

### 4.1 Content and eligibility (mandatory)

- All learner content derives from versioned, immutable **content releases**
  built from `data/safwa-vocabulary.v2.json`.
- Question generation, distractor selection and study-component creation use
  **only** fields whose `quiz_eligibility` is true. One field's problem never
  disables unrelated fields (455 madi / 454 mudari / 445 masdar / 455 meaning /
  454 ism_fail / 454 amr / 454 nahi / 455 bab / 453 verb_type / 453 root
  eligible at schema 2.2.0).
- Generated additional forms (750 values) and mazīd candidates (21) are
  excluded from learner releases while unverified.
- Entries 369 and 372 (طَاحَ, غَاطَ) have root and
  verb_type quizzes disabled pending dictionary verification.
- Duplicate-māḍī entries remain distinct: ids 262/275 (حَبَّ),
  297/303 (قَرَأَ), 409/413 (مَحَا) differ in muḍāriʿ
  and/or bāb and must never be merged or used as distractors for each other
  where the surface answer would be ambiguous.

### 4.2 Study components

Learning is tracked per **study component**, not per word:

- Translation skills: `(entry, skill, source_field, direction)` — e.g.
  recognition of the maṣdar Ar→En is separate from recognition of the māḍī,
  and separate from En→Ar recall. Source fields: madi, mudari, masdar,
  ism_fail, amr, nahi.
- Entry-level skills: `(entry, skill)` for bāb, root and verb-type
  identification; the prompt form varies per question and is recorded on the
  attempt.

### 4.3 Learning modes

**Flashcards** — direction choice (Ar→En / En→Ar); study a selected field or a
random eligible field; flip via tap/click/keyboard; swipe left/right on touch
plus accessible button/keyboard equivalents; "I know" / "I don't know";
single-step undo. "I know" carries the same learning weight as a correct quiz
answer; "I don't know" schedules the item to return soon.

**Arabic→English MC** — shows an eligible Arabic form (form deliberately not
named in the question), 4 options, plausible distractors; after answering, the
form is revealed ("This was the maṣdar form.").

**English→Arabic MC** — shows the meaning, asks for the correct Arabic form,
4 options, respects form filters, reveals the form type after answering.

**Identify the bāb** — default prompt is the māḍī; configurable to muḍāriʿ,
ism al-fāʿil, another eligible form, or random eligible forms. Answer options
are Arabic pattern pairs like نَصَرَ يَنْصُرُ — never transliteration
alone and never "Form I–VI" numbering.

**Identify the root** — only entries with `root` eligibility true; selected or
random eligible prompt form; multiple choice over three-radical options
(typed root input is post-MVP).

**Mixed revision** — one-tap "start studying": due reviews first, then weak
items, then new items, within the user's daily targets.

### 4.4 Session configuration

Filterable by: mode; direction; specific Arabic form or random eligible forms;
bāb; verb category; book page/source grouping; state (new / learning /
mastered / weak / due); bookmarks; custom lists; question count; timed or
untimed; immediate-feedback or test mode.

Defaults (user-changeable): **20 questions/session · 4 options · 10 new
items/day · 20 reviews/day target**. Timed mode: configurable per-question
limit (default 20s). Test mode: correctness feedback withheld until session
end.

**Hints** (first letter, root, word length, bāb, another form): a hinted
correct answer earns reduced credit — FSRS rating `Hard` instead of `Good`.
A hinted incorrect answer is simply incorrect (`Again`). Hint usage is recorded
per attempt.

### 4.5 Question-generation rules

- Only eligible target fields; only eligible distractor values.
- No duplicate visible choices after Arabic normalisation; entries with
  identical surface forms are excluded from each other's option sets.
- Distractors prefer plausibility: same field, similar bāb/verb type/page.
- The answer must be unambiguous; the correct option is unique in the set.
- The prompt's form is not named in the question; it is revealed afterwards.
- Bāb questions display only the selected form (harder/easier configurations
  may come later).

### 4.6 Incorrect-answer behaviour

- Outside test mode, the correct answer is shown immediately.
- The item is reintroduced later in the same session for reinforcement.
- Session state distinguishes: first-attempt correct; incorrect then corrected
  in-session; repeated incorrect; hinted. A within-session recovery is
  **reinforcement only** — it never counts as a clean learning success and
  never produces a second scheduling event.

### 4.7 Accounts, guests and merge

- Guests study with full core functionality; progress in IndexedDB (with a
  `navigator.storage.persist()` request and a gentle register prompt).
- Registration is optional; email/password with verification and reset.
- Signed-in users get server-backed state, cross-device sync, durable
  bookmarks/settings.
- On sign-in/registration from a device with guest data, the app offers a
  merge; merge ingests guest attempts/events through the normal causal sync
  pipeline (deterministic, idempotent), unions bookmarks/lists, and prefers
  account settings while filling gaps from guest settings.

### 4.8 Reset controls

Users can reset: all progress; meaning progress; bāb progress; root progress;
a specific skill; a bāb; a verb category; a source category; a single entry.
Resets require explicit confirmation naming what is destroyed. Reset clears
FSRS state and scheduling events for the scope; attempt history is retained
for analytics unless "delete all my data" is chosen; bookmarks and settings
are never touched by progress resets.

## 5. Learning rules (authoritative)

- Scheduler: **FSRS** (ts-fsrs). One FSRS card per study component.
- Ratings: correct unhinted → Good; correct hinted → Hard; incorrect (hinted
  or not) → Again; flashcard "I know" → Good; "I don't know" → Again. `Easy`
  is not currently exposed.
- Only the first scheduling-relevant attempt per component per session
  produces a review event; recoveries are reinforcement.
- Component states: **Not started** (no scheduling events) → **Learning**
  (≥1 clean success) → **Mastered** (qualifying successful scheduled reviews
  on ≥3 distinct stored local dates, not currently due, not reset) →
  **Needs review** (due/lapsed after mastery).
- A _qualifying_ mastery success = an accepted, scheduling-authoritative event
  rated Good (or future Easy) on a review where the component's FSRS state was
  Review (a genuine due review). `Hard` reschedules but does not advance the
  three-day requirement. The initial learning success establishes Learning and
  does **not** count as one of the three days.
- Word (entry) state derives from its **essential components**: meaning
  recognition of each eligible field among {madi, mudari, masdar}; meaning
  recall (En→Ar) of madi; bāb identification; root identification (when
  eligible). Entry Mastered = all essential components mastered. Extended
  components (recognition of ism_fail/amr/nahi, other recall directions,
  verb-type identification) are tracked separately and never block word
  mastery. User-selectable goal profiles are post-MVP.

## 6. Progress definitions (exact formulas)

| Metric                              | Numerator                                             | Denominator                                           |
| ----------------------------------- | ----------------------------------------------------- | ----------------------------------------------------- |
| Overall completion (word mastery)   | entries whose essential components are all Mastered   | 455                                                   |
| Component mastery                   | Mastered eligible components                          | all eligible components for the enabled skill set     |
| Per-skill completion                | Mastered components of that skill                     | eligible components of that skill                     |
| Per-form completion                 | Mastered components with that source_field            | eligible components with that source_field            |
| Bāb / verb-type / source completion | Mastered essential components of entries in the group | eligible essential components of entries in the group |
| Words started / learning / mastered | counts by entry state                                 | —                                                     |

- Ineligible fields are excluded from every denominator.
- **Study day / streak:** a local calendar day (by the event's stored
  `local_date_at_event`) with ≥1 valid, non-revoked study attempt — incorrect
  answers count; difficult days keep the streak. Streak = consecutive stored
  local dates. Timezone changes affect future events only; history is
  immutable.
- **Mastery days:** distinct stored `local_date_at_event` values of accepted
  scheduling-authoritative Good/Easy scheduled reviews only.
- Dashboard shows: overall completion, words mastered/learning, streak, study
  time, reviews due today, daily-target progress, weak areas, trend charts.
  No user-facing full answer-history page (attempt data powers analytics
  internally).

## 7. Non-functional requirements

- **Responsive** desktop + mobile layouts; appropriate navigation per size.
- **Design:** clean, minimal, academic, modern, restrained-game-like; dark
  mode; smooth but restrained animation; reduced-motion support.
- **Arabic display:** highly readable Arabic font, adjustable size, RTL
  applied per Arabic element (the app chrome is English LTR).
- **Accessibility:** WCAG-minded components, keyboard operability everywhere,
  visible focus states, screen-reader semantics, ≥44px touch targets,
  sufficient contrast in both themes.
- **PWA:** installable; app shell + active content release cached; offline
  study per the staged rollout in `OFFLINE_AND_SYNC.md`.
- **Performance:** initial route interactive fast on mid-range mobile; content
  release loads once and is cached; loading/empty/error states everywhere;
  error boundaries; network retry with backoff.
- **Security/privacy:** see `ARCHITECTURE.md` §Security; account deletion
  supported; privacy-conscious analytics only.

## 8. Acceptance criteria (MVP gate)

1. A first-time guest reaches their first flashcard in ≤2 taps from landing.
2. Ineligible fields never appear as prompts, targets or distractors
   (verified by automated tests + manual audit).
3. Entries 369/372 never appear in root or verb-type quizzes.
4. A wrong-then-correct item in one session produces exactly one `Again`
   scheduling event and a recorded reinforcement attempt.
5. Word mastery and component mastery percentages match the formulas in §6
   against a seeded fixture.
6. A guest who registers keeps every attempt, bookmark and their merged
   scheduling state; re-running the merge changes nothing.
7. The same account on two devices converges to identical component states
   after sync.
8. Streak survives a timezone change without rewriting history.
9. Bāb answer options render as Arabic pairs (e.g. ضَرَبَ يَضْرِبُ);
   nothing labels mujarrad bābs as Forms I–VI.
10. All dashboards/quizzes usable with keyboard only and with a screen reader;
    dark mode and reduced motion honoured.

## 9. Explicit exclusions (MVP)

Typed answers; mazīd fīh study mode; audio; pronoun conjugation; push
notifications; achievements beyond streaks; teacher features; native apps;
public API; localisation of the UI beyond English.

## 10. Forward-compatibility constraints

- Typed Arabic answers (post-MVP) will require ḥarakāt, treat shaddah and
  hamzah strictly, use NFC + invisible-character stripping + trim only, and
  ship an on-screen Arabic keyboard — the normalisation utility and answer-ref
  model must already support this (they do: answers are references, and the
  comparison policy is defined in `CLAUDE.md`).
- New skills/shapes (form transformation, pronoun conjugation) must be
  addable via lookup-table inserts and additive migrations
  (`DATA_MODEL.md` §skill_types).
