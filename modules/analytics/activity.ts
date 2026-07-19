/**
 * Pure daily-activity derivation (Phase 12 §8) — the authoritative formula
 * behind the rebuildable Dexie `daily_activity` cache. Raw stored attempts and
 * review events remain the learner truth; this module only derives from them.
 *
 * HONESTY RULES (§8.1–8.6):
 *  - Every VALID submitted answer counts as an attempt — correct, incorrect,
 *    hinted, reinforcement, timed expiry and flashcard self-ratings alike.
 *  - Study time is the sum of valid attempts' `responseTimeMs` (active
 *    question-response time, never wall-clock app-open time).
 *  - An attempt is excluded only when its stored record cannot support honest
 *    analytics (unreadable date, non-finite/negative response time, unusable
 *    ids) or its linked event was revoked / sync-rejected.
 *  - A conflict-demoted scheduling event never counts as a new/review, but
 *    its underlying attempt still counts as study activity — the learning
 *    effort occurred.
 *  - New items and reviews come ONLY from scheduling-authoritative events via
 *    the ONE shared classifier (`classifySchedulingEvent`), so this agrees
 *    with the Phase 10 daily-target accounting by construction.
 *  - Grouping keys on each record's IMMUTABLE stored `local_date_at_event`;
 *    historical dates are never recomputed under the current timezone.
 *
 * Pure TypeScript: no React, Dexie, DOM or ambient clocks.
 */
import type {
  AnswerField,
  Direction,
  SkillType,
  SourceQuizFormField,
} from "@/modules/content/constants";
import { classifySchedulingEvent } from "@/modules/scheduler/events";

import { isIsoDate } from "@/modules/analytics/dates";

/** One derived local-date activity row (the cache adds `derivedAt`). */
export type DailyActivity = {
  localDate: string;
  attempts: number;
  reviews: number;
  newItems: number;
  studyMs: number;
};

/** The slice of one stored attempt the derivation consumes. The field name
 * matches the canonical stored `localDateAtEvent` everywhere else a stored
 * record is sliced (ReviewEvent, AttemptRecord, SchedulingEventSummary).
 *
 * The fields below `responseTimeMs` are additive (Phase 13 §7–9): the ONE
 * attempt slice every analytics consumer shares now also carries what
 * weakness evidence preparation needs, so activity/progress and weakness
 * can never read two different projections of the same stored row. A
 * payload-less legacy attempt row (no embedded `attempt`) maps every one of
 * these to their safe/absent value, exactly like `localDateAtEvent: null`
 * and `responseTimeMs: NaN` already do — such a row can create daily
 * activity for nothing and weakness evidence for nothing.
 */
export type AnalyticsAttempt = {
  id: string;
  componentKey: string;
  /** The attempt's immutable stored local date, or null when unreadable. */
  localDateAtEvent: string | null;
  responseTimeMs: number;
  /** The attempt's immutable stored UTC instant, or null when unreadable. */
  occurredAtUtc: string | null;
  entryId: number | null;
  skillType: SkillType | null;
  direction: Direction | null;
  /** Set only for translation (form_direction) components. */
  sourceField: SourceQuizFormField | null;
  /** The field actually prompted/answered — the §9 form-attribution source
   * for entry-level components (bāb/root/verb-type). */
  promptField: AnswerField | null;
  isFirstAttempt: boolean;
  isReinforcement: boolean;
  isCorrect: boolean;
};

/** The slice of one stored review event the derivation consumes. */
export type AnalyticsEvent = {
  eventId: string;
  /** The attempt this event grades, or null/absent on a corrupt row. */
  attemptId: string | null;
  /** Chain parent (null = root); undefined marks a corrupt row. */
  parentEventId: string | null | undefined;
  /** Lifecycle status (scheduling/reinforcement/conflict_demoted/…). */
  status: string | null;
  /** LOCAL sync lifecycle (local/pushed/accepted/demoted/rejected). */
  syncStatus: string | null;
  /** The event's immutable stored local date, or null when unreadable. */
  localDateAtEvent: string | null;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Is this stored attempt valid activity evidence (§8.1–8.2)? Requires a
 * structurally usable id + component key, an immutable ISO local date, a
 * finite non-negative response time, and no revoked/rejected linked event.
 */
export function isValidActivityAttempt(
  attempt: AnalyticsAttempt,
  linkedEvent: AnalyticsEvent | undefined,
): boolean {
  if (!isNonEmptyString(attempt.id)) return false;
  if (!isNonEmptyString(attempt.componentKey)) return false;
  if (!isIsoDate(attempt.localDateAtEvent)) return false;
  if (!Number.isFinite(attempt.responseTimeMs) || attempt.responseTimeMs < 0) {
    return false;
  }
  if (linkedEvent) {
    // A revoked event marks its attempt as invalid scheduling history; a
    // rejected sync lifecycle means the server refused it. Neither may count.
    // A conflict-demoted event does NOT invalidate the attempt — the effort
    // occurred; only its scheduling authority was demoted.
    if (linkedEvent.status === "revoked") return false;
    if (linkedEvent.syncStatus === "rejected") return false;
  }
  return true;
}

/**
 * Derive the complete daily-activity set from raw attempts + events, sorted
 * ascending by local date. Dates with no valid records produce no row — the
 * presentation layer represents zero-activity dates itself (§13).
 */
export function deriveDailyActivity(
  attempts: readonly AnalyticsAttempt[],
  events: readonly AnalyticsEvent[],
): DailyActivity[] {
  const eventByAttemptId = new Map<string, AnalyticsEvent>();
  for (const event of events) {
    if (isNonEmptyString(event.attemptId)) {
      eventByAttemptId.set(event.attemptId, event);
    }
  }

  const byDate = new Map<string, DailyActivity>();
  const rowFor = (localDate: string): DailyActivity => {
    let row = byDate.get(localDate);
    if (!row) {
      row = { localDate, attempts: 0, reviews: 0, newItems: 0, studyMs: 0 };
      byDate.set(localDate, row);
    }
    return row;
  };

  for (const attempt of attempts) {
    if (!isValidActivityAttempt(attempt, eventByAttemptId.get(attempt.id))) {
      continue;
    }
    const row = rowFor(attempt.localDateAtEvent!);
    row.attempts += 1;
    row.studyMs += attempt.responseTimeMs;
  }

  for (const event of events) {
    // Only scheduling-authoritative events consume new/review counts (§8.5):
    // the shared classifier excludes reinforcement, conflict-demoted, revoked
    // and pending-parent lifecycles; a rejected sync lifecycle is excluded
    // here for the same reason a rejected attempt is.
    if (event.syncStatus === "rejected") continue;
    if (!isIsoDate(event.localDateAtEvent)) continue;
    const eventClass = classifySchedulingEvent(event);
    if (eventClass === null) continue;
    const row = rowFor(event.localDateAtEvent);
    if (eventClass === "new_item") row.newItems += 1;
    else row.reviews += 1;
  }

  return [...byDate.values()].sort((a, b) =>
    a.localDate < b.localDate ? -1 : a.localDate > b.localDate ? 1 : 0,
  );
}
