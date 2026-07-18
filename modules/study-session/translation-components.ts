/**
 * Shared eligible-translation-component selection (pure) — the single choke
 * point that flashcards (Phase 8) and multiple-choice vocabulary quizzes
 * (Phase 9) both use to pick which components a translation study session may
 * present.
 *
 * A translation component is `(entry, skill, source_field, direction)` — a
 * direction (Ar→En recognition / En→Ar recall) over a source form field.
 * Candidates come exclusively from the shared derivation choke point
 * (`deriveAllComponents`), which yields a component only when every field it
 * depends on is quiz-eligible — so an ineligible field can NEVER become a
 * prompt, answer or distractor (CLAUDE.md hard rule 2). This module only
 * filters and never re-derives eligibility itself.
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

/** Direction choice: a specific translation direction or a random mix of both. */
export type TranslationDirectionChoice = Direction | "random";

/** Field choice: a specific source form or any random eligible source form. */
export type TranslationFieldChoice = SourceQuizFormField | "random";

/** Recognition (Ar→En) / recall (En→Ar), or a random mix of both directions. */
function skillMatchesDirection(
  component: DerivedComponent,
  direction: TranslationDirectionChoice,
): boolean {
  if (direction === "random") return true;
  return component.direction === direction;
}

function fieldMatches(
  component: DerivedComponent,
  field: TranslationFieldChoice,
): boolean {
  if (field === "random") return true;
  return component.sourceField === field;
}

/**
 * Every eligible translation component for the loaded entries matching the
 * direction/field choice, in stable derivation order. Only `form_direction`
 * (translation) components qualify; entry-level (bāb/root/verb-type) components
 * are never translation components.
 */
export function eligibleTranslationComponents(
  entries: readonly LearnerEntry[],
  direction: TranslationDirectionChoice,
  field: TranslationFieldChoice,
): DerivedComponent[] {
  return deriveAllComponents(entries).filter(
    (component) =>
      component.componentShape === "form_direction" &&
      skillMatchesDirection(component, direction) &&
      fieldMatches(component, field),
  );
}

/** The component identity `createSession` consumes for a translation component. */
export function translationComponentToIdentity(
  component: DerivedComponent,
): ComponentIdentity {
  return {
    entryId: component.entryId,
    skillType: component.skillType,
    sourceField: component.sourceField,
    direction: component.direction,
  };
}
