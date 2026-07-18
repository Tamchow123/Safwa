/**
 * Entry-level quiz planning (pure) — bāb and root identification
 * (PRODUCT_REQUIREMENTS.md §4.3, Phase 10).
 *
 * These quizzes study ENTRY-LEVEL components: one component per entry per
 * skill, prompted with a chosen eligible source form. Candidates come
 * exclusively from the shared derivation choke point (`deriveAllComponents`),
 * which yields a bāb component only when `quiz_eligibility.bab` is true and a
 * root component only when `quiz_eligibility.root` is true — so an entry with
 * an unverified root (369/372) can NEVER become a root target (CLAUDE.md hard
 * rule 2). This module filters and orders that already-gated set; it never
 * re-derives eligibility itself.
 *
 * The prompt form is configurable (default māḍī; a specific form restricts the
 * plan to entries where that form is eligible; "random" picks a seeded random
 * eligible form per entry) and travels on the plan item, so the generator
 * prompts with it and the attempt records it (`attempt.promptField`).
 *
 * The plan is a pure function of (entries, config, seed) with an injected RNG
 * seed, so a session plan is reproducible and never calls Math.random/Date.now.
 *
 * Pure TypeScript: no React, DOM or DB imports (docs/ARCHITECTURE.md §2).
 */
import {
  SOURCE_QUIZ_FORM_FIELDS,
  type SourceQuizFormField,
} from "@/modules/content/constants";
import type { LearnerEntry } from "@/modules/content/schema";

import {
  deriveAllComponents,
  type DerivedComponent,
} from "@/modules/study-engine/components";
import { isFieldEligible } from "@/modules/study-engine/fields";
import { DEFAULT_ENTRY_LEVEL_PROMPT_FORM } from "@/modules/study-engine/generator";
import type { ComponentIdentity } from "@/modules/study-engine/natural-key";
import { createRng, type Rng } from "@/modules/study-engine/rng";
import { DEFAULT_QUIZ_COUNT } from "@/modules/study-session/quizzes";

/** The entry-level skills with a learner-facing quiz mode (Phase 10). */
export const ENTRY_QUIZ_SKILLS = [
  "bab_identification",
  "root_identification",
] as const;
export type EntryQuizSkill = (typeof ENTRY_QUIZ_SKILLS)[number];

/** Prompt-form choice: a specific source form or a random eligible form. */
export type PromptFormChoice = SourceQuizFormField | "random";

export type EntryQuizConfig = {
  skill: EntryQuizSkill;
  promptForm: PromptFormChoice;
};

/** Default bāb quiz — the documented default māḍī prompt (§4.3). */
export const DEFAULT_BAB_QUIZ_CONFIG: EntryQuizConfig = {
  skill: "bab_identification",
  promptForm: DEFAULT_ENTRY_LEVEL_PROMPT_FORM,
};

/** Default root quiz — same default māḍī prompt as the bāb quiz. */
export const DEFAULT_ROOT_QUIZ_CONFIG: EntryQuizConfig = {
  skill: "root_identification",
  promptForm: DEFAULT_ENTRY_LEVEL_PROMPT_FORM,
};

/** The source forms this entry may be prompted with (eligible forms only). */
export function eligiblePromptForms(
  entry: LearnerEntry,
): SourceQuizFormField[] {
  return SOURCE_QUIZ_FORM_FIELDS.filter((field) =>
    isFieldEligible(entry, field),
  );
}

/**
 * Every eligible entry-level quiz component for the loaded entries matching the
 * config, in stable derivation order. A specific prompt-form choice keeps only
 * entries where that form is eligible (a prompt is never shown with an
 * ineligible field); "random" keeps entries with at least one eligible form.
 */
export function eligibleEntryQuizComponents(
  entries: readonly LearnerEntry[],
  config: EntryQuizConfig,
): DerivedComponent[] {
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  return deriveAllComponents(entries).filter((component) => {
    if (component.skillType !== config.skill) return false;
    const entry = entriesById.get(component.entryId)!;
    if (config.promptForm === "random") {
      return eligiblePromptForms(entry).length > 0;
    }
    return isFieldEligible(entry, config.promptForm);
  });
}

/** A planned entry-level quiz item for `createSession`. */
export type EntryQuizPlanItem = {
  identity: ComponentIdentity;
  /** The resolved prompt form for this item (always an eligible form). */
  promptForm: SourceQuizFormField;
};

function resolvePromptForm(
  entry: LearnerEntry,
  choice: PromptFormChoice,
  rng: Rng,
): SourceQuizFormField {
  if (choice !== "random") return choice;
  const forms = eligiblePromptForms(entry);
  // eligibleEntryQuizComponents already excluded zero-form entries.
  return forms[rng.int(forms.length)];
}

/**
 * Build a deterministic entry-level quiz plan: filter to eligible components
 * matching the config, shuffle with the injected seed, take up to `count`, and
 * resolve each item's prompt form (specific, or seeded-random among the entry's
 * eligible forms). An empty result (no eligible components for the config) is a
 * valid outcome the caller handles with an empty-state, never an error.
 */
export function buildEntryQuizPlan(
  entries: readonly LearnerEntry[],
  config: EntryQuizConfig,
  seed: string,
  count: number = DEFAULT_QUIZ_COUNT,
): EntryQuizPlanItem[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(
      `entry quiz count must be a positive integer, got ${count}`,
    );
  }
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const eligible = eligibleEntryQuizComponents(entries, config);
  const rng = createRng(seed);
  const shuffled = rng.shuffle(eligible);
  return shuffled.slice(0, count).map((component) => ({
    identity: { entryId: component.entryId, skillType: component.skillType },
    promptForm: resolvePromptForm(
      entriesById.get(component.entryId)!,
      config.promptForm,
      rng,
    ),
  }));
}
