/**
 * Phase 16 — local selection of unsynced scheduling changes (§18). Reads the
 * Dexie `review_events` rows still marked `syncStatus === "local"` (plus each
 * one's stored attempt) and maps them to the wire push shapes. Every candidate
 * is validated against the pure wire schema and any record that fails is
 * DROPPED, not sent — a single malformed local record must never break a whole
 * push. Browser-only (Dexie); the mapping/validation itself is pure.
 *
 * Reinforcement-only attempts (no scheduling event) and collection/settings
 * selection are handled by later pieces of the client module; this covers the
 * scheduling attempts + events that drive FSRS.
 */
import type { ReviewEventRecord, SafwaDb } from "@/modules/content/db";
import type { AttemptRecord } from "@/modules/study-engine/attempts";
import {
  wireAttemptSchema,
  wireEventSchema,
  type WireAttempt,
  type WireEvent,
} from "@/modules/sync/protocol";

export type SchedulingSelection = {
  events: WireEvent[];
  attempts: WireAttempt[];
};

/** Map a stored review event to the wire shape, or null if it fails validation. */
function toWireEvent(record: ReviewEventRecord): WireEvent | null {
  const parsed = wireEventSchema.safeParse({
    eventId: record.eventId,
    studyComponentId: record.componentKey,
    attemptId: record.attemptId,
    rating: record.rating,
    status: record.status,
    baseServerRevision: record.baseServerRevision,
    parentEventId: record.parentEventId,
    clientComponentRevision: record.clientComponentRevision,
    clientSequence: record.clientSequence,
    occurredAtClient: record.occurredAtClient,
    deviceId: record.deviceId,
    sessionId: record.sessionId,
    releaseId: record.releaseId,
    contentVersion: record.contentVersion,
    timezoneAtEvent: record.timezoneAtEvent,
    utcOffsetMinutesAtEvent: record.utcOffsetMinutesAtEvent,
    localDateAtEvent: record.localDateAtEvent,
    timezoneSource: record.timezoneSource,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Map a stored attempt to the wire shape (explicitly, dropping the local-only
 * `userId` the server derives from the session), or null if it fails validation.
 */
function toWireAttempt(attempt: AttemptRecord): WireAttempt | null {
  const parsed = wireAttemptSchema.safeParse({
    id: attempt.id,
    sessionId: attempt.sessionId,
    deviceId: attempt.deviceId,
    studyComponentId: attempt.studyComponentId,
    entryId: attempt.entryId,
    skillTypeId: attempt.skillTypeId,
    sourceField: attempt.sourceField,
    direction: attempt.direction,
    promptField: attempt.promptField,
    promptRef: attempt.promptRef,
    selectedAnswerRef: attempt.selectedAnswerRef,
    correctAnswerRef: attempt.correctAnswerRef,
    isCorrect: attempt.isCorrect,
    isFirstAttempt: attempt.isFirstAttempt,
    isReinforcement: attempt.isReinforcement,
    hintUsed: attempt.hintUsed,
    hintType: attempt.hintType,
    responseTimeMs: attempt.responseTimeMs,
    questionPosition: attempt.questionPosition,
    mode: attempt.mode,
    optionCount: attempt.optionCount,
    perQuestionLimitMs: attempt.perQuestionLimitMs,
    questionInstanceId: attempt.questionInstanceId,
    questionSeed: attempt.questionSeed,
    questionGeneratorVersion: attempt.questionGeneratorVersion,
    releaseId: attempt.releaseId,
    contentVersion: attempt.contentVersion,
    occurredAtUtc: attempt.occurredAtUtc,
    timezoneAtEvent: attempt.timezoneAtEvent,
    utcOffsetMinutesAtEvent: attempt.utcOffsetMinutesAtEvent,
    localDateAtEvent: attempt.localDateAtEvent,
    timezoneSource: attempt.timezoneSource,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Select up to `limit` unsynced scheduling events with their attempts, ready to
 * push. An event is INCLUDED only if both it and its linked attempt validate —
 * the server grades an objective event by reconstructing its attempt, so an
 * event whose attempt is missing/invalid is not sendable and is skipped (it
 * stays `local` for a later, repaired attempt). Attempts are de-duplicated (two
 * events could reference one attempt in principle).
 */
export async function selectUnsyncedScheduling(
  db: SafwaDb,
  limit: number,
): Promise<SchedulingSelection> {
  const localEvents = await db.reviewEvents
    .where("syncStatus")
    .equals("local")
    .limit(limit)
    .toArray();

  const events: WireEvent[] = [];
  const attempts: WireAttempt[] = [];
  const includedAttempts = new Set<string>();

  for (const record of localEvents) {
    const wireEvent = toWireEvent(record);
    if (!wireEvent) continue;

    // The event must carry a valid, sendable attempt (already selected or freshly loaded).
    if (!includedAttempts.has(wireEvent.attemptId)) {
      const stored = await db.studyAttempts.get(wireEvent.attemptId);
      const wireAttempt = stored?.attempt
        ? toWireAttempt(stored.attempt)
        : null;
      if (!wireAttempt) continue; // event not sendable without its attempt
      attempts.push(wireAttempt);
      includedAttempts.add(wireEvent.attemptId);
    }
    events.push(wireEvent);
  }

  return { events, attempts };
}
