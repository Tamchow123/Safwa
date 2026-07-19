/**
 * The single shared learner-facing label map for the five skill dimensions.
 * UI chrome only (English) — never dataset Arabic. Both the Progress page
 * and the Weak Areas page display these; components must not carry their
 * own copies (mirrors `lib/form-metadata.ts`'s SOURCE_FORM_METADATA).
 *
 * Pure TypeScript: no React, DOM or DB imports.
 */
import type { SkillType } from "@/modules/content/constants";

export const SKILL_LABELS: Record<SkillType, string> = {
  meaning_recognition: "Meaning recognition (Arabic → English)",
  meaning_recall: "Meaning recall (English → Arabic)",
  bab_identification: "Bāb identification",
  root_identification: "Root identification",
  verb_type_identification: "Verb type identification",
};
