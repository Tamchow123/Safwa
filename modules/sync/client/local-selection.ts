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
import { accountOwnerKey } from "@/modules/content/owner-key";
import type { AttemptRecord } from "@/modules/study-engine/attempts";
import {
  wireAttemptSchema,
  wireEventSchema,
  type WireAttempt,
  type WireEvent,
} from "@/modules/sync/protocol";

import { countPendingMutations } from "./mutation-queue";

export type SchedulingSelection = {
  events: WireEvent[];
  attempts: WireAttempt[];
};

/**
 * Map a stored review event to the wire shape, or null if it fails validation.
 * Shared with the Phase-17 guest-snapshot selection (`guest-snapshot.ts`), which
 * has to produce byte-identical wire events — the merge and ordinary sync reach
 * the same server ingestion contract, so a second mapper could drift.
 */
export function toWireEvent(record: ReviewEventRecord): WireEvent | null {
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
 * Count THIS account's unsynced scheduling events — the `syncStatus === "local"`
 * review-events it owns (§20 pending badge). Review events carry their own
 * `ownerKey`, so this is a single owner-scoped INDEXED count over
 * `[ownerKey+syncStatus]` — no attempt-join, and no scan cap. A guest's (or
 * another account's) local backlog is simply not in this account's index slice,
 * so it can neither inflate the badge nor starve/undercount this account's true
 * backlog behind a cap (the EXT-F1 join is retired).
 */
export async function countPendingScheduling(
  db: SafwaDb,
  userId: string,
): Promise<number> {
  return db.reviewEvents
    .where("[ownerKey+syncStatus]")
    .equals([accountOwnerKey(userId), "local"])
    .count();
}

/**
 * The account's total pending-change count for the §20 status badge: the
 * scheduling backlog PLUS the outstanding queued mutations (bookmarks, lists,
 * settings, revocations, reinforcement attempts — EXT-F2), so the indicator
 * reflects ALL unsynced work, not only scheduling events. Both halves are
 * account-scoped (EXT-F1); dead-lettered mutations are excluded (surfaced as
 * attention separately). This is the `countPending` the sync controller uses.
 */
export async function countPendingChanges(
  db: SafwaDb,
  userId: string,
): Promise<number> {
  const [scheduling, mutations] = await Promise.all([
    countPendingScheduling(db, userId),
    countPendingMutations(db, userId),
  ]);
  return scheduling + mutations;
}

/**
 * Select up to `limit` unsynced scheduling events OWNED by `userId`, with their
 * attempts, ready to push. ACCOUNT OWNERSHIP (§18, EXT-F1): an event is included
 * only if it is keyed to THIS account's owner. A guest's events are keyed to the
 * guest owner and any leftover events belonging to a different account to
 * theirs, so neither is ever uploaded — logging in must not merge a guest's
 * local history (the Phase-17 merge flow is the only path that promotes guest
 * rows). An event whose attempt is missing/invalid is also skipped (the server
 * grades an objective event by reconstructing its attempt). Attempts are
 * de-duplicated.
 */
export async function selectUnsyncedScheduling(
  db: SafwaDb,
  limit: number,
  userId: string,
): Promise<SchedulingSelection> {
  // Owner-scoped selection: the `[ownerKey+syncStatus]` index yields ONLY this
  // account's unsynced events, so the `limit` page can never be starved by a
  // guest's (or another account's) local backlog sitting AHEAD of it in an
  // unscoped `syncStatus`-only scan (the EXT-F1/-F3 starvation the old `.limit`
  // before the ownership filter allowed). A guest's events are keyed to the
  // GUEST owner, so ordinary sync can never select them: they reach the server
  // only through the explicit Phase-17 merge (§18, phases-17.md §9.1).
  const localEvents = await db.reviewEvents
    .where("[ownerKey+syncStatus]")
    .equals([accountOwnerKey(userId), "local"])
    .limit(limit)
    .toArray();

  const events: WireEvent[] = [];
  const attempts: WireAttempt[] = [];
  const includedAttempts = new Set<string>();

  for (const record of localEvents) {
    const wireEvent = toWireEvent(record);
    if (!wireEvent) continue;
    // The index already scoped ownership; we still load the stored attempt to
    // build the wire payload (the server grades an objective event by
    // reconstructing its attempt) and drop the event if it is missing/invalid.
    const stored = await db.studyAttempts.get(wireEvent.attemptId);
    if (!stored?.attempt) continue;

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
