/**
 * Flashcard session planning (pure) — eligible-component selection and the
 * deterministic plan builder for the flashcard study mode
 * (PRODUCT_REQUIREMENTS.md §4.3).
 *
 * Flashcards are TRANSLATION-only (`form_direction`) components: a direction
 * (Ar→En recognition / En→Ar recall) over a source form field. Candidates come
 * exclusively from the shared derivation choke point
 * (`deriveComponentsForEntry`), which yields a component only when every field
 * it depends on is quiz-eligible — so an ineligible field can NEVER become a
 * flashcard prompt or answer (CLAUDE.md hard rule 2). This module only filters
 * and orders that already-gated set; it never re-derives eligibility itself.
 *
 * The plan is a pure function of (entries, config, seed) with an injected RNG
 * seed, so a session plan is reproducible and never calls Math.random/Date.now.
 *
 * Pure TypeScript: no React, DOM or DB imports (docs/ARCHITECTURE.md §2).
 */
import type {
  Direction,
  SourceQuizFormField,
} from "@/modules/content/constants";
import type { LearnerEntry } from "@/modules/content/schema";

import {
  deriveAllComponents,
  type DerivedComponent,
} from "@/modules/study-engine/components";
import type { ComponentIdentity } from "@/modules/study-engine/natural-key";
import { createRng } from "@/modules/study-engine/rng";

/** Direction choice: a specific translation direction or a random mix of both. */
export type FlashcardDirectionChoice = Direction | "random";

/** Field choice: a specific source form or any random eligible source form. */
export type FlashcardFieldChoice = SourceQuizFormField | "random";

export type FlashcardConfig = {
  direction: FlashcardDirectionChoice;
  field: FlashcardFieldChoice;
};

/** Default questions/session (§4.4). */
export const DEFAULT_FLASHCARD_COUNT = 20;

/**
 * Default flashcard configuration — random direction over a random eligible
 * field. This is the zero-configuration session the flashcards route
 * auto-starts (acceptance A1: first card in ≤2 taps from landing).
 */
export const DEFAULT_FLASHCARD_CONFIG: FlashcardConfig = {
  direction: "random",
  field: "random",
};

/** The recognition (Ar→En) direction studies the meaning-recognition skill. */
function skillMatchesDirection(
  component: DerivedComponent,
  direction: FlashcardDirectionChoice,
): boolean {
  if (direction === "random") return true;
  return component.direction === direction;
}

function fieldMatches(
  component: DerivedComponent,
  field: FlashcardFieldChoice,
): boolean {
  if (field === "random") return true;
  return component.sourceField === field;
}

/**
 * Every eligible flashcard component for the loaded entries matching the
 * config, in stable derivation order. Only `form_direction` (translation)
 * components qualify; entry-level (bāb/root/verb-type) components are never
 * flashcards.
 */
export function eligibleFlashcardComponents(
  entries: readonly LearnerEntry[],
  config: FlashcardConfig,
): DerivedComponent[] {
  return deriveAllComponents(entries).filter(
    (component) =>
      component.componentShape === "form_direction" &&
      skillMatchesDirection(component, config.direction) &&
      fieldMatches(component, config.field),
  );
}

/** A planned flashcard item — a component identity for `createSession`. */
export type FlashcardPlanItem = {
  identity: ComponentIdentity;
};

function toIdentity(component: DerivedComponent): ComponentIdentity {
  return {
    entryId: component.entryId,
    skillType: component.skillType,
    sourceField: component.sourceField,
    direction: component.direction,
  };
}

/**
 * Build a deterministic flashcard plan: filter to eligible components matching
 * the config, shuffle with the injected seed, and take up to `count`. Returns
 * the items in the order `createSession` should receive them. An empty result
 * (no eligible components for the config) is a valid outcome the caller handles
 * with an empty-state, never an error.
 */
export function buildFlashcardPlan(
  entries: readonly LearnerEntry[],
  config: FlashcardConfig,
  seed: string,
  count: number = DEFAULT_FLASHCARD_COUNT,
): FlashcardPlanItem[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`flashcard count must be a positive integer, got ${count}`);
  }
  const eligible = eligibleFlashcardComponents(entries, config);
  const shuffled = createRng(seed).shuffle(eligible);
  return shuffled.slice(0, count).map((component) => ({
    identity: toIdentity(component),
  }));
}
