/**
 * Phase 16 — Stage A causal-lineage classification (server, §14).
 *
 * PURE and deterministic: given a candidate scheduling event and the current
 * server-accepted state of its component chain, decides whether the event
 * EXTENDS the chain (accept), must be HELD until its parent arrives (pending),
 * or must be REJECTED (cycle / stale branch / invalid revision). Ownership
 * checks (cross-user / cross-component parent) are enforced at the DB layer
 * before this runs — this function reasons only over the component-scoped,
 * same-owner event set the caller supplies.
 *
 * Stage A scope (phases-16.md §14): serial chains only. A genuine stale branch
 * is REJECTED recoverably (client must pull/rebase/resubmit) — it is never
 * silently accepted as sequential, and Phase 19's pessimistic-winner/demotion
 * algorithm is NOT implemented here. Timestamps never establish causality.
 *
 * Phase 17 §14 adds ONE narrow exception, as a SEPARATE entry point
 * ({@link classifyMergeLineage}) requiring a branded {@link MergeUnionContext}:
 * the explicit guest→account identity merge, where a second root is the two
 * histories of one learner rather than two devices disagreeing. That is not
 * Phase 19 arriving early — nothing is demoted, no winner is picked, and neither
 * the entry point nor the context can be reached from a client-controlled field.
 * See {@link MergeUnionContext} for why the two are different operations.
 */
import { childrenByParent, type ParentLink } from "@/modules/scheduler";
import type { SyncReasonCode } from "@/modules/sync/protocol";

export type LineageDecision = "accept" | "pending" | "reject";

export type LineageClassification = {
  decision: LineageDecision;
  reasonCode: Extract<
    SyncReasonCode,
    | "accepted"
    | "pending_parent"
    | "cycle_detected"
    | "impossible_lineage"
    | "stale_branch_conflict"
    | "invalid_revision"
  >;
};

/** The component's current server-accepted authoritative chain. */
export type AcceptedChainState = {
  /** Event id at the head of the accepted chain, or null when empty. */
  headEventId: string | null;
  /** `clientComponentRevision` of the head (0 when the chain is empty). */
  headRevision: number;
  /** Every accepted scheduling event id for this component. */
  acceptedEventIds: ReadonlySet<string>;
};

/** All events known for this component (accepted + held), for cycle detection. */
export type ComponentKnownEvents = {
  /** eventId → its parentEventId, across accepted AND pending-parent events. */
  parentByEventId: ReadonlyMap<string, string | null>;
  /** Event ids currently held as `pending_parent`. */
  pendingEventIds: ReadonlySet<string>;
};

export type LineageCandidate = {
  eventId: string;
  parentEventId: string | null;
  clientComponentRevision: number;
};

declare const mergeUnionBrand: unique symbol;

/**
 * Phase 17 §14 — the extra state the MERGE-UNION rule needs, and the capability
 * to use it.
 *
 * BRANDED ON PURPOSE. The brand is a module-private `unique symbol`, so this
 * type cannot be satisfied by an object literal written anywhere else: the only
 * way to obtain one is {@link mergeUnionContext}, which derives every revision
 * from the component's already-accepted SERVER rows. §13 requires the merge
 * ingestion mode to be "server-internal and reachable only through the
 * authenticated merge coordinator", and a plain structural type would have left
 * that guarantee resting on a comment — any future caller could have assembled a
 * lookalike from request data and enabled the relaxation with client-controlled
 * revisions. Now it cannot compile.
 *
 * The mode exists because a guest history is a SECOND root on a component the
 * account has already studied, and Phase 16 rejects that as
 * `stale_branch_conflict` — correctly, for an ordinary device, where a second
 * root means two devices diverged and Phase 19 must arbitrate. An explicit
 * identity merge is not that: both histories genuinely belong to this learner
 * and neither is a loser, so the union is kept whole and replayed
 * deterministically by canonical time.
 */
export type MergeUnionContext = {
  /**
   * `clientComponentRevision` of every accepted event in the component. Needed
   * because contiguity in a union is a property of a CHAIN, not of the
   * component: the guest's history numbers its own revisions from 1, so "one
   * past the head" is meaningless across the two. The rule becomes "exactly one
   * past my own parent's".
   */
  readonly revisionByEventId: ReadonlyMap<string, number>;
  readonly [mergeUnionBrand]: true;
};

/** An accepted event as the server stores it, reduced to what the union needs. */
export type AcceptedEventRevision = {
  eventId: string;
  clientComponentRevision: number;
};

/**
 * The only way to obtain a {@link MergeUnionContext}. Takes the component's
 * ALREADY-ACCEPTED rows — server state, never wire input — so the revisions the
 * union is judged against cannot originate from the request being judged.
 */
export function mergeUnionContext(
  accepted: Iterable<AcceptedEventRevision>,
): MergeUnionContext {
  const revisionByEventId = new Map<string, number>();
  for (const row of accepted) {
    revisionByEventId.set(row.eventId, row.clientComponentRevision);
  }
  // The brand is a type-level marker with no runtime representation; this cast
  // is the single sanctioned place that asserts it, which is what makes every
  // other construction site impossible.
  return { revisionByEventId } as unknown as MergeUnionContext;
}

function accept(): LineageClassification {
  return { decision: "accept", reasonCode: "accepted" };
}
function pending(): LineageClassification {
  return { decision: "pending", reasonCode: "pending_parent" };
}
function reject(
  reasonCode: LineageClassification["reasonCode"],
): LineageClassification {
  return { decision: "reject", reasonCode };
}

/**
 * The `client_component_revision` of a sequential extension must be exactly one
 * past the chain head (local chains are contiguous — modules/scheduler/chain.ts
 * requires "contiguous starting at 1"). A lower value is a regression
 * (`invalid_revision`); a higher value is an impossible gap
 * (`impossible_lineage`). Returns null when the revision is exactly right.
 * Applies ONLY to the accept paths (root / parent==head): a stale branch or a
 * competing root is classified by STRUCTURE, never by a revision comparison,
 * because `client_component_revision` is monotonic only within one local chain.
 */
function revisionMismatch(
  revision: number,
  expected: number,
): LineageClassification | null {
  if (revision < expected) return reject("invalid_revision");
  if (revision > expected) return reject("impossible_lineage");
  return null;
}

/**
 * Walk the candidate's parent ancestry; return true if it reaches
 * `candidate.eventId` (an indirect cycle) or exceeds a bound (a pre-existing
 * cycle among stored events). Bounded so a corrupt cyclic store cannot loop.
 */
function ancestryReachesSelf(
  candidate: LineageCandidate,
  parentByEventId: ReadonlyMap<string, string | null>,
): boolean {
  const limit = parentByEventId.size + 1;
  let cursor = candidate.parentEventId;
  for (let steps = 0; steps <= limit; steps += 1) {
    if (cursor === null) return false;
    if (cursor === candidate.eventId) return true;
    cursor = parentByEventId.get(cursor) ?? null;
  }
  // Exceeded the bound without terminating ⇒ a cycle exists in the stored graph.
  return true;
}

/**
 * Does an already-accepted event other than `candidate` claim `parentEventId` as
 * ITS parent? Then the candidate would fork the chain there.
 *
 * A fork is rejected in the merge union too, and it has to be checked explicitly
 * because the union rule removes the "parent must be the head" test that
 * incidentally prevented forks in ordinary sync. A fork is not two histories
 * being joined — it is one history contradicting itself — and the client's
 * `partitionScheduling` throws `ChainError` on it whether or not the union is
 * opted into. Accepting one here would persist a component the client can never
 * replay again.
 *
 * WHAT a fork is, is not decided here: `childrenByParent` in
 * `modules/scheduler/chain.ts` is the one definition, and `partitionScheduling`
 * throws on the same index this reads. That pairing is the point — the server
 * must not admit a shape the client's replay then refuses.
 *
 * `parentEventId` is non-null by construction of the only call site: two ROOTS
 * both have a null parent and are the case the union exists to allow, so asking
 * this question of a root would answer "fork" about the thing that is not one.
 */
function forksAnAcceptedChain(
  candidate: LineageCandidate & { parentEventId: string },
  chain: AcceptedChainState,
  known: ComponentKnownEvents,
): boolean {
  const acceptedLinks: ParentLink[] = [];
  for (const acceptedId of chain.acceptedEventIds) {
    acceptedLinks.push({
      eventId: acceptedId,
      parentEventId: known.parentByEventId.get(acceptedId) ?? null,
    });
  }
  const claimants =
    childrenByParent(acceptedLinks, chain.acceptedEventIds).get(
      candidate.parentEventId,
    ) ?? [];
  return claimants.some((claimant) => claimant !== candidate.eventId);
}

/**
 * Cycle detection, the one rule no mode may suspend. Returns the rejection, or
 * null when the candidate is acyclic. Shared by both exported classifiers so it
 * is written once even though they are separate entry points.
 */
function cycleRejection(
  candidate: LineageCandidate,
  known: ComponentKnownEvents,
): LineageClassification | null {
  // Direct self-parent is always a cycle.
  if (candidate.parentEventId === candidate.eventId) {
    return reject("cycle_detected");
  }
  // Indirect cycle (parent's ancestry loops back to this event).
  if (ancestryReachesSelf(candidate, known.parentByEventId)) {
    return reject("cycle_detected");
  }
  return null;
}

/**
 * Classify one candidate against the component's accepted chain under the Phase
 * 17 §14 MERGE-UNION rule. Deliberately a SEPARATE exported entry point rather
 * than a flag on {@link classifyLineage}: ordinary sync's classifier then has no
 * parameter capable of naming a union context, so the relaxation cannot be
 * reached from the ordinary path by a refactor that threads an optional argument
 * through a shared helper. Choosing the wrong entry point fails CLOSED — a
 * legitimate merge event is rejected, and a test catches it — rather than
 * admitting an illegitimate branch on a live device sync.
 *
 * Requires a {@link MergeUnionContext}, obtainable only from
 * {@link mergeUnionContext} over the component's accepted server rows.
 *
 * Idempotency (duplicate `event_id`) and ownership are the caller's, as for
 * {@link classifyLineage}.
 */
export function classifyMergeLineage(
  candidate: LineageCandidate,
  chain: AcceptedChainState,
  known: ComponentKnownEvents,
  merge: MergeUnionContext,
): LineageClassification {
  const cycle = cycleRejection(candidate, known);
  if (cycle) return cycle;

  const { parentEventId, clientComponentRevision } = candidate;

  if (parentEventId === null) {
    // A second root is the whole point of the union: the guest's history begins
    // where the account's did not. Ordinary sync calls this a stale branch.
    //
    // No fork check here, deliberately — every root shares the same null parent,
    // so "another accepted event has my parent" is true of two roots and is the
    // very thing being permitted. Roots are not forks; a re-delivered root with
    // the same event id is caught by idempotency before this runs.
    //
    // Every chain numbers from 1, so a root below that is not a real chain root.
    if (clientComponentRevision < 1) return reject("invalid_revision");
    return accept();
  }

  if (chain.acceptedEventIds.has(parentEventId)) {
    if (forksAnAcceptedChain({ ...candidate, parentEventId }, chain, known)) {
      return reject("stale_branch_conflict");
    }
    const parentRevision = merge.revisionByEventId.get(parentEventId);
    if (parentRevision === undefined) {
      // Accepted but with no known revision: the caller built an inconsistent
      // context. Refuse rather than guess — an imported chain whose contiguity
      // was never checked is exactly what §14 must not persist.
      return reject("impossible_lineage");
    }
    // Contiguity WITHIN the chain, not across the union (see MergeUnionContext),
    // and EXACT — not merely increasing. An imported guest chain is a `complete`
    // chain in the client's terms (root with no parent, numbering from 1), and
    // `partitionScheduling` requires a complete chain's revisions to be exactly
    // contiguous. Accepting a gap here would persist a set the next replay throws
    // `ChainError` on, which ingest.ts treats as fatal for the whole component —
    // so a hole left by one rejected guest event would take the rest of the
    // component's batch down with it instead of rejecting just the orphan.
    return (
      revisionMismatch(clientComponentRevision, parentRevision + 1) ?? accept()
    );
  }

  // Parent held pending, or not yet delivered: hold this child behind it, the
  // same as ordinary sync. The merge coordinator uploads a chain in order, so
  // this is a chunk-boundary or retry case, and it resolves on its own.
  return pending();
}

/**
 * Classify one candidate scheduling event against its component's accepted
 * chain. Assumes idempotency (duplicate `event_id`) and ownership have already
 * been resolved by the caller.
 *
 * Phase 16's rule, and its signature is deliberately unchanged: there is no
 * parameter here that could carry a merge-union context, so ordinary sync cannot
 * reach the §14 relaxation. The merge coordinator calls
 * {@link classifyMergeLineage} instead.
 */
export function classifyLineage(
  candidate: LineageCandidate,
  chain: AcceptedChainState,
  known: ComponentKnownEvents,
): LineageClassification {
  const cycle = cycleRejection(candidate, known);
  if (cycle) return cycle;

  const { parentEventId, clientComponentRevision } = candidate;

  // A sequential extension must carry the next contiguous revision.
  const expectedRevision = chain.headRevision + 1;

  // Root event (no parent).
  if (parentEventId === null) {
    if (chain.headEventId !== null) {
      // A second root while the chain already has a head is a competing branch,
      // classified by structure regardless of its revision value.
      return reject("stale_branch_conflict");
    }
    // First event on an empty chain: must be revision 1 (head 0 + 1).
    return (
      revisionMismatch(clientComponentRevision, expectedRevision) ?? accept()
    );
  }

  // Parent extends the current accepted head ⇒ sequential — accept even when the
  // event was created from a stale `base_server_revision` (§14.1), provided the
  // revision progresses contiguously.
  if (parentEventId === chain.headEventId) {
    return (
      revisionMismatch(clientComponentRevision, expectedRevision) ?? accept()
    );
  }

  // Parent is an accepted event but NOT the head ⇒ branching off history: a
  // genuine stale branch. Held recoverably for pull/rebase (Stage A §14.4).
  // Classified by structure, NOT by revision (revisions are per-local-chain).
  if (chain.acceptedEventIds.has(parentEventId)) {
    return reject("stale_branch_conflict");
  }

  // Parent is itself held pending (present but not yet accepted) ⇒ this child
  // must also wait behind it.
  if (known.pendingEventIds.has(parentEventId)) {
    return pending();
  }

  // Parent is entirely unknown for this component ⇒ hold until it arrives.
  return pending();
}
