/**
 * The local causal event chain and its deterministic FSRS replay
 * (DATA_MODEL.md §8, OFFLINE_AND_SYNC.md §5). Phase 7 chains are SEQUENTIAL and
 * single-device: each scheduling event's parent is the preceding local
 * scheduling event (or null for the root). Replaying the accepted `scheduling`
 * events in causal order reproduces the component's FSRS card state
 * bit-for-bit. Concurrent-branch detection / conflict demotion is Phase 19.
 *
 * Pure TypeScript: no React, DOM or DB imports.
 */
import type { ReviewEvent } from "@/modules/scheduler/events";
import {
  isDue,
  newCard,
  reviewCard,
  type SchedulerCard,
} from "@/modules/scheduler/fsrs";

export class ChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainError";
  }
}

/** Epoch-ms instant of an event (parsed from its immutable client timestamp). */
function eventInstantMs(event: ReviewEvent): number {
  const ms = Date.parse(event.occurredAtClient);
  if (Number.isNaN(ms)) {
    throw new ChainError(
      `event ${event.eventId} has an unparseable occurred_at ${JSON.stringify(event.occurredAtClient)}`,
    );
  }
  return ms;
}

/**
 * Order the accepted `scheduling` events of ONE component into causal order and
 * validate the sequential-chain invariants: strictly increasing, contiguous
 * `client_component_revision`s starting at 1, the root's parent is null, and
 * every other event's parent is its immediate predecessor. A branch (two events
 * sharing a parent) is rejected as out-of-scope for Phase 7 (Phase 19).
 */
export function orderCausally(events: readonly ReviewEvent[]): ReviewEvent[] {
  const scheduling = events.filter((event) => event.status === "scheduling");
  if (scheduling.length === 0) return [];

  const ordered = [...scheduling].sort(
    (a, b) => a.clientComponentRevision - b.clientComponentRevision,
  );

  const seenRevisions = new Set<number>();
  for (let i = 0; i < ordered.length; i++) {
    const event = ordered[i];
    if (seenRevisions.has(event.clientComponentRevision)) {
      throw new ChainError(
        `duplicate client_component_revision ${event.clientComponentRevision} (concurrent branches are Phase 19)`,
      );
    }
    seenRevisions.add(event.clientComponentRevision);

    if (event.clientComponentRevision !== i + 1) {
      throw new ChainError(
        `non-contiguous chain: expected revision ${i + 1}, got ${event.clientComponentRevision}`,
      );
    }
    const expectedParent = i === 0 ? null : ordered[i - 1].eventId;
    if (event.parentEventId !== expectedParent) {
      throw new ChainError(
        `broken causal link at revision ${event.clientComponentRevision}: parent ${JSON.stringify(event.parentEventId)} != ${JSON.stringify(expectedParent)}`,
      );
    }
  }
  return ordered;
}

export type ChainReplay = {
  /** Final FSRS card, or null when there are no scheduling events. */
  card: SchedulerCard | null;
  /**
   * Distinct stored `local_date_at_event` values of accepted authoritative
   * Good/Easy reviews taken while the card was already in the FSRS Review state
   * AND actually due (a genuine due review — an ahead-of-schedule review does
   * not qualify). Hard never advances; the initial learning review is excluded
   * because the card is not yet in Review. Sorted ascending.
   */
  masteryDates: string[];
  /** Whether any review was a clean success (rating ≠ Again) — gates Learning. */
  hasCleanSuccess: boolean;
  scheduledEventCount: number;
  headEventId: string | null;
  headRevision: number;
};

/**
 * Replay a component's accepted scheduling events, producing the final card and
 * the distinct qualifying mastery dates. Deterministic: each review is applied
 * at its own immutable event instant.
 */
export function replayChain(events: readonly ReviewEvent[]): ChainReplay {
  const ordered = orderCausally(events);
  if (ordered.length === 0) {
    return {
      card: null,
      masteryDates: [],
      hasCleanSuccess: false,
      scheduledEventCount: 0,
      headEventId: null,
      headRevision: 0,
    };
  }

  let card = newCard(eventInstantMs(ordered[0]));
  const masteryDates = new Set<string>();
  let hasCleanSuccess = false;

  for (const event of ordered) {
    const instant = eventInstantMs(event);
    // Mastery qualifies only for Good/Easy taken while ALREADY in the Review
    // state AND actually due at review time (a genuine due review) — evaluated
    // BEFORE the rating is applied.
    if (
      card.state === "review" &&
      isDue(card, instant) &&
      (event.rating === "good" || event.rating === "easy")
    ) {
      masteryDates.add(event.localDateAtEvent);
    }
    if (event.rating !== "again") hasCleanSuccess = true;
    card = reviewCard(card, instant, event.rating);
  }

  const head = ordered[ordered.length - 1];
  return {
    card,
    masteryDates: [...masteryDates].sort(),
    hasCleanSuccess,
    scheduledEventCount: ordered.length,
    headEventId: head.eventId,
    headRevision: head.clientComponentRevision,
  };
}

/** The current chain head (highest-revision scheduling event), or null. */
export function chainHead(events: readonly ReviewEvent[]): ReviewEvent | null {
  const ordered = orderCausally(events);
  return ordered.length === 0 ? null : ordered[ordered.length - 1];
}

export type UndoResult = {
  /** The chain without its head event. */
  events: ReviewEvent[];
  /** The removed head event — the caller deletes its `attemptId` too. */
  removedEvent: ReviewEvent;
  /** The card state restored by re-replaying the remaining chain. */
  restoredCard: SchedulerCard | null;
};

/**
 * Undo the last local scheduling event (pre-sync). Returns the chain without
 * its head, the removed event (so the caller deletes the corresponding
 * ATTEMPT — the attempt store is impure, outside this module), and the card
 * restored by re-replaying the remaining chain (single-step).
 */
export function undoLastEvent(events: readonly ReviewEvent[]): UndoResult {
  const ordered = orderCausally(events);
  if (ordered.length === 0) {
    throw new ChainError("nothing to undo: no scheduling events");
  }
  const removedEvent = ordered[ordered.length - 1];
  const remaining = events.filter(
    (event) => event.eventId !== removedEvent.eventId,
  );
  return {
    events: remaining,
    removedEvent,
    restoredCard: replayChain(remaining).card,
  };
}
