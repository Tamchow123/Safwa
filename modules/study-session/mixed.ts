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
 *  - the weak-item score: the caller-injected `weakScores` map — higher =
 *    weaker, 0 = not weak. As of Phase 13, this is the ONE authoritative
 *    weakness heuristic v2 (`modules/analytics/weakness.ts`
 *    `computeComponentWeakness`, adapted through `qualifyingWeaknessScore`),
 *    the same score Weak Areas and the Custom Session weak filter read — this
 *    module has no weakness algorithm of its own, only the injected number;
 *  - a deterministic prompt form for entry-level components (māḍī when
 *    eligible, else the first eligible source form);
 *  - the REMAINING daily budgets for the current local date
 *    (`remainingDailyTargets`), recomputed from the persisted scheduling
 *    events so repeated same-day sessions share one daily allowance
 *    (§4.4: 10 new/day · 20 reviews/day by default);
 *  - the new tier (`newRank`, Phase 18.5): each word moves through its
 *    skill chain (`skill-chain.ts` — māḍī Arabic→English, māḍī
 *    English→Arabic, bāb, muḍāriʿ and maṣdar Arabic→English, root), one
 *    skill at a time, the next unlocking once the one before it was answered
 *    correctly on two separate days. Each day the next skills of words
 *    already started come first, except that at least
 *    {@link MIN_NEW_WORDS_PER_DAY} new words are introduced while any
 *    remain; whatever is left of the day's new budget goes to more new
 *    words. Only chain skills are ever introduced here — extended skills stay
 *    in the focused modes — and never in raw component-key order.
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
import { classifySchedulingEvent } from "@/modules/scheduler/events";
import type { SchedulerCard } from "@/modules/scheduler/fsrs";
import type { LearnerState } from "@/modules/scheduler/states";
import {
  deriveAllComponents,
  deriveComponentsForEntry,
  type DerivedComponent,
} from "@/modules/study-engine/components";
import { isFieldEligible } from "@/modules/study-engine/fields";
import { DEFAULT_ENTRY_LEVEL_PROMPT_FORM } from "@/modules/study-engine/generator";
import type { ComponentIdentity } from "@/modules/study-engine/natural-key";
import { eligiblePromptForms } from "@/modules/study-session/entry-quizzes";
import { DEFAULT_QUIZ_COUNT } from "@/modules/study-session/quizzes";
import {
  chainForEntry,
  chainStatus,
  toChainComponentState,
} from "@/modules/study-session/skill-chain";

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
  /**
   * Whether this skill has been answered correctly on two separate days and
   * its latest answer was not wrong — so the word's next skill may unlock in
   * Start studying (Phase 18.5). Resolved by `readSchedulingSnapshot`, the ONE
   * source of the signal; absent means false.
   */
  qualifiesForNextSkill?: boolean;
};

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
 * The new-vs-review rule itself lives in the ONE shared classifier
 * (`classifySchedulingEvent`), which Phase 12 daily-activity accounting also
 * consumes — the two must never diverge.
 */
export function remainingDailyTargets(
  events: readonly SchedulingEventSummary[],
  localDate: string,
  targets: DailyTargets = DEFAULT_DAILY_TARGETS,
): DailyTargets {
  let newIntroduced = 0;
  let reviewsCompleted = 0;
  for (const event of events) {
    if (event.localDateAtEvent !== localDate) continue;
    const eventClass = classifySchedulingEvent(event);
    if (eventClass === "new_item") newIntroduced += 1;
    else if (eventClass === "review") reviewsCompleted += 1;
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

/* ------------------------------------------------------------------ */
/* The new tier: skill chains (Phase 18.5)                              */
/* ------------------------------------------------------------------ */

/**
 * New words introduced per local day while any remain, even when the
 * next skills of started words could fill the whole new budget (the owner's
 * decision, 2026-11-22) — capped by whatever new budget is left today.
 */
export const MIN_NEW_WORDS_PER_DAY = 3;

/** The key of the skill that introduces each word to Start studying. */
function firstChainKeys(entries: readonly LearnerEntry[]): Set<string> {
  const keys = new Set<string>();
  for (const entry of entries) {
    const first = chainForEntry(deriveComponentsForEntry(entry))[0];
    if (first) keys.add(first.key);
  }
  return keys;
}

/**
 * How many new words were introduced on `localDate`: the day's
 * new-item scheduling events (the ONE shared `classifySchedulingEvent`, so this
 * never disagrees with the daily budget) on a word's first chain skill,
 * counted once per component (a guest→account merge can leave two roots).
 * Repeated same-day sessions therefore share one floor, and an undo (which
 * deletes its event) gives it back. The first skill counts in whichever mode
 * it was answered: a word met today in a focused mode has still been
 * introduced today.
 */
export function newWordsIntroducedOn(
  events: readonly SchedulingEventSummary[],
  localDate: string,
  entries: readonly LearnerEntry[],
): number {
  const firstKeys = firstChainKeys(entries);
  const introduced = new Set<string>();
  for (const event of events) {
    if (event.localDateAtEvent !== localDate) continue;
    if (!firstKeys.has(event.componentKey)) continue;
    if (classifySchedulingEvent(event) === "new_item") {
      introduced.add(event.componentKey);
    }
  }
  return introduced.size;
}

/** One candidate for the new tier. */
type NewCandidate = {
  componentKey: string;
  /** Position of the skill in its word's chain (0 = the word's first). */
  chainIndex: number;
  /** The word's position in the release's source order. */
  sourceIndex: number;
};

/**
 * The new tier in rank order:
 *
 *  1. the new words still owed today (`owedNewWords`), in source order;
 *  2. every unlocked next skill of a started word, earliest chain step first
 *     (every word's English→Arabic before any word's bāb), then source order;
 *  3. the remaining new words, in source order.
 *
 * `buildMixedSession` then takes as many as today's new budget allows, so the
 * owed words always make the cut and spare budget falls to new words when
 * fewer next skills are waiting.
 */
function rankNewTier(
  nextSkills: NewCandidate[],
  newWords: NewCandidate[],
  owedNewWords: number,
): string[] {
  const bySource = (a: NewCandidate, b: NewCandidate) =>
    a.sourceIndex - b.sourceIndex;
  const words = [...newWords].sort(bySource);
  const skills = [...nextSkills].sort(
    (a, b) => a.chainIndex - b.chainIndex || bySource(a, b),
  );
  const owed = words.slice(0, owedNewWords);
  const rest = words.slice(owedNewWords);
  return [...owed, ...skills, ...rest].map((c) => c.componentKey);
}

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
 *
 * `newWordsToday` is how many new words today's earlier sessions already
 * introduced (`newWordsIntroducedOn`), so the daily floor of
 * {@link MIN_NEW_WORDS_PER_DAY} holds across sessions rather than per session.
 */
export function buildMixedPlan(
  entries: readonly LearnerEntry[],
  stored: readonly StoredComponentState[],
  weakScores: ReadonlyMap<string, number>,
  nowMs: number,
  targets: DailyTargets = DEFAULT_DAILY_TARGETS,
  sessionLimit: number = DEFAULT_QUIZ_COUNT,
  newWordsToday: number = 0,
): MixedPlanItem[] {
  if (!Number.isInteger(sessionLimit) || sessionLimit < 1) {
    throw new Error(
      `mixed session limit must be a positive integer, got ${sessionLimit}`,
    );
  }
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const entrySourceIndexById = new Map(
    entries.map((entry, index) => [entry.id, index]),
  );
  const storedByKey = new Map(
    stored.map((record) => [record.componentKey, record]),
  );

  const items: SchedulableItem[] = [];
  const planByKey = new Map<string, MixedPlanItem>();
  const componentsByEntry = new Map<number, DerivedComponent[]>();
  for (const component of deriveAllComponents(entries)) {
    const entryComponents = componentsByEntry.get(component.entryId);
    if (entryComponents) entryComponents.push(component);
    else componentsByEntry.set(component.entryId, [component]);
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
    planByKey.set(component.key, { identity, promptForm });

    const record = storedByKey.get(component.key);
    const card = record?.fsrs ?? null;
    if (card !== null) {
      // Already materialised (has a scheduling card): a due/weak candidate.
      items.push({
        componentKey: component.key,
        card,
        // The RAW stored projection (no effectiveLearnerState re-derivation)
        // is safe here because of two invariants: (a) the stored state and
        // card are always rewritten together from ONE replay
        // (persistence.ts writeComponentProjection), so a lapsed card is
        // stored `needs_review` in the same transaction it lapses; and
        // (b) the due tier (due.ts selectDue) reads the card's own due
        // instant directly, so a stored-mastered card that became due by
        // time passing is still surfaced. If either invariant changes,
        // route this through effectiveLearnerState (scheduler/states.ts).
        state: record?.learnerState ?? "not_started",
        weakScore: weakScores.get(component.key) ?? 0,
      });
    }
  }

  // The new tier: each word's one `next` chain skill, if it has one. A word
  // whose FIRST skill is next is new to Start studying (even if a focused
  // mode touched another of its skills) — the same test
  // `newWordsIntroducedOn` counts by, so the floor and the ranking agree.
  const nextSkills: NewCandidate[] = [];
  const newWords: NewCandidate[] = [];
  for (const entry of entries) {
    const chain = chainForEntry(componentsByEntry.get(entry.id) ?? []);
    const statuses = chainStatus(chain, (key) =>
      toChainComponentState(storedByKey.get(key)),
    );
    const chainIndex = statuses.findIndex((skill) => skill.status === "next");
    if (chainIndex < 0) continue;
    const candidate: NewCandidate = {
      componentKey: statuses[chainIndex].component.key,
      chainIndex,
      sourceIndex: entrySourceIndexById.get(entry.id)!,
    };
    (chainIndex === 0 ? newWords : nextSkills).push(candidate);
  }
  const owedNewWords = Math.max(0, MIN_NEW_WORDS_PER_DAY - newWordsToday);
  rankNewTier(nextSkills, newWords, owedNewWords).forEach(
    (componentKey, index) => {
      items.push({
        componentKey,
        card: null,
        state: "not_started",
        newRank: index,
      });
    },
  );

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
