/**
 * Weakness aggregation and ranking across the six Phase 13 §12-14
 * dimensions: bāb, eligible verb type, source form, direction, skill and
 * current learner state.
 *
 * Consumes T2's per-component `ComponentWeakness` scores and T1's
 * `WeaknessComponentEvidence`/`WeaknessAttemptEvidence` — never re-reads raw
 * attempts/events. Bāb/verb-type grouping reuses the SAME data-driven
 * `babGroup`/`verbTypeGroup` functions `modules/analytics/progress.ts`
 * already uses for progress denominators, so entries 369/372 (unresolved
 * verb type) are excluded from verb-type weakness for exactly the reason
 * they are excluded from verb-type progress — one shared eligibility rule,
 * never a second hardcoded id check.
 *
 * Pure TypeScript: no React, Dexie, DOM or ambient clocks.
 */
import type { LearnerEntry } from "@/modules/content/schema";
import { babGroup, verbTypeGroup } from "@/modules/analytics/progress";
import type {
  WeaknessAttemptEvidence,
  WeaknessComponentEvidence,
} from "@/modules/analytics/weakness-evidence";
import type { ComponentWeakness } from "@/modules/analytics/weakness";

export const WEAKNESS_DIMENSIONS = [
  "bab",
  "verb_type",
  "source_form",
  "direction",
  "skill",
  "state",
] as const;
export type WeaknessDimension = (typeof WEAKNESS_DIMENSIONS)[number];

/**
 * Per-component contribution to a group's score is capped at this many
 * first attempts' worth of weight, so one heavily-drilled component cannot
 * single-handedly dominate the group's weighted-mean score (§13).
 */
export const GROUP_WEIGHT_CAP = 5;
/** A group surfaces once it has at least this many valid first attempts. */
export const MIN_FIRST_ATTEMPTS_FOR_EVIDENCE = 2;
/**
 * ...or, with fewer attempts, at least one component whose OWN score
 * exceeds this stronger bar — a single severe, well-evidenced component is
 * still worth surfacing even before the group accumulates two attempts.
 */
export const STRONG_SINGLE_COMPONENT_THRESHOLD = 0.5;

export type WeaknessGroup = {
  dimension: WeaknessDimension;
  value: string;
  weakComponentCount: number;
  attemptedComponentCount: number;
  firstAttemptCount: number;
  incorrectFirstAttemptCount: number;
  firstAttemptAccuracy: number | null;
  /** Sum of current FSRS lapses across contributing components. Omitted
   * (kept 0) for a source-form group whose lapses cannot be uniquely
   * attributed to one form — see `buildSourceFormGroups` below. */
  lapseCount: number;
  weaknessScore: number;
  lastAttemptAtMs: number | null;
  lastIncorrectAtMs: number | null;
};

type Accumulator = {
  weakComponentCount: number;
  attemptedComponentKeys: Set<string>;
  firstAttemptCount: number;
  incorrectFirstAttemptCount: number;
  lapseCount: number;
  weightSum: number;
  scoreWeightSum: number;
  lastAttemptAtMs: number | null;
  lastIncorrectAtMs: number | null;
};

function emptyAccumulator(): Accumulator {
  return {
    weakComponentCount: 0,
    attemptedComponentKeys: new Set(),
    firstAttemptCount: 0,
    incorrectFirstAttemptCount: 0,
    lapseCount: 0,
    weightSum: 0,
    scoreWeightSum: 0,
    lastAttemptAtMs: null,
    lastIncorrectAtMs: null,
  };
}

function maxOrNull(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/** The capped evidence-weight one component contributes to a group score. */
function componentWeight(firstAttemptCount: number): number {
  return Math.max(1, Math.min(firstAttemptCount, GROUP_WEIGHT_CAP));
}

function finalizeGroup(
  dimension: WeaknessDimension,
  value: string,
  acc: Accumulator,
): WeaknessGroup {
  return {
    dimension,
    value,
    weakComponentCount: acc.weakComponentCount,
    attemptedComponentCount: acc.attemptedComponentKeys.size,
    firstAttemptCount: acc.firstAttemptCount,
    incorrectFirstAttemptCount: acc.incorrectFirstAttemptCount,
    firstAttemptAccuracy:
      acc.firstAttemptCount > 0
        ? (acc.firstAttemptCount - acc.incorrectFirstAttemptCount) /
          acc.firstAttemptCount
        : null,
    lapseCount: acc.lapseCount,
    weaknessScore: acc.weightSum > 0 ? acc.scoreWeightSum / acc.weightSum : 0,
    lastAttemptAtMs: acc.lastAttemptAtMs,
    lastIncorrectAtMs: acc.lastIncorrectAtMs,
  };
}

/**
 * The five "whole-component" dimensions (bāb, verb type, direction, skill,
 * state): each touched component belongs to exactly one group value (or
 * none — `groupValueOf` returning null excludes it, e.g. an unverified verb
 * type), and contributes its WHOLE `ComponentWeakness` — this is safe
 * because these dimensions never split one component's evidence across
 * multiple group values (unlike source form; see `buildSourceFormGroups`).
 */
function buildWholeComponentGroups(
  dimension: WeaknessDimension,
  componentWeakness: ReadonlyMap<string, ComponentWeakness>,
  weaknessEvidence: ReadonlyMap<string, WeaknessComponentEvidence>,
  groupValueOf: (evidence: WeaknessComponentEvidence) => string | null,
): WeaknessGroup[] {
  const accumulators = new Map<string, Accumulator>();
  for (const [componentKey, cw] of componentWeakness) {
    const evidence = weaknessEvidence.get(componentKey);
    if (!evidence) continue;
    const value = groupValueOf(evidence);
    if (value === null) continue;

    let acc = accumulators.get(value);
    if (!acc) {
      acc = emptyAccumulator();
      accumulators.set(value, acc);
    }
    acc.attemptedComponentKeys.add(componentKey);
    if (cw.qualifiesAsWeak) acc.weakComponentCount += 1;
    acc.firstAttemptCount += cw.firstAttemptCount;
    acc.incorrectFirstAttemptCount += cw.incorrectFirstAttemptCount;
    acc.lapseCount += cw.lapses;
    acc.lastAttemptAtMs = maxOrNull(acc.lastAttemptAtMs, cw.lastAttemptAtMs);
    acc.lastIncorrectAtMs = maxOrNull(
      acc.lastIncorrectAtMs,
      cw.lastIncorrectAtMs,
    );
    const weight = componentWeight(cw.firstAttemptCount);
    acc.weightSum += weight;
    acc.scoreWeightSum += weight * cw.score;
  }

  return [...accumulators.entries()].map(([value, acc]) =>
    finalizeGroup(dimension, value, acc),
  );
}

/**
 * Source-form grouping (§12.3) — the one dimension where a single
 * entry-level component's evidence can legitimately split across more than
 * one group value (a bāb component attempted with both māḍī and muḍāriʿ).
 * Iterates each component's `consideredFirstAttempts` — the SAME windowed
 * (≤ RECENT_FIRST_ATTEMPT_WINDOW, newest-first) set `computeComponentWeakness`
 * scored, exposed on `ComponentWeakness` for exactly this reason — never the
 * evidence module's unbounded lifetime `firstAttempts`, so a form group's
 * accuracy/count fields always describe the same evidence window as the
 * `weaknessScore` sitting beside them (and as every other dimension's whole-
 * component counts). A component's FSRS lapse count is added to a form's
 * `lapseCount` ONLY when every one of that component's CONSIDERED evidence
 * rows share the same analysis form — i.e. it was never prompted through
 * more than one form within the window — because a lapse cannot be
 * honestly attributed to one form once the component's considered history
 * spans several (§12.3, §23 "do not duplicate one component's total lapse
 * count across multiple prompt-form buckets").
 */
function buildSourceFormGroups(
  componentWeakness: ReadonlyMap<string, ComponentWeakness>,
): WeaknessGroup[] {
  const accumulators = new Map<string, Accumulator>();

  for (const [componentKey, cw] of componentWeakness) {
    const byForm = new Map<string, WeaknessAttemptEvidence[]>();
    for (const row of cw.consideredFirstAttempts) {
      if (row.analysisForm === null) continue;
      const list = byForm.get(row.analysisForm) ?? [];
      byForm.set(row.analysisForm, list);
      list.push(row);
    }
    if (byForm.size === 0) continue;

    const singleForm = byForm.size === 1;
    const weight = componentWeight(cw.consideredFirstAttempts.length);

    for (const [form, rows] of byForm) {
      let acc = accumulators.get(form);
      if (!acc) {
        acc = emptyAccumulator();
        accumulators.set(form, acc);
      }
      acc.attemptedComponentKeys.add(componentKey);
      if (cw.qualifiesAsWeak) acc.weakComponentCount += 1;
      acc.firstAttemptCount += rows.length;
      const incorrect = rows.filter((row) => !row.isCorrect).length;
      acc.incorrectFirstAttemptCount += incorrect;
      if (singleForm) acc.lapseCount += cw.lapses; // uniquely attributable
      const latest = rows.reduce<number | null>(
        (max, row) => maxOrNull(max, row.occurredAtMs),
        null,
      );
      acc.lastAttemptAtMs = maxOrNull(acc.lastAttemptAtMs, latest);
      const latestIncorrect = rows
        .filter((row) => !row.isCorrect)
        .reduce<number | null>(
          (max, row) => maxOrNull(max, row.occurredAtMs),
          null,
        );
      acc.lastIncorrectAtMs = maxOrNull(acc.lastIncorrectAtMs, latestIncorrect);
      // Weight/score still come from the WHOLE component's score (the one
      // documented weakness signal a component has); only the honest
      // attempt-count/accuracy/lapse bookkeeping above is form-specific.
      acc.weightSum += weight;
      acc.scoreWeightSum += weight * cw.score;
    }
  }

  return [...accumulators.entries()].map(([value, acc]) =>
    finalizeGroup("source_form", value, acc),
  );
}

/** Build the ranked-ready (unranked) groups for one dimension. */
export function buildWeaknessGroups(
  dimension: WeaknessDimension,
  componentWeakness: ReadonlyMap<string, ComponentWeakness>,
  weaknessEvidence: ReadonlyMap<string, WeaknessComponentEvidence>,
  entries: readonly LearnerEntry[],
): WeaknessGroup[] {
  switch (dimension) {
    case "source_form":
      return buildSourceFormGroups(componentWeakness);
    case "bab": {
      const babByEntryId = new Map(entries.map((e) => [e.id, babGroup(e)]));
      return buildWholeComponentGroups(
        dimension,
        componentWeakness,
        weaknessEvidence,
        (ev) => babByEntryId.get(ev.entryId) ?? null,
      );
    }
    case "verb_type": {
      const verbTypeByEntryId = new Map(
        entries.map((e) => [e.id, verbTypeGroup(e)]),
      );
      return buildWholeComponentGroups(
        dimension,
        componentWeakness,
        weaknessEvidence,
        (ev) => verbTypeByEntryId.get(ev.entryId) ?? null,
      );
    }
    case "direction":
      return buildWholeComponentGroups(
        dimension,
        componentWeakness,
        weaknessEvidence,
        (ev) => ev.direction,
      );
    case "skill":
      return buildWholeComponentGroups(
        dimension,
        componentWeakness,
        weaknessEvidence,
        (ev) => ev.skillType,
      );
    case "state":
      return buildWholeComponentGroups(
        dimension,
        componentWeakness,
        weaknessEvidence,
        (ev) => ev.effectiveState,
      );
  }
}

/** Does this group have enough evidence to surface at all (§13)? */
function hasMinimumEvidence(group: WeaknessGroup): boolean {
  if (group.firstAttemptCount >= MIN_FIRST_ATTEMPTS_FOR_EVIDENCE) return true;
  if (group.lapseCount > 0) return true;
  return group.weaknessScore > STRONG_SINGLE_COMPONENT_THRESHOLD;
}

/** Deterministic ranking (§14): score desc, weak count desc, recent
 * incorrect evidence desc, stable value tie-break. */
function compareGroups(a: WeaknessGroup, b: WeaknessGroup): number {
  if (a.weaknessScore !== b.weaknessScore)
    return b.weaknessScore - a.weaknessScore;
  if (a.weakComponentCount !== b.weakComponentCount) {
    return b.weakComponentCount - a.weakComponentCount;
  }
  const aIncorrect = a.lastIncorrectAtMs ?? -Infinity;
  const bIncorrect = b.lastIncorrectAtMs ?? -Infinity;
  if (aIncorrect !== bIncorrect) return bIncorrect - aIncorrect;
  return a.value.localeCompare(b.value);
}

/** Filter to groups meeting the minimum-evidence bar and rank them. */
export function rankWeaknessGroups(
  groups: readonly WeaknessGroup[],
): WeaknessGroup[] {
  return groups.filter(hasMinimumEvidence).sort(compareGroups);
}

/** Ranked groups for every dimension, keyed by dimension. */
export function buildAllWeaknessGroups(
  componentWeakness: ReadonlyMap<string, ComponentWeakness>,
  weaknessEvidence: ReadonlyMap<string, WeaknessComponentEvidence>,
  entries: readonly LearnerEntry[],
): Record<WeaknessDimension, WeaknessGroup[]> {
  const result = {} as Record<WeaknessDimension, WeaknessGroup[]>;
  for (const dimension of WEAKNESS_DIMENSIONS) {
    result[dimension] = rankWeaknessGroups(
      buildWeaknessGroups(
        dimension,
        componentWeakness,
        weaknessEvidence,
        entries,
      ),
    );
  }
  return result;
}

/** Top N groups overall, merged across every dimension (§14 "top five"). */
export function topOverallWeaknessGroups(
  allGroups: Record<WeaknessDimension, WeaknessGroup[]>,
  limit = 5,
): WeaknessGroup[] {
  const merged = WEAKNESS_DIMENSIONS.flatMap(
    (dimension) => allGroups[dimension],
  );
  return merged.sort(compareGroups).slice(0, limit);
}
