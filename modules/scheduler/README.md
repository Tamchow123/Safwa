# modules/scheduler

Pure-TypeScript spaced-repetition scheduling (Phase 7): ts-fsrs integration,
rating mapping, review-event creation with causal lineage, the local causal
chain + deterministic replay, learner-state/mastery projection, and due
selection. Runs identically in the browser and (later) on the server, so it
must never import React, DOM APIs or database clients (`docs/ARCHITECTURE.md`
§2). An ESLint purity rule forbids `Date.now`/`Math.random`/`crypto` and
framework/DB imports here — every clock is injected and ts-fsrs is driven only
by injected instants (fuzz is disabled for determinism).

## Modules

| File         | Responsibility                                                                              |
| ------------ | ------------------------------------------------------------------------------------------- |
| `fsrs.ts`    | ts-fsrs integration: create/advance a card at an injected instant; ms ↔ Date.               |
| `ratings.ts` | Rating mapping from a Phase-6 attempt (correct→Good, hinted-correct→Hard, incorrect→Again). |
| `events.ts`  | Review-event creation (first scheduling-relevant attempt only) + causal lineage.            |
| `chain.ts`   | Sequential local causal chain: causal ordering, deterministic FSRS replay, undo.            |
| `states.ts`  | Learner-state projection and the ≥3-distinct-mastery-days rule.                             |
| `due.ts`     | Due selection + mixed-revision ordering (due → weak → new, daily targets).                  |
| `index.ts`   | Public barrel.                                                                              |

## Determinism & replay

Replaying a component's accepted `scheduling` events in causal order reproduces
its FSRS card state **bit-for-bit** — each review is applied at its own
immutable event instant, ts-fsrs runs with fuzz off, and no ambient clock is
read. Concurrent-branch detection and conflict demotion are **Phase 19**;
Phase 7 chains are single-device sequential.

## Mastery (PRODUCT_REQUIREMENTS.md §5)

A mastery day is a distinct stored `local_date_at_event` of an accepted Good/Easy
review taken while the card was **already in the FSRS Review state** (a genuine
due review). `Hard` never advances a mastery day; the initial learning success
is excluded; reinforcement produces no event and never advances. `Mastered`
requires ≥3 distinct mastery days and a not-currently-due card; a mastered card
that becomes due (or lapses) is `needs_review`.
