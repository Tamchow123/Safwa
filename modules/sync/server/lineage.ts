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
 */
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
 * Classify one candidate scheduling event against its component's accepted
 * chain. Assumes idempotency (duplicate `event_id`) and ownership have already
 * been resolved by the caller.
 */
export function classifyLineage(
  candidate: LineageCandidate,
  chain: AcceptedChainState,
  known: ComponentKnownEvents,
): LineageClassification {
  const { eventId, parentEventId, clientComponentRevision } = candidate;

  // Direct self-parent is always a cycle.
  if (parentEventId === eventId) {
    return reject("cycle_detected");
  }

  // Indirect cycle (parent's ancestry loops back to this event).
  if (ancestryReachesSelf(candidate, known.parentByEventId)) {
    return reject("cycle_detected");
  }

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
