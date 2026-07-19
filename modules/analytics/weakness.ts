/**
 * Weakness heuristic v2 (Phase 13 §10) — the ONE deterministic weakness
 * score every consumer (Weak Areas, weak drill planning, mixed-revision
 * weak tier, the Custom Session weak filter) reads. Replaces the Phase 11/12
 * v1 recent-error-fraction score (`computeWeakScores` in
 * modules/study-session/mixed.ts) everywhere it was used.
 *
 * INPUTS: up to the ten most recent valid first attempts (already prepared
 * by `modules/analytics/weakness-evidence.ts` — reinforcement, revoked and
 * sync-rejected attempts never reach this module), the component's current
 * FSRS lapse count, its current effective learner state, and an injected
 * `nowMs`.
 *
 * TIME MODEL: unlike `modules/analytics/dates.ts` (deliberately calendar-
 * LABEL arithmetic, never 24-hour spans, because DST days are not always 24
 * hours), this module's recency decay is a continuous exponential half-life
 * over real elapsed milliseconds — the correct model for "how much should a
 * three-week-old failure still count," where a literal calendar-day count
 * would be wrong context. `DAY_MS` below is this module's own constant for
 * that reason and is not shared with the calendar-label module.
 *
 * Pure TypeScript: no React, Dexie, DOM or ambient clocks.
 */
import type {
  WeaknessAttemptEvidence,
  WeaknessComponentEvidence,
} from "@/modules/analytics/weakness-evidence";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Only the ten most recent valid first attempts feed the score (§10). */
export const RECENT_FIRST_ATTEMPT_WINDOW = 10;
/** Half-life (days) of a first attempt's contribution to the accuracy signal. */
export const ACCURACY_HALF_LIFE_DAYS = 30;
/** Half-life (days) of the most-recent-incorrect-attempt signal. */
export const RECENT_FAILURE_HALF_LIFE_DAYS = 14;
/** FSRS lapse count at which the lapse signal saturates to 1. */
export const LAPSE_SATURATION = 3;
/**
 * A component qualifies as weak only once its composite score exceeds this.
 * Calibrated so a single genuinely recent incorrect first attempt alone
 * clears the bar: weightedErrorRate 1 × evidenceConfidence 0.33 gives
 * accuracySignal ≈ 0.33, contributing 0.65 × 0.33 ≈ 0.21, plus
 * recentFailureSignal 1 × 0.10 = 0.10, for a total score ≈ 0.31 — while an
 * isolated failure more than a few months old decays underneath it (see
 * tests/analytics/weakness.test.ts).
 */
export const WEAK_THRESHOLD = 0.25;

const ACCURACY_WEIGHT = 0.65;
const LAPSE_WEIGHT = 0.25;
const RECENT_FAILURE_WEIGHT = 0.1;
/** The weighted-attempt-mass at which evidence confidence saturates to 1. */
const EVIDENCE_CONFIDENCE_SATURATION = 3;

export type ComponentWeakness = {
  score: number;
  accuracySignal: number;
  lapseSignal: number;
  recentFailureSignal: number;
  firstAttemptCount: number;
  incorrectFirstAttemptCount: number;
  firstAttemptAccuracy: number | null;
  lapses: number;
  lastAttemptAtMs: number | null;
  lastIncorrectAtMs: number | null;
  qualifiesAsWeak: boolean;
  /**
   * The exact windowed (≤ RECENT_FIRST_ATTEMPT_WINDOW, newest-first)
   * attempt set the signals above were computed from — exposed so any
   * consumer needing a per-attempt breakdown (e.g. the source-form
   * dimension in modules/analytics/weakness-groups.ts, which splits one
   * component's evidence across more than one form) reads the SAME
   * evidence window the score itself is based on, instead of
   * re-deriving or accidentally using the full unbounded attempt history.
   */
  consideredFirstAttempts: readonly WeaknessAttemptEvidence[];
};

/** Recency-decayed weight for one attempt at `nowMs` (§10, clamped age ≥ 0). */
function attemptWeight(occurredAtMs: number, nowMs: number): number {
  const ageDays = Math.max(0, nowMs - occurredAtMs) / DAY_MS;
  return Math.pow(0.5, ageDays / ACCURACY_HALF_LIFE_DAYS);
}

/** Deterministic, order-independent recency ordering: newest first, stable
 * tie-break on attemptId so equal timestamps never depend on input order. */
function byRecencyDesc(
  a: WeaknessComponentEvidence["firstAttempts"][number],
  b: WeaknessComponentEvidence["firstAttempts"][number],
): number {
  if (a.occurredAtMs !== b.occurredAtMs) return b.occurredAtMs - a.occurredAtMs;
  return b.attemptId.localeCompare(a.attemptId);
}

function safeLapseCount(lapses: number): number {
  if (!Number.isFinite(lapses) || lapses < 0) return 0;
  return lapses;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Score one component's weakness at `nowMs` from its prepared evidence
 * (§10). Deterministic and side-effect free: identical evidence + `nowMs`
 * always produce an identical result, regardless of the input attempt
 * array's order.
 */
export function computeComponentWeakness(
  evidence: WeaknessComponentEvidence,
  nowMs: number,
): ComponentWeakness {
  const considered = [...evidence.firstAttempts]
    .sort(byRecencyDesc)
    .slice(0, RECENT_FIRST_ATTEMPT_WINDOW);

  let weightedAttemptMass = 0;
  let weightedIncorrectMass = 0;
  let incorrectFirstAttemptCount = 0;
  let latestIncorrectMs: number | null = null;

  for (const row of considered) {
    const weight = attemptWeight(row.occurredAtMs, nowMs);
    weightedAttemptMass += weight;
    if (!row.isCorrect) {
      weightedIncorrectMass += weight;
      incorrectFirstAttemptCount += 1;
      if (latestIncorrectMs === null || row.occurredAtMs > latestIncorrectMs) {
        latestIncorrectMs = row.occurredAtMs;
      }
    }
  }

  const weightedErrorRate =
    weightedAttemptMass > 0 ? weightedIncorrectMass / weightedAttemptMass : 0;
  const evidenceConfidence = Math.min(
    weightedAttemptMass / EVIDENCE_CONFIDENCE_SATURATION,
    1,
  );
  const accuracySignal = clamp01(weightedErrorRate * evidenceConfidence);

  const lapses = safeLapseCount(evidence.fsrsLapses);
  const lapseSignal = clamp01(lapses / LAPSE_SATURATION);

  const recentFailureSignal =
    latestIncorrectMs === null
      ? 0
      : clamp01(
          Math.pow(
            0.5,
            Math.max(0, nowMs - latestIncorrectMs) /
              DAY_MS /
              RECENT_FAILURE_HALF_LIFE_DAYS,
          ),
        );

  const score = clamp01(
    ACCURACY_WEIGHT * accuracySignal +
      LAPSE_WEIGHT * lapseSignal +
      RECENT_FAILURE_WEIGHT * recentFailureSignal,
  );

  const lastAttemptAtMs =
    considered.length > 0 ? considered[0].occurredAtMs : null;
  const firstAttemptAccuracy =
    considered.length > 0
      ? (considered.length - incorrectFirstAttemptCount) / considered.length
      : null;

  const hasFailureEvidence = incorrectFirstAttemptCount > 0 || lapses > 0;
  const qualifiesAsWeak =
    evidence.effectiveState !== "mastered" &&
    hasFailureEvidence &&
    score > WEAK_THRESHOLD;

  return {
    score,
    accuracySignal,
    lapseSignal,
    recentFailureSignal,
    firstAttemptCount: considered.length,
    incorrectFirstAttemptCount,
    firstAttemptAccuracy,
    lapses,
    lastAttemptAtMs,
    lastIncorrectAtMs: latestIncorrectMs,
    qualifiesAsWeak,
    consideredFirstAttempts: considered,
  };
}

/** Score every prepared component at once, keyed by componentKey. */
export function computeAllComponentWeakness(
  evidence: ReadonlyMap<string, WeaknessComponentEvidence>,
  nowMs: number,
): ReadonlyMap<string, ComponentWeakness> {
  const result = new Map<string, ComponentWeakness>();
  for (const [key, row] of evidence) {
    result.set(key, computeComponentWeakness(row, nowMs));
  }
  return result;
}

/**
 * Adapt a v2 score to the plain "higher = weaker, 0 = not weak" scheduling
 * number `modules/scheduler/due.ts` (`SchedulableItem.weakScore`) and
 * `modules/study-session/custom.ts` (`componentStateClasses`) already
 * consume — the ONE place v2's full qualification rule (failure evidence,
 * threshold, mastered/non-due exclusion) collapses into that number, so
 * every scheduling consumer agrees with Weak Areas on exactly which
 * components are weak without re-implementing `qualifiesAsWeak` itself.
 * A non-qualifying component always reports 0, even when its raw `score` is
 * positive (e.g. below `WEAK_THRESHOLD`, or mastered-and-not-due).
 */
export function qualifyingWeaknessScore(weakness: ComponentWeakness): number {
  return weakness.qualifiesAsWeak ? weakness.score : 0;
}
