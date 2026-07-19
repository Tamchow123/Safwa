/**
 * The ONE bounded-await helper for local persistence gates that block
 * rendering (Phase 12 full-phase review REL-P101). An IndexedDB open blocked
 * behind another tab's connection neither resolves nor rejects, so every
 * gate a page renders behind must race its await against a timer —
 * otherwise the page strands on a skeleton with no retry. The rejection
 * carries the caller's label so each catch can choose its own user-safe
 * fallback.
 *
 * SAFETY INVARIANT: `Promise.race` cannot cancel the wrapped promise, so a
 * "timed out" call can still complete and commit later in the background.
 * That is harmless ONLY when the wrapped operation's sole write (if any) is
 * a fully idempotent, identity-keyed upsert or a complete rebuild that is
 * authoritative for nothing (e.g. `loadActiveContent`'s release-keyed
 * content cache, `loadAnalyticsView`'s `daily_activity` cache rebuild — both
 * self-heal on the next call regardless of how the previous one landed).
 * It is UNSAFE for any operation that appends a new, independently-identified
 * row to an authoritative log — e.g. the study grading write
 * (components/study/quiz-runner.tsx): a merely-queued write left to finish
 * after the caller has already told the learner it failed would duplicate
 * the review row. Never wrap such a write in this helper.
 *
 * TWO CONSUMPTION SHAPES are used across the codebase, both safe:
 *  - PREFERRED: race a pure, side-effect-free builder promise and apply the
 *    result exactly once in a `.then()`/`.catch()` chained onto the race, so
 *    a late-resolving loser has no continuation left to run (e.g.
 *    use-active-content.ts, use-analytics-snapshot.ts, use-session-defaults.ts,
 *    use-timezone.ts). Prefer this shape for any new gated read.
 *  - SPECIAL CASE: quiz-runner.tsx/flashcard-session.tsx race a multi-step
 *    async IIFE that itself calls setState at several points (it also
 *    populates refs consumed by sibling callbacks in the same closure), so
 *    it instead checks a shared `cancelled` flag before EVERY side effect —
 *    including ref writes — and the flag is set from the timeout's own
 *    `.catch()` (not just on unmount) to make a late resolution a genuine
 *    no-op. Only reach for this shape when the preferred one doesn't fit;
 *    every checkpoint must precede its side effect, with no exceptions.
 *
 * Pure TypeScript: no React, DOM or DB imports (timers are standard JS).
 */

/** Default budget for a local Dexie read that gates rendering. */
export const DB_READ_TIMEOUT_MS = 10_000;

/**
 * Rejection reason when the timer wins the race — distinct from any error
 * the wrapped promise itself might reject with, so callers can tell "this
 * gate genuinely timed out" from "the underlying read/rebuild failed" by
 * type rather than by re-matching a string against the label they passed in.
 */
export class TimeoutError extends Error {
  constructor(label: string) {
    super(label);
    this.name = "TimeoutError";
  }
}

/**
 * Resolve/reject with `promise`, or reject with `TimeoutError(label)` after
 * `ms`. The timer is always cleared on settle, so no handle leaks into test
 * environments or keeps an idle event loop alive.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(label)), ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
