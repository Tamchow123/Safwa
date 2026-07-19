/**
 * Learner-facing study-duration formatting (Phase 12 §16 "Study time today").
 *
 * Durations are ACTIVE question-response time (summed `responseTimeMs`, never
 * wall-clock app-open time), so honest small values are common. Rendering
 * rules: an invalid or zero total reads "0 min"; anything under a minute
 * reads "Under a minute" (never a fake "0 min" for real effort); at an hour
 * and beyond, hours and minutes ("1 hr 5 min", "2 hr"). Minutes round to the
 * nearest whole minute.
 *
 * Pure TypeScript: no React, DOM or DB imports.
 */

const MINUTE_MS = 60_000;

/** Format a study duration in milliseconds for display. */
export function formatStudyDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 min";
  if (ms < MINUTE_MS) return "Under a minute";
  const totalMinutes = Math.round(ms / MINUTE_MS);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`;
}
