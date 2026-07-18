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
import { isDue, type SchedulerCard } from "@/modules/scheduler/fsrs";

export const MASTERY_DAYS_REQUIRED = 3;

export type LearnerState =
  "not_started" | "learning" | "mastered" | "needs_review";

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
