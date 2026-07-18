/**
 * ts-fsrs integration (Phase 7). One FSRS card per study component. Every FSRS
 * call receives an INJECTED instant (epoch ms) — never `Date.now` — so
 * scheduling is fully deterministic and replayable (a lint rule forbids ambient
 * clocks in this module). Fuzz is disabled for the same reason.
 *
 * The app stores/serialises card state as plain numbers + a string state + ms
 * timestamps (`SchedulerCard`); this module converts to/from the ts-fsrs `Card`
 * (which uses `Date`) losslessly at the boundary.
 *
 * Pure TypeScript: no React, DOM or DB imports (docs/ARCHITECTURE.md §2).
 */
import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating,
  State,
  type Card,
  type FSRS,
  type Grade,
} from "ts-fsrs";

/** The four ratings this app produces (Easy is not currently exposed, §5). */
export type SchedulerRating = "again" | "hard" | "good" | "easy";

/** Learner-visible FSRS lifecycle state (mirrors ts-fsrs State). */
export type FsrsState = "new" | "learning" | "review" | "relearning";

/** Serialisable per-component FSRS card state (ms timestamps, no Date). */
export type SchedulerCard = {
  stability: number;
  difficulty: number;
  /** Next due instant (epoch ms). */
  dueAtMs: number;
  state: FsrsState;
  reps: number;
  lapses: number;
  scheduledDays: number;
  learningSteps: number;
  /** Last review instant (epoch ms), or null for a never-reviewed card. */
  lastReviewAtMs: number | null;
};

const RATING_TO_GRADE: Record<SchedulerRating, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

const STATE_TO_STRING: Record<State, FsrsState> = {
  [State.New]: "new",
  [State.Learning]: "learning",
  [State.Review]: "review",
  [State.Relearning]: "relearning",
};

const STRING_TO_STATE: Record<FsrsState, State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
};

/**
 * Fixed, deterministic FSRS parameters. Fuzz OFF (fuzz randomises intervals and
 * would break replay determinism). A single stateless instance is reused — its
 * methods are pure functions of (card, now, grade).
 */
const FSRS_PARAMS = generatorParameters({ enable_fuzz: false });
const FSRS_INSTANCE: FSRS = fsrs(FSRS_PARAMS);

function toFsrsCard(card: SchedulerCard): Card {
  return {
    due: new Date(card.dueAtMs),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: 0,
    scheduled_days: card.scheduledDays,
    learning_steps: card.learningSteps,
    reps: card.reps,
    lapses: card.lapses,
    state: STRING_TO_STATE[card.state],
    last_review:
      card.lastReviewAtMs === null ? undefined : new Date(card.lastReviewAtMs),
  };
}

function fromFsrsCard(card: Card): SchedulerCard {
  return {
    stability: card.stability,
    difficulty: card.difficulty,
    dueAtMs: card.due.getTime(),
    state: STATE_TO_STRING[card.state],
    reps: card.reps,
    lapses: card.lapses,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    lastReviewAtMs:
      card.last_review === undefined ? null : card.last_review.getTime(),
  };
}

/** A brand-new (never-reviewed) card at the injected instant. */
export function newCard(nowMs: number): SchedulerCard {
  return fromFsrsCard(createEmptyCard(new Date(nowMs)));
}

/**
 * Apply a rating to a card at the injected instant, returning the next card
 * state. Deterministic (fuzz off, injected `now`).
 */
export function reviewCard(
  card: SchedulerCard,
  nowMs: number,
  rating: SchedulerRating,
): SchedulerCard {
  const result = FSRS_INSTANCE.next(
    toFsrsCard(card),
    new Date(nowMs),
    RATING_TO_GRADE[rating],
  );
  return fromFsrsCard(result.card);
}

/** Whether the card was in the FSRS Review state (a genuine due review). */
export function isReviewState(card: SchedulerCard): boolean {
  return card.state === "review";
}

/** Is the card due at (or before) the injected instant? */
export function isDue(card: SchedulerCard, nowMs: number): boolean {
  return card.dueAtMs <= nowMs;
}
