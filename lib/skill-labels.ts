/**
 * The single shared learner-facing label maps for the five skill dimensions
 * and the four learner states. UI chrome only (English) — never dataset
 * Arabic. The Progress, Weak Areas and entry pages display these; components
 * must not carry their own copies (mirrors `lib/form-metadata.ts`'s SOURCE_FORM_METADATA).
 *
 * Pure TypeScript: no React, DOM or DB imports.
 */
import type { SkillType } from "@/modules/content/constants";
import type { LearnerState } from "@/modules/scheduler/states";

export const SKILL_LABELS: Record<SkillType, string> = {
  meaning_recognition: "Meaning recognition (Arabic → English)",
  meaning_recall: "Meaning recall (English → Arabic)",
  bab_identification: "Bāb identification",
  root_identification: "Root identification",
  verb_type_identification: "Verb type identification",
};

/** The learner-facing label for each learner state (§5). */
export const LEARNER_STATE_LABELS: Record<LearnerState, string> = {
  not_started: "Not started",
  learning: "Learning",
  mastered: "Mastered",
  needs_review: "Needs review",
};
