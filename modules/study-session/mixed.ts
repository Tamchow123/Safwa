/**
 * Mixed-revision planning (pure) — the zero-configuration "Start studying"
 * session (PRODUCT_REQUIREMENTS.md §4.3, Phase 10).
 *
 * Ordering is delegated to the scheduler's `buildMixedSession` (due → weak →
 * new, within the daily targets). This module supplies its inputs:
 *
 *  - the components that EXIST come from the shared derivation choke point
 *    (`deriveAllComponents`), so an ineligible component can never be planned
 *    (CLAUDE.md hard rule 2) — a stored card whose component is no longer
 *    derivable from the loaded release is silently dropped;
 *  - the weak-item heuristic v1: a per-component weakness score computed from
 *    RECENT first-attempt accuracy (the last `WEAK_SCORE_RECENT_WINDOW` first
 *    attempts; reinforcement recoveries never count) — higher = weaker;
 *  - a deterministic prompt form for entry-level components (māḍī when
 *    eligible, else the first eligible source form);
 *  - the REMAINING daily budgets for the current local date
 *    (`remainingDailyTargets`), recomputed from the persisted scheduling
 *    events so repeated same-day sessions share one daily allowance
 *    (§4.4: 10 new/day · 20 reviews/day by default).
 *
 * Every function is a pure function of its inputs (the clock instant is
 * injected); the impure Dexie read lives in `persistence.ts`.
 *
 * Pure TypeScript: no React, DOM or DB imports (docs/ARCHITECTURE.md §2).
 */
import type { SourceQuizFormField } from "@/modules/content/constants";
import type { LearnerEntry } from "@/modules/content/schema";

import {
  buildMixedSession,
  DEFAULT_DAILY_TARGETS,
  type DailyTargets,
  type SchedulableItem,
} from "@/modules/scheduler/due";
import type { SchedulerCard } from "@/modules/scheduler/fsrs";
import type { LearnerState } from "@/modules/scheduler/states";
import { deriveAllComponents } from "@/modules/study-engine/components";
import { isFieldEligible } from "@/modules/study-engine/fields";
import { DEFAULT_ENTRY_LEVEL_PROMPT_FORM } from "@/modules/study-engine/generator";
import type { ComponentIdentity } from "@/modules/study-engine/natural-key";
import { eligiblePromptForms } from "@/modules/study-session/entry-quizzes";
import { DEFAULT_QUIZ_COUNT } from "@/modules/study-session/quizzes";

/**
 * The stored scheduling state of one component (structurally compatible with
 * the Dexie `StudyComponentRecord` — no DB import in this pure module).
 */
export type StoredComponentState = {
  componentKey: string;
  /** FSRS card fields (present once the component has been reviewed). */
  fsrs?: SchedulerCard;
  /** Projected learner state (present once the component has been reviewed). */
  learnerState?: LearnerState;
};

/** The slice of one persisted attempt the weak-item heuristic consumes. */
export type WeaknessAttempt = {
  /** Attempt id — the deterministic tiebreak for equal timestamps. */
  id: string;
  componentKey: string;
  isFirstAttempt: boolean;
  isCorrect: boolean;
  /** When the attempt was recorded (epoch ms). */
  attemptedAt: number;
};

/** How many recent first attempts the weak-score heuristic v1 considers. */
export const WEAK_SCORE_RECENT_WINDOW = 5;

/**
 * Weak-item heuristic v1: per component, the fraction of its most recent
 * first attempts (up to `WEAK_SCORE_RECENT_WINDOW`) that were INCORRECT —
 * 0 (all recent first attempts correct) to 1 (all incorrect). Only first
 * attempts count: a within-session reinforcement recovery is reinforcement
 * only (§4.6) and must not launder a weak component into a strong one.
 */
export function computeWeakScores(
  attempts: readonly WeaknessAttempt[],
): Map<string, number> {
  const byComponent = new Map<string, WeaknessAttempt[]>();
  for (const attempt of attempts) {
    if (!attempt.isFirstAttempt) continue;
    const list = byComponent.get(attempt.componentKey);
    if (list) list.push(attempt);
    else byComponent.set(attempt.componentKey, [attempt]);
  }
  const scores = new Map<string, number>();
  for (const [componentKey, list] of byComponent) {
    const recent = [...list]
      .sort(
        (a, b) =>
          b.attemptedAt - a.attemptedAt || b.id.localeCompare(a.id, "en"),
      )
      .slice(0, WEAK_SCORE_RECENT_WINDOW);
    const incorrect = recent.filter((attempt) => !attempt.isCorrect).length;
    scores.set(componentKey, incorrect / recent.length);
  }
  return scores;
}

/**
 * The slice of one persisted scheduling review event the daily-target
 * accounting consumes (structurally compatible with the Dexie
 * `ReviewEventRecord` — no DB import in this pure module).
 */
export type SchedulingEventSummary = {
  componentKey: string;
  /** Null for a chain root — the event that INTRODUCED the component. */
  parentEventId: string | null;
  /** Event lifecycle status; only "scheduling" events count. */
  status: string | null;
  /** The learner-local date the event occurred ("YYYY-MM-DD"), or null. */
  localDateAtEvent: string | null;
};

/**
 * The daily budgets REMAINING for `localDate`, given the day's persisted
 * scheduling events (PRODUCT_REQUIREMENTS.md §4.3 "within the user's daily
 * targets", §4.4 defaults 10 new/day · 20 reviews/day):
 *
 *  - a chain-ROOT scheduling event (no parent) introduced its component —
 *    it consumes the new-item budget;
 *  - every other scheduling event is a completed review — it consumes the
 *    review budget.
 *
 * Recomputed from the stored events each time, so an undo (which deletes the
 * event) automatically refunds its budget, and a date rollover (a new
 * `localDate`) naturally restores the full targets. Events from other dates,
 * non-"scheduling" events and rows without a local date never consume budget.
 */
export function remainingDailyTargets(
  events: readonly SchedulingEventSummary[],
  localDate: string,
  targets: DailyTargets = DEFAULT_DAILY_TARGETS,
): DailyTargets {
  let newIntroduced = 0;
  let reviewsCompleted = 0;
  for (const event of events) {
    if (event.status !== "scheduling") continue;
    if (event.localDateAtEvent !== localDate) continue;
    if (event.parentEventId === null) newIntroduced += 1;
    else reviewsCompleted += 1;
  }
  return {
    newLimit: Math.max(0, targets.newLimit - newIntroduced),
    reviewLimit: Math.max(0, targets.reviewLimit - reviewsCompleted),
  };
}

/** A planned mixed-session item for `createSession`. */
export type MixedPlanItem = {
  identity: ComponentIdentity;
  /** Present for entry-level items: the eligible prompt form to show. */
  promptForm?: SourceQuizFormField;
};

/**
 * The deterministic prompt form for an entry-level component in a
 * zero-configuration session: the default māḍī when eligible, else the first
 * eligible source form; null when no source form is eligible (the component
 * cannot be prompted at all and is excluded from the plan).
 */
export function defaultEntryPromptForm(
  entry: LearnerEntry,
): SourceQuizFormField | null {
  if (isFieldEligible(entry, DEFAULT_ENTRY_LEVEL_PROMPT_FORM)) {
    return DEFAULT_ENTRY_LEVEL_PROMPT_FORM;
  }
  return eligiblePromptForms(entry)[0] ?? null;
}

/**
 * Build the zero-config mixed-revision plan: derive the eligible component
 * set, join it with the stored scheduling state and weak scores, order it
 * due → weak → new within the daily targets (`buildMixedSession`), and resolve
 * identities + entry-level prompt forms. Deterministic in its inputs; `nowMs`
 * is the injected clock instant.
 *
 * Daily-target semantics: callers pass the REMAINING budgets for the current
 * local date (see `remainingDailyTargets`), so repeated same-day sessions never
 * re-allocate a full daily allowance. Richer daily-activity display (progress,
 * streaks) arrives in Phase 12.
 *
 * One SESSION is additionally capped at the documented default question count
 * (§4.4: 20 questions/session) — the daily budgets say what may still be
 * studied today, the session limit says how much of it fits in one sitting.
 * The due → weak → new priority decides what makes the cut.
 */
export function buildMixedPlan(
  entries: readonly LearnerEntry[],
  stored: readonly StoredComponentState[],
  weakScores: ReadonlyMap<string, number>,
  nowMs: number,
  targets: DailyTargets = DEFAULT_DAILY_TARGETS,
  sessionLimit: number = DEFAULT_QUIZ_COUNT,
): MixedPlanItem[] {
  if (!Number.isInteger(sessionLimit) || sessionLimit < 1) {
    throw new Error(
      `mixed session limit must be a positive integer, got ${sessionLimit}`,
    );
  }
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const storedByKey = new Map(
    stored.map((record) => [record.componentKey, record]),
  );

  const items: SchedulableItem[] = [];
  const planByKey = new Map<string, MixedPlanItem>();
  for (const component of deriveAllComponents(entries)) {
    const identity: ComponentIdentity = {
      entryId: component.entryId,
      skillType: component.skillType,
      sourceField: component.sourceField,
      direction: component.direction,
    };
    let promptForm: SourceQuizFormField | undefined;
    if (component.componentShape === "entry_level") {
      const entry = entriesById.get(component.entryId)!;
      const resolved = defaultEntryPromptForm(entry);
      // No eligible source form to prompt with — the component cannot be
      // presented as a question, so it never enters the schedulable set.
      if (resolved === null) continue;
      promptForm = resolved;
    }
    const record = storedByKey.get(component.key);
    items.push({
      componentKey: component.key,
      card: record?.fsrs ?? null,
      state: record?.learnerState ?? "not_started",
      weakScore: weakScores.get(component.key) ?? 0,
    });
    planByKey.set(component.key, { identity, promptForm });
  }

  // Take the first `sessionLimit` of the (priority-ordered) daily allocation:
  // due reviews always make the cut before weak items, and those before new.
  return buildMixedSession(items, nowMs, targets)
    .slice(0, sessionLimit)
    .map((componentKey) => {
      const item = planByKey.get(componentKey);
      if (!item) {
        // buildMixedSession only returns keys it was given; a miss here is a
        // programming error, not a data condition.
        throw new Error(
          `mixed session returned unknown component ${componentKey}`,
        );
      }
      return item;
    });
}
