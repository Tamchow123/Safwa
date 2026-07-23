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
 * Shared with the reinforcement-attempt enqueue path (study-session persistence).
 */
export function toWireAttempt(attempt: AttemptRecord): WireAttempt | null {
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
/**
 * Count the local scheduling events not yet accepted by the server — the
 * `syncStatus === "local"` review-events. This is the "pending changes" number
 * the status indicator surfaces (§20); it counts SENDABILITY candidates, matching
 * `selectUnsyncedScheduling`'s source rows (an event whose attempt is missing is
 * still pending — it is unsynced work, just not yet sendable). Unbounded count,
 * so it reflects the true backlog rather than a page-capped selection.
 *
 * ACCOUNT SCOPING (§18, EXT-F1): counts only events OWNED by the active account
 * — those whose linked attempt's `attempt.userId === userId`. Guest events
 * (attempt.userId === null) and any other account's leftover events are NOT
 * counted, so a guest's local history is never surfaced as this account's
 * pending work and login never implies a merge. `review_events` carry no userId
 * of their own, so ownership is read from the linked attempt payload; this makes
 * the count a scan + per-event attempt read rather than an indexed count, which
 * is acceptable for the modest Stage-A local backlog.
 */
export async function countPendingScheduling(
  db: SafwaDb,
  userId: string,
): Promise<number> {
  const local = await db.reviewEvents
    .where("syncStatus")
    .equals("local")
    .toArray();
  let count = 0;
  for (const ev of local) {
    if (!ev.attemptId) continue;
    const stored = await db.studyAttempts.get(ev.attemptId);
    if (stored?.attempt?.userId === userId) count += 1;
  }
  return count;
}

/**
 * Select up to `limit` unsynced scheduling events OWNED by `userId`, with their
 * attempts, ready to push. ACCOUNT OWNERSHIP (§18, EXT-F1): an event is included
 * only if its linked attempt's `attempt.userId === userId`. Guest events
 * (attempt.userId === null) and any leftover events belonging to a different
 * account are NEVER uploaded — logging in must not merge a guest's local history
 * (the Phase-17 merge flow is the only path that promotes guest rows). An event
 * whose attempt is missing/invalid is also skipped (the server grades an
 * objective event by reconstructing its attempt). Attempts are de-duplicated.
 */
export async function selectUnsyncedScheduling(
  db: SafwaDb,
  limit: number,
  userId: string,
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

    const stored = await db.studyAttempts.get(wireEvent.attemptId);
    // OWNERSHIP GATE: only this account's own events are sendable. A guest event
    // (attempt.userId === null) or another account's event is dropped, never
    // uploaded — no implicit guest merge on login (§18).
    if (!stored?.attempt || stored.attempt.userId !== userId) continue;

    if (!includedAttempts.has(wireEvent.attemptId)) {
      const wireAttempt = toWireAttempt(stored.attempt);
      if (!wireAttempt) continue; // event not sendable without a valid attempt
      attempts.push(wireAttempt);
      includedAttempts.add(wireEvent.attemptId);
    }
    events.push(wireEvent);
  }

  return { events, attempts };
}
