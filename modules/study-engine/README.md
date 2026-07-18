# modules/study-engine

The pure-TypeScript study engine (Phase 6): the deterministic heart of the
product, with **no UI**. It runs identically in the browser and (later) on the
server, so it must never import React, DOM APIs or database clients
(`docs/ARCHITECTURE.md` §2). An ESLint rule (`eslint.config.mjs`) forbids
`Date.now`, `Math.random`, `crypto` and framework/DB imports inside this
module — all clocks and randomness are injected.

## Modules

| File             | Responsibility                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| `natural-key.ts` | The shared study-component natural-key builder/parser (client == server).                            |
| `rng.ts`         | Deterministic seeded RNG (xmur3 → mulberry32) and stable string hashing.                             |
| `fields.ts`      | Field-value resolution (bāb/verb-type → Arabic pair) and eligibility checks.                         |
| `components.ts`  | Component derivation from the eligibility matrix; essential vs extended; lazy materialisation.       |
| `distractors.ts` | Plausibility-ranked, normalised-unique, ambiguity-excluding distractor engine.                       |
| `generator.ts`   | Deterministic question generation (4 objective types + flashcards) + specs.                          |
| `correctness.ts` | Shared correctness (answer-reference resolution) — optimistic now, server-authoritative in Phase 16. |
| `attempts.ts`    | Attempt-record creation with event-time timezone metadata (injected clock).                          |
| `session.ts`     | Session state machine: first-attempt tracking, reinforcement re-queue, undo, timed/test modes.       |
| `index.ts`       | Public barrel.                                                                                       |

## Determinism

A question is a pure function of its inputs — the caller's `question_seed`, the
generator version, content version, component key, and the structural
parameters (**delivery mode** mc/flashcard/timed/test, position, prompt form).
The determinism key uses the **authoritative `release_id`** (content-hash
derived, ADR-003) — never `content_version`, which is human-readable metadata
that may repeat across corrected releases — so two releases sharing a
content_version but differing in content have distinct instance identities.
The generator folds these into one per-instance seed via an **injective**
length-prefixed encoding (`canonicalKey`, so distinct tuples can never flatten
to the same string), so the same inputs always reproduce one byte-identical
question AND two structurally-different questions — including the same MC
question delivered as plain/timed/test — never share an instance id (enforced by
the generator, not a caller convention). Position must be a non-negative safe
integer (so it survives JSON replay). The generator version is validated on
`createQuestionContext` — a release built by an unimplemented generator version
is rejected. The instance id is a 128-bit hash (`stableHash128Hex`) of the
determinism key, so structurally-distinct questions never collide even at scale.
A recorded `QuestionSpec` carries the full question-instance specification (id,
allowed/correct answer refs, delivery mode, prompt field, hint state) and
regenerates the question byte-for-byte (`generateFromSpec`, JSON-round-trip
safe) while re-validating those derived fields (incl. prompt field for every
component shape, delivery mode and hint state) for tamper detection — the basis
for the server reconstructing and validating attempts in Phase 16.

## Arabic comparison (hard rule 4)

All value comparison goes through `answerComparisonKey(field, value)`: the
normalise-only policy for every field, plus maṣdar-alternative splitting on
`" / "` (order-independent set) for the maṣdar field. Display strings are never
rewritten.

## Injected dependencies (no ambient nondeterminism)

The engine mints nothing from the environment: the session takes an injected
**clock** (`AttemptClock`) and **attempt id** (`SubmitAnswerInput.attemptId`, a
UUID from the persistence layer), and a **userId** (null for guests). Timed
expiry is derived SOLELY from the injected `responseTimeMs` against the
configured limit (which defaults to 20s, must be positive-finite, and applies to
MC only) — never a caller override. A combined timed+test session is rejected
(Phase 11). Test mode withholds per-question feedback (`submitAnswer` returns
`feedback: null`) until `revealResults` is called on the completed session,
while the wrong-answer reinforcement re-queue still happens (§4.6).

A session is **pinned** to one content release (OFFLINE_AND_SYNC §2): it stores
the content + generator version at creation and rejects any `QuestionContext`
from a different release mid-session. Every submission is **bound** to the
`questionInstanceId` the learner was shown, so a stale or duplicate action is
rejected rather than graded against a different, unseen question.

## Eligibility (CLAUDE.md hard rule 2)

Ineligible fields never become a target, prompt or distractor: components are
derived only from eligible fields, prompts are validated eligible, the
candidate pool contains only eligible answer values, and `materialiseComponent`
refuses to materialise an ineligible component. Entries 369/372 (root +
verb-type ineligible) are therefore excluded from that material, and
duplicate-māḍī groups never appear in each other's option sets where the
surface answer would be ambiguous.
