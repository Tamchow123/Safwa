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
import { WeaknessEmptyState } from "@/components/progress/weakness-empty-state";
import { WeaknessGroupCard } from "@/components/progress/weakness-group-card";
import { resolveWeaknessGroupLabel } from "@/components/weakness/weakness-group-label";
import type { WeaknessGroup } from "@/modules/analytics/weakness-groups";

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
        const { label, accessibleLabel } = resolveWeaknessGroupLabel(
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
