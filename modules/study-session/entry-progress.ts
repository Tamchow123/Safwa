/**
 * One word's progress for its entry page (Phase 18.5) — pure.
 *
 * Every number here comes from a rule that already exists elsewhere, so the
 * entry page can never disagree with the screens that use those rules:
 *
 *  - each skill's state is `effectiveLearnerState` (through analytics'
 *    `effectiveComponents`), the state the Progress page and the custom
 *    session filter report;
 *  - the word's state is analytics' `wordStateOf`, the rule behind the
 *    dashboard's word counts;
 *  - "next up" / "locked" is `chainStatus` over `chainForEntry`, exactly what
 *    Start studying plans from, fed the same `qualifiesForNextSkill` signal.
 *
 * Pure TypeScript: no React, DOM or DB imports.
 */
import {
  effectiveComponents,
  tallyEssential,
  wordStateOf,
  type EssentialTally,
  type WordState,
} from "@/modules/analytics/progress";
import type { LearnerEntry } from "@/modules/content/schema";
import type { LearnerState } from "@/modules/scheduler/states";
import {
  deriveComponentsForEntry,
  type DerivedComponent,
} from "@/modules/study-engine/components";
import type { StoredComponentState } from "@/modules/study-session/mixed";
import {
  chainForEntry,
  chainStatus,
  toChainComponentState,
  type ChainSkillStatus,
} from "@/modules/study-session/skill-chain";

/** One skill of the word, with its current state. */
export type EntrySkillProgress = {
  component: DerivedComponent;
  state: LearnerState;
};

/** One skill of the word's Start-studying chain. */
export type EntryChainSkillProgress = EntrySkillProgress & {
  status: ChainSkillStatus;
};

export type EntryProgress = {
  wordState: WordState;
  /** The Start-studying chain, in order (empty when it never teaches the word). */
  chain: EntryChainSkillProgress[];
  /** Skills outside the chain that have been started in a focused mode. */
  alsoPractised: EntrySkillProgress[];
};

/** `entry`'s progress for the owner whose stored state is `stored`, at `nowMs`. */
export function entryProgress(
  entry: LearnerEntry,
  stored: readonly StoredComponentState[],
  nowMs: number,
): EntryProgress {
  const components = deriveComponentsForEntry(entry);
  const storedByKey = new Map(
    stored.map((record) => [record.componentKey, record]),
  );
  const stateByKey = new Map(
    effectiveComponents(components, stored, nowMs).map((component) => [
      component.key,
      component.state,
    ]),
  );
  const stateOf = (component: DerivedComponent): LearnerState =>
    stateByKey.get(component.key) ?? "not_started";

  const tally: EssentialTally = { total: 0, mastered: 0, started: 0 };
  for (const component of components) {
    if (component.essential) tallyEssential(tally, stateOf(component));
  }

  const chainComponents = chainForEntry(components);
  const chainKeys = new Set(chainComponents.map((component) => component.key));
  const chain = chainStatus(chainComponents, (key) =>
    toChainComponentState(storedByKey.get(key)),
  ).map(({ component, status }) => ({
    component,
    status,
    state: stateOf(component),
  }));

  const alsoPractised = components
    .filter(
      (component) =>
        !chainKeys.has(component.key) &&
        storedByKey.get(component.key)?.fsrs != null,
    )
    .map((component) => ({ component, state: stateOf(component) }));

  return { wordState: wordStateOf(tally), chain, alsoPractised };
}
