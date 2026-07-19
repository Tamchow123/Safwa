/**
 * Learner-state projection (PRODUCT_REQUIREMENTS.md §5, DATA_MODEL.md §8).
 * Recomputed from the replayed card + the distinct qualifying mastery dates:
 *
 *   not_started → learning → mastered ↔ needs_review
 *
 * Mastered = ≥3 distinct stored `local_date_at_event` values of accepted
 * authoritative Good/Easy reviews taken while the card was already in the FSRS
 * Review state, AND the card is not currently due. `Hard` never advances a
 * mastery day; the initial learning success is excluded; reinforcement never
 * advances (reinforcement produces no event). A mastered card that becomes due
 * (or lapses) is `needs_review`.
 *
 * Pure TypeScript: no React, DOM or DB imports.
 */
import { replayChain, type ChainReplay } from "@/modules/scheduler/chain";
import type { ReviewEvent } from "@/modules/scheduler/events";
import {
  FSRS_STATE_VALUES,
  isDue,
  type SchedulerCard,
} from "@/modules/scheduler/fsrs";

export const MASTERY_DAYS_REQUIRED = 3;

export type LearnerState =
  "not_started" | "learning" | "mastered" | "needs_review";

const LEARNER_STATE_VALUES: readonly LearnerState[] = [
  "not_started",
  "learning",
  "mastered",
  "needs_review",
];

/** Runtime guard for stored learner-state strings (IndexedDB rows may lie). */
function isStoredLearnerState(value: unknown): value is LearnerState {
  return LEARNER_STATE_VALUES.includes(value as LearnerState);
}

/**
 * A stored FSRS card usable for effective-state (and due) decisions: a finite
 * due instant and a known lifecycle state. A corrupt row fails safe (treated
 * as no card), so damaged data can never inflate mastery — and consumers that
 * tag components "due" must apply this same guard so a corrupt card is never
 * simultaneously untrusted for state yet trusted for due-ness.
 */
export function isUsableCard(card: SchedulerCard): boolean {
  return (
    Number.isFinite(card.dueAtMs) && FSRS_STATE_VALUES.includes(card.state)
  );
}

/**
 * The EFFECTIVE learner state at `nowMs` from the STORED projection + card
 * (PRODUCT_REQUIREMENTS.md §5 "due/lapsed after mastery").
 *
 * The stored projection is only rewritten when a scheduling event is written,
 * so it goes stale as time passes: a component stored `mastered` whose card
 * has since become due — or has lapsed into relearning — is `needs_review`
 * NOW. Every current-state consumer (dashboard/progress analytics, the custom
 * session state filter) derives through this one helper; two subtly different
 * implementations are forbidden.
 *
 *  - no / corrupt card            → `not_started` (never inflates progress)
 *  - stored mastered + due        → `needs_review`
 *  - stored mastered + relearning → `needs_review`
 *  - otherwise                    → the stored projection (an invalid stored
 *                                   value fails safe to `not_started`)
 */
export function effectiveLearnerState(
  storedState: LearnerState | undefined,
  card: SchedulerCard | null | undefined,
  nowMs: number,
): LearnerState {
  if (card == null || !isUsableCard(card)) return "not_started";
  const stored = isStoredLearnerState(storedState)
    ? storedState
    : "not_started";
  if (
    stored === "mastered" &&
    (isDue(card, nowMs) || card.state === "relearning")
  ) {
    return "needs_review";
  }
  return stored;
}

/**
 * Project the learner state from a replay result at the injected instant.
 *
 * The Learning transition requires ≥1 clean success (§5) — a component with only
 * `Again` events (no success yet) has not started learning and stays
 * `not_started`. A component with ≥3 mastery days is `mastered` only while it is
 * neither due nor lapsed (relearning); a lapse or due date makes it
 * `needs_review` (§5 "due/lapsed after mastery").
 */
export function learnerStateFromReplay(
  replay: ChainReplay,
  nowMs: number,
): LearnerState {
  if (replay.card === null || !replay.hasCleanSuccess) {
    return "not_started";
  }
  const mastered = replay.masteryDates.length >= MASTERY_DAYS_REQUIRED;
  if (mastered) {
    const lapsed = replay.card.state === "relearning";
    return isDue(replay.card, nowMs) || lapsed ? "needs_review" : "mastered";
  }
  return "learning";
}

export type ComponentProjection = {
  state: LearnerState;
  card: SchedulerCard | null;
  masteryDates: string[];
  masteryDayCount: number;
  scheduledEventCount: number;
};

/** Replay a component's events and project its full learner state. */
export function projectComponent(
  events: readonly ReviewEvent[],
  nowMs: number,
): ComponentProjection {
  const replay = replayChain(events);
  return {
    state: learnerStateFromReplay(replay, nowMs),
    card: replay.card,
    masteryDates: replay.masteryDates,
    masteryDayCount: replay.masteryDates.length,
    scheduledEventCount: replay.scheduledEventCount,
  };
}
