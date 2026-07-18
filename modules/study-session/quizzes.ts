/**
 * Multiple-choice vocabulary quiz planning (pure) — eligible-component
 * selection and the deterministic plan builder for the Ar→En and En→Ar MC
 * study modes (PRODUCT_REQUIREMENTS.md §4.3).
 *
 * MC vocabulary quizzes study the same TRANSLATION (`form_direction`)
 * components as flashcards — a direction (Ar→En recognition / En→Ar recall)
 * over a source form field — but present them as four-option questions. This
 * phase covers translation quizzes only; bāb/root/verb-type quizzes are Phase
 * 10. Candidates come from the shared translation-component choke point, so an
 * ineligible field can never become a prompt, answer or distractor (CLAUDE.md
 * hard rule 2). This module filters and orders that already-gated set; it never
 * re-derives eligibility itself.
 *
 * The plan is a pure function of (entries, config, seed) with an injected RNG
 * seed, so a session plan is reproducible and never calls Math.random/Date.now.
 *
 * Pure TypeScript: no React, DOM or DB imports (docs/ARCHITECTURE.md §2).
 */
import type { LearnerEntry } from "@/modules/content/schema";

import type { DerivedComponent } from "@/modules/study-engine/components";
import type { ComponentIdentity } from "@/modules/study-engine/natural-key";
import { createRng } from "@/modules/study-engine/rng";
import {
  eligibleTranslationComponents,
  translationComponentToIdentity,
  type TranslationDirectionChoice,
  type TranslationFieldChoice,
} from "@/modules/study-session/translation-components";

/** Direction choice: a specific translation direction or a random mix of both. */
export type QuizDirectionChoice = TranslationDirectionChoice;

/** Field choice: a specific source form or any random eligible source form. */
export type QuizFieldChoice = TranslationFieldChoice;

/** How per-question correctness is delivered (immediate vs withheld/timed). */
export type QuizDelivery = "immediate" | "test" | "timed";

export type McQuizConfig = {
  direction: QuizDirectionChoice;
  field: QuizFieldChoice;
  /** Immediate feedback, test mode (feedback withheld) or timed countdown. */
  delivery: QuizDelivery;
};

/** Default questions/session (§4.4). */
export const DEFAULT_QUIZ_COUNT = 20;

/**
 * Default MC quiz configuration — Arabic→English recognition over a random
 * eligible field with immediate feedback. Ar→En is the first documented MC mode
 * (§4.3) and gives a new learner a sensible zero-configuration session.
 */
export const DEFAULT_MC_QUIZ_CONFIG: McQuizConfig = {
  direction: "arabic_to_english",
  field: "random",
  delivery: "immediate",
};

/**
 * Every eligible MC-quiz component for the loaded entries matching the config,
 * in stable derivation order. Delegates to the shared translation-component
 * choke point (only `form_direction` components qualify).
 */
export function eligibleQuizComponents(
  entries: readonly LearnerEntry[],
  config: McQuizConfig,
): DerivedComponent[] {
  return eligibleTranslationComponents(entries, config.direction, config.field);
}

/** A planned quiz item — a component identity for `createSession`. */
export type QuizPlanItem = {
  identity: ComponentIdentity;
};

/**
 * Build a deterministic MC quiz plan: filter to eligible components matching the
 * config, shuffle with the injected seed, and take up to `count`. Returns the
 * items in the order `createSession` should receive them. An empty result (no
 * eligible components for the config) is a valid outcome the caller handles with
 * an empty-state, never an error.
 */
export function buildQuizPlan(
  entries: readonly LearnerEntry[],
  config: McQuizConfig,
  seed: string,
  count: number = DEFAULT_QUIZ_COUNT,
): QuizPlanItem[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`quiz count must be a positive integer, got ${count}`);
  }
  const eligible = eligibleQuizComponents(entries, config);
  const shuffled = createRng(seed).shuffle(eligible);
  return shuffled.slice(0, count).map((component) => ({
    identity: translationComponentToIdentity(component),
  }));
}
