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
 *  - the PEDAGOGICAL ordering of the new tier (`newRank`): an explicit,
 *    typed component-priority policy — recognition before recall before
 *    ṣarf identification — spread across distinct entries (round-robin,
 *    breadth before depth), never raw component-key order. An entry with no
 *    prior component history always starts with an Arabic→English
 *    recognition component (māḍī preferred).
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
  type DerivedComponent,
} from "@/modules/study-engine/components";
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
/* New-component pedagogical priority (Phase 10 correction)            */
/* ------------------------------------------------------------------ */

/**
 * The EXPLICIT priority classes for never-studied components, lower studied
 * first (§4.3 "sensible zero-configuration session"). The progression moves
 * from recognising a word to producing and analysing it:
 *
 *   māḍī recognition → other essential recognition (muḍāriʿ/maṣdar) →
 *   essential māḍī recall → bāb → root → remaining translation components →
 *   extended verb-type material.
 *
 * A typed policy — never alphabetical skill names and never raw component-key
 * order, which interleaves skills arbitrarily and sorts unpadded entry ids as
 * strings (entry:100 before entry:1).
 */
export const NEW_COMPONENT_PRIORITY = {
  madi_recognition: 0,
  essential_recognition: 1,
  essential_recall: 2,
  bab_identification: 3,
  root_identification: 4,
  remaining_translation: 5,
  verb_type_identification: 6,
} as const;

export type NewComponentPriorityClass = keyof typeof NEW_COMPONENT_PRIORITY;

/** Classify a derived component under the new-item priority policy. */
export function newComponentPriorityClass(
  component: DerivedComponent,
): NewComponentPriorityClass {
  switch (component.skillType) {
    case "meaning_recognition":
      if (component.sourceField === "madi") return "madi_recognition";
      return component.essential
        ? "essential_recognition"
        : "remaining_translation";
    case "meaning_recall":
      // The essential recall set is māḍī only (§5).
      return component.essential ? "essential_recall" : "remaining_translation";
    case "bab_identification":
      return "bab_identification";
    case "root_identification":
      return "root_identification";
    case "verb_type_identification":
      return "verb_type_identification";
  }
}

/** The numeric priority (lower studied first) for a derived component. */
export function newComponentPriority(component: DerivedComponent): number {
  return NEW_COMPONENT_PRIORITY[newComponentPriorityClass(component)];
}

/** One entry's not-yet-studied component, ready for rank assignment. */
type NewCandidate = {
  componentKey: string;
  priority: number;
  /** Stable derivation position within the entry (deterministic tiebreak). */
  order: number;
  isRecognition: boolean;
};

/**
 * Assign the pedagogical `newRank` for every selectable new component:
 *
 *  1. Within an entry, candidates run in priority-class order (recognition
 *     before recall before bāb/root, verb-type last).
 *  2. Entries take turns round-robin — at most one new component per entry
 *     per round — so a session spreads across distinct words while enough
 *     entries are available (breadth before depth).
 *  3. Entries with fewer already-materialised components go first, tiebroken
 *     by source order (the release's entry order — numeric, never string
 *     order of unpadded ids).
 *  4. An entry with NO component history always STARTS with a recognition
 *     component: its earliest recognition candidate is hoisted to the queue
 *     head even when only a non-essential recognition is eligible (which
 *     would otherwise rank behind bāb/root). In the (structurally possible,
 *     currently unreachable) case that such an entry has no recognition
 *     component at all, its components are left out of this session's new
 *     tier rather than opening with recall or ṣarf analysis.
 *
 * Returns a total rank per component key — raw key order never decides.
 */
function assignNewRanks(
  newByEntry: ReadonlyMap<number, NewCandidate[]>,
  materialisedCountByEntry: ReadonlyMap<number, number>,
  entrySourceIndexById: ReadonlyMap<number, number>,
): Map<string, number> {
  const queues: { entryId: number; queue: NewCandidate[] }[] = [];
  for (const [entryId, candidates] of newByEntry) {
    const queue = [...candidates].sort(
      (a, b) => a.priority - b.priority || a.order - b.order,
    );
    const unseen = (materialisedCountByEntry.get(entryId) ?? 0) === 0;
    if (unseen) {
      const recognitionIndex = queue.findIndex(
        (candidate) => candidate.isRecognition,
      );
      if (recognitionIndex < 0) continue; // never open with recall/ṣarf
      if (recognitionIndex > 0) {
        const [firstRecognition] = queue.splice(recognitionIndex, 1);
        queue.unshift(firstRecognition);
      }
    }
    queues.push({ entryId, queue });
  }
  queues.sort(
    (a, b) =>
      (materialisedCountByEntry.get(a.entryId) ?? 0) -
        (materialisedCountByEntry.get(b.entryId) ?? 0) ||
      entrySourceIndexById.get(a.entryId)! -
        entrySourceIndexById.get(b.entryId)!,
  );

  const ranks = new Map<string, number>();
  let rank = 0;
  let remaining = queues.reduce((sum, item) => sum + item.queue.length, 0);
  while (remaining > 0) {
    for (const item of queues) {
      const next = item.queue.shift();
      if (next) {
        ranks.set(next.componentKey, rank);
        rank += 1;
        remaining -= 1;
      }
    }
  }
  return ranks;
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
  const entrySourceIndexById = new Map(
    entries.map((entry, index) => [entry.id, index]),
  );
  const storedByKey = new Map(
    stored.map((record) => [record.componentKey, record]),
  );

  const items: SchedulableItem[] = [];
  const planByKey = new Map<string, MixedPlanItem>();
  const newByEntry = new Map<number, NewCandidate[]>();
  const materialisedCountByEntry = new Map<number, number>();
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
    planByKey.set(component.key, { identity, promptForm });

    const record = storedByKey.get(component.key);
    const card = record?.fsrs ?? null;
    if (card !== null) {
      // Already materialised (has a scheduling card): a due/weak candidate.
      materialisedCountByEntry.set(
        component.entryId,
        (materialisedCountByEntry.get(component.entryId) ?? 0) + 1,
      );
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
    } else {
      // Never studied: collect for pedagogical rank assignment.
      const candidates = newByEntry.get(component.entryId);
      const candidate: NewCandidate = {
        componentKey: component.key,
        priority: newComponentPriority(component),
        order: candidates?.length ?? 0,
        isRecognition: component.skillType === "meaning_recognition",
      };
      if (candidates) candidates.push(candidate);
      else newByEntry.set(component.entryId, [candidate]);
    }
  }

  const newRanks = assignNewRanks(
    newByEntry,
    materialisedCountByEntry,
    entrySourceIndexById,
  );
  for (const [componentKey, newRank] of newRanks) {
    items.push({
      componentKey,
      card: null,
      state: "not_started",
      newRank,
    });
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
