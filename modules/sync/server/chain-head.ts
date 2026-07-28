/**
 * Phase 17 §14 — which accepted event is a component's HEAD, on the server.
 *
 * Its own module, and pure, so the rule can be tested directly. Inline in
 * `ingest.ts` it was only reachable through a Postgres transaction, and the case
 * that motivates it cannot be constructed at all until the merge coordinator
 * exists.
 *
 * WHICH RULE APPLIES DEPENDS ON THE SHAPE OF THE CHAIN, and getting that wrong
 * in either direction breaks something:
 *
 * - A **single-rooted** component — every component that has never been merged,
 *   which is all of them today — keeps the Phase-16 rule: the head is the event
 *   with the HIGHEST revision. Revisions are contiguous and structural, so this
 *   is the true tip of the chain regardless of what the clocks said. Switching
 *   these to a time-based rule would be an active regression: a child held as
 *   `pending_parent` and promoted later keeps the canonical time it was stamped
 *   with while still pending, so after an out-of-order delivery the true tip can
 *   carry an EARLIER canonical time than its own parent. A chronological rule
 *   would then name the parent as head, the client's next event (parented on the
 *   real tip) would be rejected as a stale branch, and — because the stored
 *   canonical times never change on retry — the component would be stuck for
 *   good. That is a live Phase-16 path, needing only ordinary clock drift.
 *
 * - A **multi-rooted** component — the merge union, and only the merge union —
 *   uses the chronological rule, because the two histories each number their
 *   revisions from 1 and "highest revision" would name whichever chain was
 *   longer rather than whichever event happened last. The client derives its
 *   next event's lineage from the chronological head, so a server disagreeing
 *   here has the same silent-stall consequence, in the other direction.
 *
 * The ordering itself is NOT redefined here: `compareChainOrder` in
 * `modules/scheduler/chain.ts` is the one implementation, and this module calls
 * it. The client picks a parent with that order and the server decides whether
 * that parent is the head, so a second transcription of the rule could drift and
 * reopen exactly the bug this module exists to close.
 */
import { compareChainOrder, isChainRoot } from "@/modules/scheduler";

/** An accepted event, reduced to what head selection needs. */
export type HeadCandidate = {
  eventId: string;
  clientComponentRevision: number;
  canonicalMs: number;
  parentEventId: string | null;
};

/** The current head, or `null` when no event has been accepted yet. */
export type CurrentHead = HeadCandidate | null;

function orderKeyOf(candidate: HeadCandidate) {
  return {
    instantMs: candidate.canonicalMs,
    revision: candidate.clientComponentRevision,
    eventId: candidate.eventId,
  };
}

/**
 * True when `candidate` is later than `head` under the shared canonical order.
 * Used only for a multi-rooted (merged) component — see the module note.
 */
export function isLaterHead(
  candidate: HeadCandidate,
  head: CurrentHead,
): boolean {
  if (head === null) return true;
  return compareChainOrder(orderKeyOf(candidate), orderKeyOf(head)) > 0;
}

/**
 * How many distinct chains the accepted events form. One root is an ordinary
 * chain; more than one means two histories were merged into this component.
 *
 * What counts as a root is `isChainRoot` from `modules/scheduler/chain.ts` — the
 * same predicate the client partitions by, imported rather than restated for the
 * same reason as the comparator: this classification picks WHICH head rule
 * applies, so a copy that drifted from the client's would reopen the stuck-
 * component bug through the classifier instead of the ordering.
 */
export function countChainRoots(candidates: readonly HeadCandidate[]): number {
  const acceptedIds = new Set(candidates.map((c) => c.eventId));
  let roots = 0;
  for (const candidate of candidates) {
    if (isChainRoot(candidate.parentEventId, acceptedIds)) roots += 1;
  }
  return roots;
}

/**
 * The head of a set of accepted events, or `null` if the set is empty. Picks the
 * rule from the chain's shape (see the module note); the result never depends on
 * the order the rows arrived in.
 */
export function selectHead(
  candidates: readonly HeadCandidate[],
): HeadCandidate | null {
  if (candidates.length === 0) return null;

  if (countChainRoots(candidates) <= 1) {
    // Ordinary chain: the structural tip, exactly as Phase 16 chose it.
    let head: CurrentHead = null;
    for (const candidate of candidates) {
      if (
        head === null ||
        candidate.clientComponentRevision > head.clientComponentRevision
      ) {
        head = candidate;
      }
    }
    return head;
  }

  let head: CurrentHead = null;
  for (const candidate of candidates) {
    if (isLaterHead(candidate, head)) head = candidate;
  }
  return head;
}
