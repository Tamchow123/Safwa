/**
 * Phase 16 — deterministic server replay (§15). Reconstructs a component's
 * AUTHORITATIVE FSRS + learner state purely by replaying its accepted
 * scheduling events in causal order through the SHARED scheduler
 * (`projectComponent`) — never a parallel server implementation.
 *
 * The server is authoritative on TIME: each event is replayed at its
 * `occurred_at_canonical` (mapped into the scheduler event's `occurredAtClient`
 * slot), not the raw client instant, and at its canonical `local_date_at_event`
 * for mastery-day counting. Replay is a pure function of the accepted event set
 * — the same set always yields the same state (the replay invariant, §15).
 *
 * PURE: no clock (nowMs is injected), no randomness, no DB/server-only imports.
 */
import {
  type FsrsState,
  type LearnerState,
  projectComponent,
  type ReviewEvent,
  type ReviewEventStatus,
  type SchedulerCard,
  type SchedulerRating,
} from "@/modules/scheduler";

/**
 * A component event for replay. The caller supplies the component's events and
 * this module drives them through the scheduler, which filters to
 * `status === "scheduling"` (`orderCausally`) — so a query that accidentally
 * leaks a revoked/pending/reinforcement row is EXCLUDED rather than silently
 * folded into the chain. Causal ordering is by `clientComponentRevision`.
 */
export type ComponentReplayEvent = {
  eventId: string;
  /** Real lifecycle status — passed through so the scheduler's filter stays live. */
  status: ReviewEventStatus;
  rating: SchedulerRating;
  clientComponentRevision: number;
  parentEventId: string | null;
  /** Authoritative event instant (occurred_at_canonical). */
  occurredAtCanonical: Date;
  /** Authoritative local calendar date (canonical) for mastery-day counting. */
  localDateAtEvent: string;
};

/** Authoritative component state to persist into `study_components`. */
export type AuthoritativeComponentState = {
  stability: number | null;
  difficulty: number | null;
  dueAt: Date | null;
  fsrsState: FsrsState | null;
  reps: number;
  lapses: number;
  lastReviewAt: Date | null;
  /**
   * Learner state as of `nowMs`. This is a SNAPSHOT: it depends on whether the
   * card is due at replay time, so a persisted `mastered` can become
   * `needs_review` purely from time passing. Consumers must correct it live on
   * read via the scheduler's `effectiveLearnerState(stored, card, nowMs)` (the
   * same pattern the client already uses) — the stored value is the base, not
   * the final truth. The FSRS card fields ARE a pure function of the event set.
   */
  learnerState: LearnerState;
  masteryDates: string[];
  scheduledEventCount: number;
};

/**
 * Map a canonical accepted event to the scheduler's `ReviewEvent`, placing the
 * CANONICAL instant into `occurredAtClient` so replay uses authoritative time.
 * Fields the replay does not read are filled with inert placeholders.
 */
function toSchedulerEvent(event: ComponentReplayEvent): ReviewEvent {
  return {
    eventId: event.eventId,
    studyComponentId: "",
    attemptId: "",
    rating: event.rating,
    // Pass the REAL status so orderCausally's `status === "scheduling"` filter
    // remains a live safety net against a non-scheduling row leaking in.
    status: event.status,
    baseServerRevision: 0,
    parentEventId: event.parentEventId,
    clientComponentRevision: event.clientComponentRevision,
    clientSequence: 0,
    // The scheduler reads `occurredAtClient` as the event instant; for server
    // replay that is the canonical time, not the raw client claim.
    occurredAtClient: event.occurredAtCanonical.toISOString(),
    deviceId: "",
    sessionId: "",
    releaseId: "",
    contentVersion: "",
    timezoneAtEvent: "",
    utcOffsetMinutesAtEvent: 0,
    localDateAtEvent: event.localDateAtEvent,
    timezoneSource: "server_fallback",
  };
}

function cardFields(card: SchedulerCard | null): {
  stability: number | null;
  difficulty: number | null;
  dueAt: Date | null;
  fsrsState: FsrsState | null;
  reps: number;
  lapses: number;
  lastReviewAt: Date | null;
} {
  if (card === null) {
    return {
      stability: null,
      difficulty: null,
      dueAt: null,
      fsrsState: null,
      reps: 0,
      lapses: 0,
      lastReviewAt: null,
    };
  }
  return {
    stability: card.stability,
    difficulty: card.difficulty,
    dueAt: new Date(card.dueAtMs),
    fsrsState: card.state,
    reps: card.reps,
    lapses: card.lapses,
    lastReviewAt:
      card.lastReviewAtMs === null ? null : new Date(card.lastReviewAtMs),
  };
}

/**
 * Replay a component's accepted scheduling events into its authoritative state.
 * Deterministic: identical event sets yield identical state (the §15 replay
 * invariant that a fresh replay must equal the persisted state).
 */
export function replayComponent(
  events: readonly ComponentReplayEvent[],
  nowMs: number,
): AuthoritativeComponentState {
  const projection = projectComponent(events.map(toSchedulerEvent), nowMs);
  return {
    ...cardFields(projection.card),
    learnerState: projection.state,
    masteryDates: projection.masteryDates,
    scheduledEventCount: projection.scheduledEventCount,
  };
}
