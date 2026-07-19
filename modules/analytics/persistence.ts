/**
 * Analytics persistence adapter (impure, BROWSER-ONLY) — the thin Dexie
 * wiring between the pure analytics modules and the local learner stores
 * (Phase 12 §14–15). Mirrors modules/study-session/persistence.ts: the pure
 * modules never import Dexie; this is the ONE place analytics rows are read
 * and `writeDailyActivityCache` below is the ONE writer of the
 * `daily_activity` derived cache.
 *
 * AUTHORITY MODEL (§14.2): `study_attempts` + `review_events` remain the
 * learner truth. `daily_activity` is a REBUILDABLE cache — every read path
 * here re-derives it from the raw stores before surfacing anything, so a
 * stale, missing, corrupted or hand-edited cache row can never survive into
 * what the learner sees, and deleting the cache loses nothing.
 *
 * TRANSACTION SHAPE (§14.3): reads run in a short read-only transaction (so
 * a concurrent grading write in another tab is never blocked behind an
 * analytics scan — see recordGradedAttempt's overlapping store set), the
 * pure derivation runs outside any transaction, and the cache rewrite runs
 * in a NARROW read-write transaction over `daily_activity` alone. The
 * clear + rewrite still commit or roll back together, so a crash can never
 * leave a partially rebuilt cache. A write landing in the tiny window
 * between the read and the rewrite can make the persisted rows trail the
 * returned snapshot by that one write — harmless by design, because the
 * cache is authoritative for nothing and the next rebuild self-heals.
 *
 * The clock instant is INJECTED by the caller — this adapter never invents
 * time. Tests use fake-indexeddb.
 */
import type {
  DailyActivityRecord,
  ReviewEventRecord,
  SafwaDb,
  StudyAttemptRecord,
  StudyComponentRecord,
} from "@/modules/content/db";

import {
  deriveDailyActivity,
  type AnalyticsAttempt,
  type AnalyticsEvent,
  type DailyActivity,
} from "@/modules/analytics/activity";
import type { ProgressComponentState } from "@/modules/analytics/progress";

/** The one consistent read the dashboard/progress pages consume (§15). */
export type AnalyticsPersistenceSnapshot = {
  components: ProgressComponentState[];
  attempts: AnalyticsAttempt[];
  events: AnalyticsEvent[];
  /** The freshly REBUILT daily activity (never a stale cache read). */
  dailyActivity: DailyActivity[];
};

function componentSlice(record: StudyComponentRecord): ProgressComponentState {
  return {
    componentKey: record.componentKey,
    fsrs: record.fsrs,
    learnerState: record.learnerState,
  };
}

/**
 * Map one stored attempt row to its analytics slice. A row without the
 * embedded full attempt payload (pre-Phase-8 shape; none exist in practice)
 * maps to an intentionally-invalid slice (NaN response time) so the pure
 * validity gate excludes it — corrupted legacy rows never become activity.
 */
function attemptSlice(row: StudyAttemptRecord): AnalyticsAttempt {
  return {
    id: row.id,
    componentKey: row.componentKey,
    localDateAtEvent: row.attempt?.localDateAtEvent ?? null,
    responseTimeMs: row.attempt?.responseTimeMs ?? Number.NaN,
  };
}

/** Map one stored review-event row to its analytics slice. */
function eventSlice(record: ReviewEventRecord): AnalyticsEvent {
  return {
    eventId: record.eventId,
    attemptId: record.attemptId ?? null,
    // Passed through UNMAPPED: undefined marks a corrupt row the shared
    // classifier refuses to count (never coerced to a chain root).
    parentEventId: record.parentEventId,
    status: record.status ?? null,
    syncStatus: record.syncStatus ?? null,
    localDateAtEvent: record.localDateAtEvent ?? null,
  };
}

/**
 * THE one writer of the `daily_activity` cache: clear + complete rewrite in
 * a single read-write transaction scoped to the cache store alone, so the
 * replacement is atomic (a failure rolls back to the previous cache) and no
 * lock is ever held on the raw stores grading writes to.
 */
async function writeDailyActivityCache(
  db: SafwaDb,
  derived: readonly DailyActivity[],
  now: number,
): Promise<void> {
  await db.transaction("rw", [db.dailyActivity], async () => {
    await db.dailyActivity.clear();
    await db.dailyActivity.bulkPut(
      derived.map((row): DailyActivityRecord => ({ ...row, derivedAt: now })),
    );
  });
}

/**
 * Atomically rebuild the `daily_activity` cache from the raw stores and
 * return the derived rows (§14.3): read-only scan, pure derivation, then
 * the atomic cache rewrite. The raw attempt/event rows are never modified.
 */
export async function rebuildDailyActivity(
  db: SafwaDb,
  now: number,
): Promise<DailyActivity[]> {
  const { attempts, events } = await db.transaction(
    "r",
    [db.studyAttempts, db.reviewEvents],
    async () => ({
      attempts: (await db.studyAttempts.toArray()).map(attemptSlice),
      events: (await db.reviewEvents.toArray()).map(eventSlice),
    }),
  );
  const derived = deriveDailyActivity(attempts, events);
  await writeDailyActivityCache(db, derived, now);
  return derived;
}

/**
 * Read the complete analytics snapshot (§15): component scheduling state and
 * attempt/event slices from ONE consistent read-only transaction, the daily
 * activity derived from that same read, and the cache refreshed through the
 * one shared writer (§14.4 — a dashboard load right after a study session
 * shows current values, and a corrupt cache row is never trusted because it
 * is always rewritten from the raw truth here).
 */
export async function readAnalyticsSnapshot(
  db: SafwaDb,
  now: number,
): Promise<AnalyticsPersistenceSnapshot> {
  const { components, attempts, events } = await db.transaction(
    "r",
    [db.studyComponents, db.studyAttempts, db.reviewEvents],
    async () => ({
      components: (await db.studyComponents.toArray()).map(componentSlice),
      attempts: (await db.studyAttempts.toArray()).map(attemptSlice),
      events: (await db.reviewEvents.toArray()).map(eventSlice),
    }),
  );
  const dailyActivity = deriveDailyActivity(attempts, events);
  await writeDailyActivityCache(db, dailyActivity, now);
  return { components, attempts, events, dailyActivity };
}
