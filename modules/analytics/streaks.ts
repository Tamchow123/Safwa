/**
 * Pure streak calculations (Phase 12 §9, PRODUCT_REQUIREMENTS.md §6).
 *
 * A STUDY DAY is a stored local date with at least one valid, non-revoked
 * attempt — incorrect-only days count; difficult days preserve the streak.
 * Scheduling events are NOT required (reinforcement creates no event).
 *
 * CURRENT-STREAK semantics (§9.2): the learner's current effective local
 * date is only the anchor —
 *  - activity today            → count back from today;
 *  - none today, but yesterday → the streak is retained through today
 *                                (counted back from yesterday);
 *  - neither                   → zero.
 * Duplicate attempts on one date are one study day; gaps break the streak.
 * All succession uses ISO-label calendar arithmetic (dates.ts) — never
 * 24-hour millisecond spans, so DST days cannot corrupt a streak. Historical
 * rows stay keyed by their stored dates; a timezone change only moves the
 * anchor for FUTURE days.
 *
 * Pure TypeScript: no React, Dexie, DOM or ambient clocks.
 */
import type { DailyActivity } from "@/modules/analytics/activity";
import { addDays, isIsoDate, isNextDay } from "@/modules/analytics/dates";

/** The distinct study-day date labels (attempts > 0), ascending. */
export function studyDayDates(activity: readonly DailyActivity[]): string[] {
  const dates = new Set<string>();
  for (const row of activity) {
    if (row.attempts > 0 && isIsoDate(row.localDate)) dates.add(row.localDate);
  }
  return [...dates].sort();
}

/**
 * The current streak in days, anchored at the learner's CURRENT effective
 * local date (§9.2). Counts the consecutive run ending at today (when today
 * is a study day) or at yesterday (grace: an unfinished today never breaks a
 * live streak); zero when neither is a study day.
 */
export function currentStreak(
  studyDays: readonly string[],
  todayLocalDate: string,
): number {
  if (!isIsoDate(todayLocalDate)) return 0;
  const days = new Set(studyDays);
  const yesterday = addDays(todayLocalDate, -1);
  const anchor = days.has(todayLocalDate)
    ? todayLocalDate
    : days.has(yesterday)
      ? yesterday
      : null;
  if (anchor === null) return 0;
  let streak = 0;
  let cursor = anchor;
  while (days.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/** The longest run of consecutive study-day dates anywhere in history. */
export function longestStreak(studyDays: readonly string[]): number {
  const sorted = [...new Set(studyDays)].filter(isIsoDate).sort();
  let longest = 0;
  let run = 0;
  let previous: string | null = null;
  for (const date of sorted) {
    run = previous !== null && isNextDay(previous, date) ? run + 1 : 1;
    if (run > longest) longest = run;
    previous = date;
  }
  return longest;
}

export type StreakSummary = {
  current: number;
  longest: number;
};

/** Both streaks from derived daily activity + the current-date anchor. */
export function computeStreaks(
  activity: readonly DailyActivity[],
  todayLocalDate: string,
): StreakSummary {
  const days = studyDayDates(activity);
  return {
    current: currentStreak(days, todayLocalDate),
    longest: longestStreak(days),
  };
}
