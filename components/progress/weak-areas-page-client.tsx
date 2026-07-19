"use client";

/**
 * The Weak Areas page (Phase 13 §15-16): loads the ONE weakness snapshot
 * (`useWeaknessSnapshot`, sharing its raw analytics read with the
 * mixed-revision weak tier and the Custom Session weak filter — §22),
 * explains how weakness is measured, surfaces the top cross-dimension
 * practice priorities, and lets the learner browse the full ranked list per
 * dimension. Distinguishes "no study evidence yet" (`view.weaknessEvidence`
 * empty — nothing has ever been attempted) from "evidence exists but
 * nothing currently qualifies as weak" (an empty group list for a
 * particular view, shown by `WeaknessGroupList` itself) — neither is ever
 * rendered as an error (§15). Every value here — including the bāb/verb-type
 * Arabic-pair lookups — arrives FINISHED from `useWeaknessSnapshot`, exactly
 * like `use-analytics-snapshot.ts`/`ProgressDetails`: this component never
 * sees a raw `LearnerEntry` or re-derives a group-id -> Arabic-pair mapping.
 */
import Link from "next/link";
import { useState } from "react";

import { AnalyticsSection } from "@/components/analytics/analytics-section";
import { SnapshotFallback } from "@/components/analytics/snapshot-fallback";
import { useWeaknessSnapshot } from "@/components/analytics/use-weakness-snapshot";
import { Button } from "@/components/ui/button";
import {
  WEAKNESS_DIMENSION_LABELS,
  WeaknessDimensionTabs,
  type WeakAreasTab,
} from "@/components/progress/weakness-dimension-tabs";
import { WeaknessEmptyState } from "@/components/progress/weakness-empty-state";
import { WeaknessExplanation } from "@/components/progress/weakness-explanation";
import { WeaknessGroupList } from "@/components/progress/weakness-group-list";
import { WeaknessSummary } from "@/components/progress/weakness-summary";
import type { WeaknessView } from "@/modules/analytics/weakness-persistence";

/** Section title for the main ranked list, per selected dimension tab —
 * shares its six dimension entries with the tab buttons themselves so the
 * button and its section heading can never disagree. */
const LIST_SECTION_TITLES: Record<WeakAreasTab, string> = {
  overview: "All weak areas",
  ...WEAKNESS_DIMENSION_LABELS,
};

function WeakAreasView({
  view,
  babArabic,
  verbTypeArabic,
  nowMs,
}: {
  view: WeaknessView;
  babArabic: ReadonlyMap<string, string>;
  verbTypeArabic: ReadonlyMap<string, string>;
  nowMs: number;
}) {
  const [tab, setTab] = useState<WeakAreasTab>("overview");

  if (view.weaknessEvidence.size === 0) {
    return (
      <div className="space-y-6">
        <WeaknessExplanation />
        <WeaknessEmptyState variant="no-evidence" />
      </div>
    );
  }

  const selectedGroups =
    tab === "overview" ? view.topOverall : view.groups[tab];

  return (
    <div className="space-y-6">
      <WeaknessExplanation />
      <WeaknessSummary
        topOverall={view.topOverall}
        babArabic={babArabic}
        verbTypeArabic={verbTypeArabic}
        nowMs={nowMs}
      />
      <WeaknessDimensionTabs selected={tab} onSelect={setTab} />
      <AnalyticsSection
        headingId="weak-areas-list-heading"
        title={LIST_SECTION_TITLES[tab]}
      >
        <WeaknessGroupList
          groups={selectedGroups}
          babArabic={babArabic}
          verbTypeArabic={verbTypeArabic}
          nowMs={nowMs}
        />
      </AnalyticsSection>
      <div>
        <Button asChild variant="outline" className="min-h-11">
          <Link href="/progress">Back to Progress</Link>
        </Button>
      </div>
    </div>
  );
}

/** Top-level Weak Areas page: loads the snapshot, renders every section. */
export function WeakAreasPageClient() {
  const { state, retry } = useWeaknessSnapshot();

  if (state.status === "loading") {
    return (
      <SnapshotFallback
        status="loading"
        ariaLabel="Loading weak areas"
        retry={retry}
      />
    );
  }
  if (state.status === "error") {
    return (
      <SnapshotFallback
        status="error"
        message={state.message}
        ariaLabel="Loading weak areas"
        retry={retry}
      />
    );
  }
  return (
    <WeakAreasView
      view={state.view}
      babArabic={state.babArabic}
      verbTypeArabic={state.verbTypeArabic}
      nowMs={state.nowMs}
    />
  );
}
