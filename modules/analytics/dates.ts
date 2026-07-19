/**
 * Pure ISO-date calendar arithmetic for analytics (Phase 12 §8–9).
 *
 * All activity and streak grouping keys on stored `local_date_at_event`
 * labels ("YYYY-MM-DD"). Date SUCCESSION is computed by moving between date
 * LABELS with UTC calendar arithmetic — never by adding 24-hour millisecond
 * spans to instants, because DST days are not always 24 hours (§9.2). UTC is
 * used here solely to move between labels; it never re-times an event.
 *
 * Every exported helper VALIDATES its date-label arguments and throws on a
 * malformed one — silent NaN-derived garbage must never propagate into a
 * derived cache row or chart label (the same fail-loud posture as the count
 * guard). Record-level consumers (activity/streaks) pre-filter with
 * `isIsoDate` instead, so corrupt stored rows are excluded, not fatal.
 *
 * Pure TypeScript: no React, Dexie, DOM or ambient clocks
 * (docs/ARCHITECTURE.md §2).
 */
import { computeEventTimeFields } from "@/modules/study-engine/attempts";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Parse "YYYY-MM-DD" into numeric parts (no validity judgement). */
function parseIsoDateParts(date: string): [number, number, number] {
  const [year, month, day] = date.split("-").map(Number);
  return [year, month, day];
}

/** Is this a structurally valid, REAL calendar date label ("YYYY-MM-DD")? */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = parseIsoDateParts(value);
  const utc = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC silently rolls impossible dates (2026-02-30 → March 2) — a
  // round-trip mismatch exposes them.
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day
  );
}

function assertIsoDate(value: string, role: string): void {
  if (!isIsoDate(value)) {
    throw new Error(
      `${role} must be a valid ISO date label, got ${JSON.stringify(value)}`,
    );
  }
}

function formatUtcDate(utc: Date): string {
  return (
    `${String(utc.getUTCFullYear()).padStart(4, "0")}-` +
    `${String(utc.getUTCMonth() + 1).padStart(2, "0")}-` +
    `${String(utc.getUTCDate()).padStart(2, "0")}`
  );
}

/** Move a date label by whole calendar days (UTC label arithmetic). */
export function addDays(date: string, days: number): string {
  assertIsoDate(date, "date");
  const [year, month, day] = parseIsoDateParts(date);
  return formatUtcDate(new Date(Date.UTC(year, month - 1, day + days)));
}

/**
 * Whole calendar days from `from` to `to` (positive when `to` is later).
 * No current consumer — kept (and tested) as the DST-safe label-arithmetic
 * primitive for any future calendar-day distance need. Phase 13's weak-areas
 * recency decay (`modules/analytics/weakness.ts`) deliberately does NOT
 * build on this: it needs continuous real-elapsed-millisecond exponential
 * decay between two epoch instants, a different computation from whole
 * calendar days between date labels — see that module's own doc comment.
 */
export function daysBetween(from: string, to: string): number {
  assertIsoDate(from, "from");
  assertIsoDate(to, "to");
  const [fy, fm, fd] = parseIsoDateParts(from);
  const [ty, tm, td] = parseIsoDateParts(to);
  return Math.round(
    (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000,
  );
}

/** Is `next` the calendar day immediately after `previous`? */
export function isNextDay(previous: string, next: string): boolean {
  assertIsoDate(previous, "previous");
  assertIsoDate(next, "next");
  return addDays(previous, 1) === next;
}

/**
 * The widest window `lastNDates` will materialise (one leap year). Trend
 * charts request 14–30 dates; the cap fail-louds a caller that would
 * otherwise allocate an unbounded label array from a corrupt count.
 */
export const MAX_DATE_RANGE = 366;

/** The `count` consecutive date labels ENDING at `end` inclusive, ascending. */
export function lastNDates(end: string, count: number): string[] {
  assertIsoDate(end, "end");
  if (!Number.isInteger(count) || count < 1 || count > MAX_DATE_RANGE) {
    throw new Error(
      `date-range count must be a positive integer ≤ ${MAX_DATE_RANGE}, got ${count}`,
    );
  }
  const dates: string[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    dates.push(addDays(end, -offset));
  }
  return dates;
}

/**
 * The local calendar date label for an instant in an IANA zone. Delegates to
 * the engine's ONE Intl-based event-time implementation — never a second
 * hand-rolled formatter (the timezone source passed here is irrelevant to
 * the computed date and is not returned).
 */
export function localDateForInstant(epochMs: number, timezone: string): string {
  return computeEventTimeFields(epochMs, {
    timezone,
    timezoneSource: "browser_detected",
  }).localDateAtEvent;
}
