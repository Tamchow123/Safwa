/**
 * The Start-studying skill chain (Phase 18.5) — pure.
 *
 * "Start studying" teaches each word's ESSENTIAL skills (the word-mastery set,
 * PRODUCT_REQUIREMENTS.md §5) one at a time, in the owner's order:
 *
 *   māḍī Arabic → English → māḍī English → Arabic → bāb →
 *   muḍāriʿ Arabic → English → maṣdar Arabic → English → root
 *
 * restricted to the components the entry actually has (an ineligible field
 * yields no component, so it is simply skipped — CLAUDE.md hard rule 2). A
 * word's next skill unlocks once the skill before it qualifies — answered
 * correctly on two separate days, latest answer not wrong — a signal resolved
 * by ONE function in the persistence layer (`qualifiesForNextSkill`) and
 * carried here as a boolean, so the planner and the entry page can never
 * disagree about what is unlocked.
 *
 * Every skill of a chain can be asked as it stands, so consumers use the chain
 * unfiltered: a chain opens with a recognition skill, which exists only when
 * its source form is eligible, and that form is also an eligible prompt for the
 * chain's bāb and root (`defaultEntryPromptForm` is never null for an entry
 * with a chain — pinned by `tests/study-session/skill-chain.test.ts`).
 *
 * A skill already started anywhere (any mode) counts as started: the chain
 * moves past it. Extended skills (recognition of ism al-fāʿil / amr / nahy,
 * the other recall directions, verb type) are not in the chain — they stay
 * in the focused modes.
 *
 * Pure TypeScript: no React, DOM or DB imports.
 */
import type {
  SkillType,
  SourceQuizFormField,
} from "@/modules/content/constants";

import type { DerivedComponent } from "@/modules/study-engine/components";

/** One step of the chain: a skill, plus the form it is about when it has one. */
type ChainStep = {
  skillType: SkillType;
  sourceField: SourceQuizFormField | null;
};

/** The owner's order (2026-11-22). */
export const SKILL_CHAIN: readonly ChainStep[] = [
  { skillType: "meaning_recognition", sourceField: "madi" },
  { skillType: "meaning_recall", sourceField: "madi" },
  { skillType: "bab_identification", sourceField: null },
  { skillType: "meaning_recognition", sourceField: "mudari" },
  { skillType: "meaning_recognition", sourceField: "masdar" },
  { skillType: "root_identification", sourceField: null },
];

function matches(component: DerivedComponent, step: ChainStep): boolean {
  return (
    component.skillType === step.skillType &&
    component.sourceField === step.sourceField
  );
}

/**
 * One entry's chain: its derived (eligible) components in chain order. A word
 * is always introduced through a recognition skill — never by asking it to
 * produce the Arabic or analyse it — so when the māḍī recognition is missing
 * the first recognition skill the chain does have moves to the front, and an
 * entry with no recognition skill at all has no chain (Start studying never
 * introduces it).
 */
export function chainForEntry(
  entryComponents: readonly DerivedComponent[],
): DerivedComponent[] {
  const chain: DerivedComponent[] = [];
  for (const step of SKILL_CHAIN) {
    const component = entryComponents.find((candidate) =>
      matches(candidate, step),
    );
    if (component) chain.push(component);
  }
  const firstRecognition = chain.findIndex(
    (component) => component.skillType === "meaning_recognition",
  );
  if (firstRecognition < 0) return [];
  if (firstRecognition > 0) {
    chain.unshift(...chain.splice(firstRecognition, 1));
  }
  return chain;
}

/** What the chain knows about one stored component. */
export type ChainComponentState = {
  /** True once the component has a scheduling card (started in any mode). */
  started: boolean;
  /** `qualifiesForNextSkill` from the scheduling snapshot. */
  qualifiesForNextSkill: boolean;
};

/**
 * The chain's view of one stored record (a `StoredComponentState`, typed
 * structurally so this module imports nothing from mixed.ts) — the ONE mapping
 * both the planner and the entry page feed `chainStatus`.
 */
export function toChainComponentState(
  record: { fsrs?: unknown; qualifiesForNextSkill?: boolean } | undefined,
): ChainComponentState {
  return {
    started: record?.fsrs != null,
    qualifiesForNextSkill: record?.qualifiesForNextSkill === true,
  };
}

export type ChainSkillStatus = "started" | "next" | "locked";

export type ChainSkill = {
  component: DerivedComponent;
  status: ChainSkillStatus;
};

/**
 * The status of every skill in a chain. A skill is `started` once it has a
 * card. The EARLIEST unstarted skill that is unlocked — it opens the chain, or
 * the skill before it is started and qualifies — is `next`; every other
 * unstarted skill is `locked`. A word therefore has at most one `next` skill,
 * even when a later skill was started out of turn in another mode.
 */
export function chainStatus(
  chain: readonly DerivedComponent[],
  stateOf: (componentKey: string) => ChainComponentState | undefined,
): ChainSkill[] {
  let nextAssigned = false;
  return chain.map((component, index) => {
    if (stateOf(component.key)?.started) {
      return { component, status: "started" };
    }
    const previous = index === 0 ? undefined : stateOf(chain[index - 1].key);
    const unlocked =
      index === 0 ||
      (previous?.started === true && previous.qualifiesForNextSkill);
    if (unlocked && !nextAssigned) {
      nextAssigned = true;
      return { component, status: "next" };
    }
    return { component, status: "locked" };
  });
}
