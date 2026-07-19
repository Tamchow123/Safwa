"use client";

/**
 * "Top practice priorities" (Phase 13 §15): the merged, top cross-dimension
 * weak-area groups (`WeaknessView.topOverall`), in the same card/list idiom
 * as the per-dimension lists below it.
 */
import { AnalyticsSection } from "@/components/analytics/analytics-section";
import { WeaknessGroupList } from "@/components/progress/weakness-group-list";
import type { WeaknessGroup } from "@/modules/analytics/weakness-groups";

export function WeaknessSummary({
  topOverall,
  babArabic,
  verbTypeArabic,
  nowMs,
}: {
  topOverall: readonly WeaknessGroup[];
  babArabic: ReadonlyMap<string, string>;
  verbTypeArabic: ReadonlyMap<string, string>;
  nowMs: number;
}) {
  return (
    <AnalyticsSection
      headingId="weak-areas-summary-heading"
      title="Top practice priorities"
    >
      <WeaknessGroupList
        groups={topOverall}
        babArabic={babArabic}
        verbTypeArabic={verbTypeArabic}
        nowMs={nowMs}
      />
    </AnalyticsSection>
  );
}
