/**
 * Review-event creation with causal lineage (DATA_MODEL.md §6,
 * OFFLINE_AND_SYNC.md §5). A review event is created ONLY for the first
 * scheduling-relevant attempt per component per session; within-session
 * reinforcement recoveries create NO event (PRODUCT_REQUIREMENTS.md §4.6/§5).
 *
 * Each event carries the lineage the server will later validate: a
 * client-generated `event_id`, `parent_event_id` (the preceding local
 * scheduling event — never a reinforcement attempt — or null for a chain root),
 * `base_server_revision` (guests: 0), a monotonic `client_component_revision`,
 * and the IMMUTABLE event-time date fields copied from the attempt. Phase 7 is
 * single-device sequential; concurrent-branch handling is Phase 19.
 *
 * Pure TypeScript: no React, DOM or DB imports.
 */
import type { AttemptRecord } from "@/modules/study-engine";

import { ratingForAttempt } from "@/modules/scheduler/ratings";
import type { SchedulerRating } from "@/modules/scheduler/fsrs";

/** Event lifecycle status (DATA_MODEL.md §6). Phase 7 creates only `scheduling`. */
export type ReviewEventStatus =
  | "scheduling"
  | "reinforcement"
  | "conflict_demoted"
  | "revoked"
  | "pending_parent";

/** A local review event (the causal-chain node; server-only fields excluded). */
export type ReviewEvent = {
  eventId: string;
  studyComponentId: string;
  attemptId: string;
  rating: SchedulerRating;
  status: ReviewEventStatus;
  /** Server revision known when the local chain began (guests: 0). */
  baseServerRevision: number;
  /** Preceding local scheduling event, or null for a chain root. */
  parentEventId: string | null;
  /** Monotonic within the client's local chain for this component. */
  clientComponentRevision: number;
  /** Monotonic per-device ordering aid. */
  clientSequence: number;
  /** As submitted, never altered. */
  occurredAtClient: string;
  deviceId: string;
  sessionId: string;
  releaseId: string;
  contentVersion: string;
  /** Immutable event-time date fields (copied from the attempt). */
  timezoneAtEvent: string;
  utcOffsetMinutesAtEvent: number;
  localDateAtEvent: string;
  timezoneSource: AttemptRecord["timezoneSource"];
};

/**
 * Does this attempt produce a scheduling event? Only the first attempt of a
 * component in a session is scheduling-relevant; reinforcement recoveries do
 * not (they are flagged `is_reinforcement` and are never a first attempt).
 */
export function shouldCreateEvent(
  attempt: Pick<AttemptRecord, "isFirstAttempt" | "isReinforcement">,
): boolean {
  return attempt.isFirstAttempt && !attempt.isReinforcement;
}

export type EventLineage = {
  /** Client-generated event id (UUIDv7 in production; injected, never minted). */
  eventId: string;
  parentEventId: string | null;
  baseServerRevision: number;
  clientComponentRevision: number;
  clientSequence: number;
};

/**
 * Derive the lineage for the NEXT event in a component's local chain from its
 * current head (or null for the first event). `client_component_revision` is
 * strictly monotonic; `base_server_revision` is inherited from the chain (it is
 * fixed when the chain begins) — guests start at 0.
 */
export function deriveLineage(
  head: ReviewEvent | null,
  ids: { eventId: string; clientSequence: number },
  initialBaseServerRevision = 0,
): EventLineage {
  return {
    eventId: ids.eventId,
    parentEventId: head?.eventId ?? null,
    baseServerRevision: head?.baseServerRevision ?? initialBaseServerRevision,
    clientComponentRevision: (head?.clientComponentRevision ?? 0) + 1,
    clientSequence: ids.clientSequence,
  };
}

/**
 * Build a `scheduling` review event from a scheduling-relevant attempt and its
 * derived lineage. Throws if the attempt is not scheduling-relevant (a
 * reinforcement recovery must never become an event).
 */
export function createReviewEvent(
  attempt: AttemptRecord,
  lineage: EventLineage,
): ReviewEvent {
  if (!shouldCreateEvent(attempt)) {
    throw new Error(
      `attempt ${attempt.id} is not scheduling-relevant (reinforcement recoveries create no event)`,
    );
  }
  if (
    !Number.isInteger(lineage.clientComponentRevision) ||
    lineage.clientComponentRevision < 1
  ) {
    throw new Error("client_component_revision must be a positive integer");
  }
  return {
    eventId: lineage.eventId,
    studyComponentId: attempt.studyComponentId,
    attemptId: attempt.id,
    rating: ratingForAttempt(attempt),
    status: "scheduling",
    baseServerRevision: lineage.baseServerRevision,
    parentEventId: lineage.parentEventId,
    clientComponentRevision: lineage.clientComponentRevision,
    clientSequence: lineage.clientSequence,
    occurredAtClient: attempt.occurredAtUtc,
    deviceId: attempt.deviceId,
    sessionId: attempt.sessionId,
    releaseId: attempt.releaseId,
    contentVersion: attempt.contentVersion,
    timezoneAtEvent: attempt.timezoneAtEvent,
    utcOffsetMinutesAtEvent: attempt.utcOffsetMinutesAtEvent,
    localDateAtEvent: attempt.localDateAtEvent,
    timezoneSource: attempt.timezoneSource,
  };
}
