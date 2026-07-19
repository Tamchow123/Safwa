/**
 * Shared scheduler test fixtures: builders for Phase-6 attempt records and
 * Phase-7 review events with sensible defaults, so tests can focus on the
 * scheduling behaviour under test.
 */
import type { AttemptRecord } from "@/modules/study-engine";
import {
  createReviewEvent,
  deriveLineage,
  type ReviewEvent,
} from "@/modules/scheduler/events";
import {
  newCard,
  reviewCard,
  type FsrsState,
  type SchedulerCard,
  type SchedulerRating,
} from "@/modules/scheduler/fsrs";

let attemptCounter = 0;

/** A full attempt record with overridable fields (deterministic ids). */
export function makeAttempt(
  overrides: Partial<AttemptRecord> = {},
): AttemptRecord {
  attemptCounter += 1;
  const occurredAtUtc = overrides.occurredAtUtc ?? "2026-07-17T09:30:00.000Z";
  return {
    id: `attempt-${attemptCounter}`,
    sessionId: "session-1",
    userId: null,
    deviceId: "device-1",
    studyComponentId: "entry:1:skill:bab_identification",
    entryId: 1,
    skillTypeId: "bab_identification",
    sourceField: null,
    direction: null,
    promptField: "madi",
    promptRef: { entryId: 1, field: "madi" },
    selectedAnswerRef: { entryId: 1, field: "bab" },
    correctAnswerRef: { entryId: 1, field: "bab" },
    isCorrect: true,
    isFirstAttempt: true,
    isReinforcement: false,
    hintUsed: false,
    hintType: null,
    responseTimeMs: 1000,
    questionPosition: 0,
    mode: "mc",
    optionCount: 4,
    perQuestionLimitMs: null,
    questionInstanceId: "qid-1",
    questionSeed: "seed-1",
    questionGeneratorVersion: "1",
    releaseId: "safwa-2.2.0-0000000000000000",
    contentVersion: "2.2.0",
    occurredAtUtc,
    timezoneAtEvent: "Asia/Karachi",
    utcOffsetMinutesAtEvent: 300,
    localDateAtEvent: "2026-07-17",
    timezoneSource: "user_setting",
    ...overrides,
  };
}

/**
 * Build a sequential chain of scheduling events from a list of specs. Each spec
 * gives the attempt fields for one scheduling-relevant attempt; lineage is
 * derived from the running head so revisions are monotonic and parents linked.
 */
export function buildChain(specs: Partial<AttemptRecord>[]): ReviewEvent[] {
  const events: ReviewEvent[] = [];
  let head: ReviewEvent | null = null;
  let sequence = 0;
  for (const spec of specs) {
    sequence += 1;
    const attempt = makeAttempt({
      isFirstAttempt: true,
      isReinforcement: false,
      ...spec,
    });
    const lineage = deriveLineage(head, {
      eventId: `event-${sequence}`,
      clientSequence: sequence,
    });
    const event = createReviewEvent(attempt, lineage);
    events.push(event);
    head = event;
  }
  return events;
}

/** Attempt fields that produce a given rating (scheduler never yields Easy). */
function attemptFieldsFor(rating: SchedulerRating): Partial<AttemptRecord> {
  if (rating === "again") return { isCorrect: false, hintUsed: false };
  if (rating === "hard") return { isCorrect: true, hintUsed: true };
  return { isCorrect: true, hintUsed: false }; // good
}

/**
 * Build a chain where each review happens at the previous card's due instant
 * (natural progression), so the card advances New → Learning → Review through
 * ts-fsrs. `dateFor(index, preStateBeforeThisReview)` assigns each event's
 * `local_date_at_event`, letting mastery tests control dates independently of
 * the FSRS timing. Returns the events and the per-event pre-review states.
 */
export function buildNaturalChain(
  ratings: SchedulerRating[],
  startMs: number,
  dateFor: (index: number, preState: FsrsState) => string,
): { events: ReviewEvent[]; preStates: FsrsState[]; finalCard: SchedulerCard } {
  const events: ReviewEvent[] = [];
  const preStates: FsrsState[] = [];
  let head: ReviewEvent | null = null;
  let card = newCard(startMs);
  let nowMs = startMs;

  ratings.forEach((rating, index) => {
    const preState = card.state;
    preStates.push(preState);
    const attempt = makeAttempt({
      isFirstAttempt: true,
      isReinforcement: false,
      occurredAtUtc: new Date(nowMs).toISOString(),
      localDateAtEvent: dateFor(index, preState),
      ...attemptFieldsFor(rating),
    });
    const lineage = deriveLineage(head, {
      eventId: `ev-${index + 1}`,
      clientSequence: index + 1,
    });
    const event = createReviewEvent(attempt, lineage);
    events.push(event);
    head = event;
    card = reviewCard(card, nowMs, rating);
    nowMs = card.dueAtMs;
  });

  // `card` here is the INDEPENDENT ts-fsrs-driven reference (built by directly
  // calling reviewCard step by step), used as the golden target for replay.
  return { events, preStates, finalCard: card };
}
