/**
 * Pure progress formulas (Phase 12 §7, PRODUCT_REQUIREMENTS.md §5–6).
 *
 * EVERY denominator derives from the loaded learner release through the ONE
 * component choke point (`deriveAllComponents`) — never from materialised
 * Dexie row counts (DATA_MODEL.md §2, CLAUDE.md hard rule 2). Stored rows
 * whose component is not derivable from the current release simply never
 * join (the derived universe drives every loop), so a stale or ineligible
 * stored component can never enter analytics.
 *
 * Effective state comes from the ONE shared `effectiveLearnerState` helper
 * (scheduler/states.ts): a component stored `mastered` whose card has since
 * become due — or lapsed — counts as needing review, exactly as the custom
 * session filter and (via this module) the dashboard report it.
 *
 * Ratios keep EXACT integer numerators and denominators (§7.9); presentation
 * percentages are computed separately, render `null` (unavailable) for a
 * legitimate zero denominator, and are never pre-rounded here.
 *
 * Pure TypeScript: no React, Dexie, DOM or ambient clocks
 * (docs/ARCHITECTURE.md §2; enforced by the ESLint purity guard).
 */
import {
  SKILL_TYPES,
  SOURCE_QUIZ_FORM_FIELDS,
  type SkillType,
  type SourceQuizFormField,
} from "@/modules/content/constants";
import type { LearnerEntry } from "@/modules/content/schema";
import type { SchedulerCard } from "@/modules/scheduler/fsrs";
import {
  effectiveLearnerState,
  isUsableCard,
  type LearnerState,
} from "@/modules/scheduler/states";
import type { DerivedComponent } from "@/modules/study-engine/components";

import { localDateForInstant } from "@/modules/analytics/dates";

/**
 * The stored scheduling-state slice progress consumes — the analytics-side
 * counterpart of study-session/mixed.ts's `StoredComponentState` (the same
 * structural shape, deliberately redefined here so `modules/analytics` never
 * depends on the session-orchestration layer; both mirror the Dexie
 * `StudyComponentRecord` without importing it).
 */
export type ProgressComponentState = {
  componentKey: string;
  fsrs?: SchedulerCard;
  learnerState?: LearnerState;
};

/** An EXACT ratio — integer numerator/denominator, never pre-rounded. */
export type ProgressRatio = {
  numerator: number;
  denominator: number;
};

/**
 * The presentation percentage for a ratio, or null when the denominator is
 * legitimately zero (rendered as unavailable, never NaN and never silently
 * replaced by a denominator of one). Unrounded — display rounding is the
 * presentation layer's concern (§7.9).
 */
export function percentage(ratio: ProgressRatio): number | null {
  if (ratio.denominator === 0) return null;
  return (ratio.numerator / ratio.denominator) * 100;
}

/** Count one component into a ratio: always the denominator, and the
 * numerator when it hit. The ONE tally rule for every dimension. */
function tally(ratio: ProgressRatio, hit: boolean): void {
  ratio.denominator += 1;
  if (hit) ratio.numerator += 1;
}

/**
 * A derived component joined with its stored card and EFFECTIVE state at the
 * snapshot instant. The card rides along RAW (usability-gated only where it
 * is consumed, e.g. due-today) so one join serves every dashboard consumer
 * per snapshot (§28) — never a second per-metric index build.
 */
export type EffectiveComponent = DerivedComponent & {
  state: LearnerState;
  card: SchedulerCard | null;
};

/**
 * Join the derived (eligible) component universe with stored scheduling
 * state at `nowMs`. The DERIVED set drives the join: a stored row without a
 * derivable component is ignored; a derivable component without a stored row
 * is `not_started`. Callers derive the universe ONCE per loaded release
 * (`deriveAllComponents`) and share this joined result across every consumer
 * (§28).
 */
export function effectiveComponents(
  components: readonly DerivedComponent[],
  stored: readonly ProgressComponentState[],
  nowMs: number,
): EffectiveComponent[] {
  const storedByKey = new Map(
    stored.map((record) => [record.componentKey, record]),
  );
  return components.map((component) => {
    const record = storedByKey.get(component.key);
    return {
      ...component,
      state: effectiveLearnerState(
        record?.learnerState,
        record?.fsrs ?? null,
        nowMs,
      ),
      card: record?.fsrs ?? null,
    };
  });
}

export type WordStateCounts = {
  /** Every essential component effectively not started. */
  wordsNotStarted: number;
  /** ≥1 essential component started, but the entry is not mastered. */
  wordsLearning: number;
  /** Every essential component effectively mastered. */
  wordsMastered: number;
  /** Inclusive: every entry that is not Not started (= learning + mastered). */
  wordsStarted: number;
};

export type ProgressSummary = {
  totalEntries: number;
  /** Entries whose complete essential set is effectively mastered / total. */
  overallCompletion: ProgressRatio;
  /** Effectively mastered eligible components / all eligible components. */
  componentMastery: ProgressRatio;
  perSkill: Record<SkillType, ProgressRatio>;
  /** Translation components per source form, both directions (§7.6). */
  perForm: Record<SourceQuizFormField, ProgressRatio>;
  wordStates: WordStateCounts;
};

function emptyRatios<K extends string>(
  keys: readonly K[],
): Record<K, ProgressRatio> {
  return Object.fromEntries(
    keys.map((key) => [key, { numerator: 0, denominator: 0 }]),
  ) as Record<K, ProgressRatio>;
}

/** Per-entry essential tallies for the word-state derivation. */
type EssentialTally = {
  total: number;
  mastered: number;
  started: number;
};

/**
 * The §6 table over one joined snapshot. `totalEntries` is the release's
 * entry count (the overall-completion denominator is ALWAYS the full release
 * — currently 455 — even for entries with no materialised state).
 */
export function computeProgressSummary(
  effective: readonly EffectiveComponent[],
  totalEntries: number,
): ProgressSummary {
  const componentMastery: ProgressRatio = { numerator: 0, denominator: 0 };
  const perSkill = emptyRatios(SKILL_TYPES);
  const perForm = emptyRatios(SOURCE_QUIZ_FORM_FIELDS);

  // One record per entry keeps the three essential tallies structurally in
  // step (§5/§7.3/§7.8). ONLY essential components feed word states —
  // extended mastery can never create word mastery or "started" status.
  const essentials = new Map<number, EssentialTally>();

  for (const component of effective) {
    const mastered = component.state === "mastered";

    tally(componentMastery, mastered);
    tally(perSkill[component.skillType], mastered);
    if (component.sourceField !== null) {
      tally(perForm[component.sourceField], mastered);
    }

    if (component.essential) {
      let record = essentials.get(component.entryId);
      if (!record) {
        record = { total: 0, mastered: 0, started: 0 };
        essentials.set(component.entryId, record);
      }
      record.total += 1;
      if (mastered) record.mastered += 1;
      if (component.state !== "not_started") record.started += 1;
    }
  }

  let wordsMastered = 0;
  let wordsLearning = 0;
  // Every record in `essentials` has total ≥ 1 by construction (records are
  // only created when an essential component is tallied), so a vacuous
  // "zero essentials mastered" entry cannot arise here.
  for (const record of essentials.values()) {
    if (record.mastered === record.total) wordsMastered += 1;
    else if (record.started > 0) wordsLearning += 1;
  }
  const wordsStarted = wordsMastered + wordsLearning;

  return {
    totalEntries,
    overallCompletion: { numerator: wordsMastered, denominator: totalEntries },
    componentMastery,
    perSkill,
    perForm,
    wordStates: {
      wordsNotStarted: totalEntries - wordsStarted,
      wordsLearning,
      wordsMastered,
      wordsStarted,
    },
  };
}

/**
 * Generic essential-component group completion (§7.7): for each group,
 * effectively mastered essential components of the group's entries over the
 * group's eligible essential components. `groupOf` returns null to exclude
 * an entry from the dimension entirely (e.g. an unverified verb type must
 * never classify its entry — entries 369/372).
 */
export function essentialGroupProgress(
  effective: readonly EffectiveComponent[],
  entries: readonly LearnerEntry[],
  groupOf: (entry: LearnerEntry) => string | null,
): Map<string, ProgressRatio> {
  const groupByEntryId = new Map<number, string>();
  for (const entry of entries) {
    const group = groupOf(entry);
    if (group !== null) groupByEntryId.set(entry.id, group);
  }
  const groups = new Map<string, ProgressRatio>();
  for (const component of effective) {
    if (!component.essential) continue;
    const group = groupByEntryId.get(component.entryId);
    if (group === undefined) continue;
    let ratio = groups.get(group);
    if (!ratio) {
      ratio = { numerator: 0, denominator: 0 };
      groups.set(group, ratio);
    }
    tally(ratio, component.state === "mastered");
  }
  return groups;
}

/** Bāb grouping (bāb classification is quiz-eligible for every entry). */
export function babGroup(entry: LearnerEntry): string | null {
  return entry.quiz_eligibility.bab ? entry.bab : null;
}

/** Verb-type grouping — an unverified verb type NEVER classifies its entry. */
export function verbTypeGroup(entry: LearnerEntry): string | null {
  return entry.quiz_eligibility.verb_type ? entry.verb_type : null;
}

/** Source/book-page grouping. */
export function bookPageGroup(entry: LearnerEntry): string | null {
  return String(entry.book_page);
}

/**
 * Reviews due today (§11): eligible materialised components whose FSRS due
 * INSTANT falls on or before the end of the CURRENT local calendar date in
 * the effective zone — computed by mapping each due instant to its local
 * date label and comparing labels, so no 24-hour-day assumption is made.
 * Overdue counts; later today counts; tomorrow does not; a missing or
 * corrupt card never counts. (Mastery/effective-state calculations use the
 * exact instant instead — deliberately different comparisons.)
 *
 * CALLER CONTRACT: `timezone` must be a resolver-validated zone (the
 * effective clock's zone — `resolveEffectiveClock` guarantees validity); an
 * unrecognised zone string throws from Intl. Consumes the SAME joined
 * snapshot as the summary/groups so one join serves every consumer (§28).
 */
export function countDueToday(
  effective: readonly EffectiveComponent[],
  timezone: string,
  currentLocalDate: string,
): number {
  let due = 0;
  for (const component of effective) {
    const card = component.card;
    if (!card || !isUsableCard(card)) continue;
    if (localDateForInstant(card.dueAtMs, timezone) <= currentLocalDate) {
      due += 1;
    }
  }
  return due;
}
