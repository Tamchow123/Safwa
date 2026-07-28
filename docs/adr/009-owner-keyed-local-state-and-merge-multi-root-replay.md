# ADR-009: Owner-keyed local state, and multi-rooted replay for merged history

- Status: Accepted
- Date: 2026-07-28

## Context

Phase 17 lets someone who has been studying as a guest keep that work when
they make an account. Two problems in the existing design stood in the way,
and neither could be solved inside the merge itself.

**A guest and an account could not safely share a device.** Phase 16 gave the
private Dexie stores a nullable `userId` column but left their primary keys
alone, so the natural key — `componentKey`, `entryId`, `key` — was still the
whole identity. An account's write physically replaced a guest's row with the
same natural key. Phase 16 dealt with that by clearing the account-scoped
stores wholesale on sign-out, which necessarily destroyed a coexisting guest's
rows too: a documented, deliberate data loss. That is incompatible with §9.1's
promise that "Not now" costs the learner nothing and that the merge stays
available later — the guest's rows have to survive both a refusal and a
sign-out, on the same device, alongside the account's.

**A merged component has two histories.** `review_events` is a causal DAG:
every event names a `parent_event_id`, replay walks from the root, and a
component with two roots is exactly what a corrupted or forged chain looks
like. But a genuine merge produces precisely that — the account's own chain
for a component, and the guest's independent chain for the same component,
neither descended from the other. Replay had to accept that shape from a merge
and keep rejecting it everywhere else.

## Decision

**The owner is part of the local primary key.** Schema v7 re-keys the private
learner-state stores to a compound `[ownerKey+naturalKey]`, where `ownerKey` is
a total, non-null, IndexedDB-valid string built by
`modules/content/owner-key.ts`: `guest` for the un-signed-in learner on this
device, `account:<user-id>` for a signed-in one. IndexedDB cannot index `null`
and a compound key containing `null` is not a valid key at all, so the nullable
`userId` could not be promoted directly. The key is opaque to consumers and
branded in TypeScript, so a raw user id cannot be passed where an owner key is
required — ad-hoc prefix concatenation across components is a compile error,
not a convention.

Sign-out, account switch and account deletion then clear rows **scoped to one
owner** instead of clearing stores, which is what makes a deferred merge
keepable. Where the departing account cannot be resolved, the sweep removes
every non-guest owner's rows — confidentiality never depends on that lookup
succeeding, and the guest's rows still survive.

**A multi-rooted component is legitimate only when a merge says so** — and that
is enforced in **two stages**, at different moments, for different reasons. The
distinction matters, because it is where the defence actually is.

_Admission_ is where a second root is permitted or refused, and it is the only
place that decides. An arriving event is classified by
`classifyMergeLineage` — a **separate exported entry point**, not a flag on
ordinary sync's `classifyLineage`, so the relaxation has no parameter to reach
it through and cannot be switched on by a refactor that threads an optional
argument into a shared helper. Choosing the wrong entry point fails **closed**:
a legitimate merge event is rejected and a test catches it, rather than an
illegitimate branch being admitted on a live device sync. It requires a
brand-sealed `MergeUnionContext`, obtainable only from the component's accepted
server rows, and is reached only for an event carrying its own
`imported_from_guest_import_id` — which only the authenticated merge
coordinator stamps.

_Replay_ does not repeat that check. It asks one question —
`allowMergeUnion = study_components.merged_at != null` — and nothing else.
`merged_at` is a durable record that admission already happened correctly for
this component, and replay trusts it rather than re-deriving it from per-event
provenance it does not load. Every Phase 16 caller passes no mark at all, so
`partitionScheduling`'s `ChainError` stays the loud detector it has always been
for every component that was never merged.

`merged_from_guest_import_id` is provenance, not a gate: it records _which_
import did this, for audit and for the rollback ordering in
`docs/DEPLOYMENT.md`. Nothing reads it to make a decision.

So the property to protect is **admission**, and the thing that protects it is
the separate entry point plus the fact that only the merge coordinator can
produce a stamped event — not a second check further down. A change that
weakened admission would not be caught later by replay.

## Consequences

- A guest and one or more accounts coexist on a device with no cross-reads and
  no silent overwrites, and "Not now" is genuinely free.
- Re-keying four stores meant new physical object stores (IndexedDB cannot
  re-key in place), so the v6 originals were dropped after their rows were
  copied forward. `e2e/helpers/idb.ts` owns the logical→physical name map so
  specs are not each responsible for knowing it.
- Every owner-scoped read and write must go through the owner key. A query that
  forgets it does not return "everyone's rows" — it returns nothing, which
  fails loudly rather than leaking.
- Replay's root rule is now conditional, which is a real increase in its
  complexity — though a small one: it is a single predicate over one column,
  and the condition is a stored fact rather than an inference.
- **The cost of that simplicity is that replay is not a second line of
  defence.** It trusts `merged_at`; it does not re-verify that each extra root's
  events are stamped. A bug that let an unstamped root past admission would not
  be caught at replay. Accepted deliberately — the alternative is loading and
  matching per-event provenance on every projection, for a check that duplicates
  one already made under an advisory lock in the transaction that admitted the
  event — but it means changes to the **admission** path deserve more scrutiny
  than changes to replay (RISK_REGISTER #25).
- Phase 19's device-conflict resolution is a _different_ problem and must not
  reuse this exemption: two devices disagreeing about one identity's history is
  a conflict to resolve, not two identities' histories to unite.

## Alternatives considered

- **Keep the nullable `userId` and add owner-scoped indexes only.** Rejected:
  indexes do not prevent a primary-key collision, which is the actual defect.
- **A separate Dexie database per owner.** Rejected: it multiplies the
  storage-persistence request, the content cache and the migration surface, and
  it makes the merge a cross-database transaction — the one thing that must be
  atomic.
- **Rewrite the guest's events to descend from the account's chain.** Rejected:
  it invents causality that did not happen. The guest's answers were not given
  after the account's; a DAG that says they were is a lie the scheduler would
  then act on.
- **Import the guest's history as a flat snapshot with no events.** Rejected:
  it discards the lineage the whole event model exists to preserve, and makes
  the imported state unverifiable by replay.
