"use client";

/**
 * Renders one ranked list of weak-area groups (Phase 13 §14, §15): resolves
 * each group's learner-facing label from its OWN `group.dimension` field
 * (so the same list renders both the merged Overview list and a single
 * dimension's list without duplicating label logic), and falls back to the
 * "evidence exists but no current weakness" empty state when the list is
 * empty — never rendered as an error (§15).
 *
 * bāb/verb-type labels are the exact Arabic display pair from the release
 * (hard rules 3 & 5 — never a number or internal id); the caller supplies
 * the resolved lookup maps (built once from the loaded entries) so this list
 * never re-derives them per render.
 */
import type { ReactNode } from "react";

import { ArabicText } from "@/components/arabic-text";
import { WeaknessEmptyState } from "@/components/progress/weakness-empty-state";
import { WeaknessGroupCard } from "@/components/progress/weakness-group-card";
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

function resolveGroupLabel(
  group: WeaknessGroup,
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

export function WeaknessGroupList({
  groups,
  babArabic,
  verbTypeArabic,
  nowMs,
}: {
  groups: readonly WeaknessGroup[];
  babArabic: ReadonlyMap<string, string>;
  verbTypeArabic: ReadonlyMap<string, string>;
  nowMs: number;
}) {
  if (groups.length === 0) {
    return <WeaknessEmptyState variant="no-weakness" />;
  }

  return (
    <ul className="space-y-3">
      {groups.map((group) => {
        const { label, accessibleLabel } = resolveGroupLabel(
          group,
          babArabic,
          verbTypeArabic,
        );
        return (
          <li key={`${group.dimension}:${group.value}`}>
            <WeaknessGroupCard
              label={label}
              accessibleLabel={accessibleLabel}
              group={group}
              drillHref={`/study/weak?dimension=${group.dimension}&value=${encodeURIComponent(group.value)}`}
              nowMs={nowMs}
            />
          </li>
        );
      })}
    </ul>
  );
}
