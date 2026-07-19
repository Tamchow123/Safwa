/**
 * Learner-facing integer formatting (Phase 12 §17 exact numerator/denominator
 * text). One shared formatter so every displayed count groups digits the same
 * way ("6,793") — components must not carry their own copies.
 *
 * Pure TypeScript: no React, DOM or DB imports.
 */

const INTEGER_FORMAT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

/** Format an exact integer count for display (digit-grouped, en-US). */
export function formatInt(value: number): string {
  return INTEGER_FORMAT.format(value);
}

/** "1 day" / "3 days" — the ONE day-count text used by every streak value. */
export function formatDayCount(days: number): string {
  return days === 1 ? "1 day" : `${formatInt(days)} days`;
}
