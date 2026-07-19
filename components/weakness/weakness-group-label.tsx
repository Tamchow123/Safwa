/**
 * Learner-facing label resolution for one weakness group's `dimension` +
 * `value` (Phase 13 §14-15) — the ONE place this resolves, shared by the
 * Weak Areas page (`components/progress/weakness-group-list.tsx`) and the
 * weak-drill session's context header (`components/study/weak-drill-session.tsx`).
 * Kept neutral (not owned by either feature directory), mirroring how
 * `modules/analytics/progress.ts`'s `groupArabicLookup` is a neutral pure
 * helper shared by the Progress and Weak Areas hooks — never a second,
 * feature-owned implementation of the same resolution.
 *
 * bāb/verb-type labels are the exact Arabic display pair from the release
 * (hard rules 3 & 5 — never a number or internal id); the caller supplies
 * the resolved lookup maps.
 */
import type { ReactNode } from "react";

import { ArabicText } from "@/components/arabic-text";
import { SOURCE_FORM_METADATA } from "@/lib/form-metadata";
import { SKILL_LABELS } from "@/lib/skill-labels";
import type {
  Direction,
  SkillType,
  SourceQuizFormField,
} from "@/modules/content/constants";
import type { WeaknessGroup } from "@/modules/analytics/weakness-groups";
import type { LearnerState } from "@/modules/scheduler/states";

const DIRECTION_LABELS: Record<Direction, string> = {
  arabic_to_english: "Arabic → English",
  english_to_arabic: "English → Arabic",
};

const STATE_LABELS: Record<LearnerState, string> = {
  not_started: "Not started",
  learning: "Learning",
  mastered: "Mastered",
  needs_review: "Needs review",
};

export function resolveWeaknessGroupLabel(
  group: Pick<WeaknessGroup, "dimension" | "value">,
  babArabic: ReadonlyMap<string, string>,
  verbTypeArabic: ReadonlyMap<string, string>,
): { label: ReactNode; accessibleLabel: string } {
  switch (group.dimension) {
    case "bab": {
      const arabic = babArabic.get(group.value) ?? group.value;
      return {
        label: <ArabicText>{arabic}</ArabicText>,
        accessibleLabel: arabic,
      };
    }
    case "verb_type": {
      const arabic = verbTypeArabic.get(group.value) ?? group.value;
      return {
        label: <ArabicText>{arabic}</ArabicText>,
        accessibleLabel: arabic,
      };
    }
    case "source_form": {
      const label =
        SOURCE_FORM_METADATA[group.value as SourceQuizFormField].label;
      return { label, accessibleLabel: label };
    }
    case "direction": {
      const label = DIRECTION_LABELS[group.value as Direction] ?? group.value;
      return { label, accessibleLabel: label };
    }
    case "skill": {
      const label = SKILL_LABELS[group.value as SkillType] ?? group.value;
      return { label, accessibleLabel: label };
    }
    case "state": {
      const label = STATE_LABELS[group.value as LearnerState] ?? group.value;
      return { label, accessibleLabel: label };
    }
  }
}
