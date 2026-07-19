"use client";

/**
 * The detailed Progress page (Phase 12 §17): exact-ratio completion for the
 * overall word set, all eligible components, each skill, each source form
 * (shared form metadata), restrained bāb / verb-type sections (Arabic display
 * pairs from the release — hard rules 3 & 5, never a number or internal id),
 * both streaks and a longer activity summary. Every number arrives FINISHED
 * from `useAnalyticsSnapshot`; no formulas here.
 *
 * The Weak Areas section (Phase 13 §15) is deliberately CONCISE — the top
 * three cross-dimension priorities and a link to the full `/progress/
 * weak-areas` page, never the complete ranked/tabbed analysis that page
 * owns. It loads its own `useWeaknessSnapshot()` (mirrors this page's own
 * `useAnalyticsSnapshot()` pattern) so a slow/failed weakness read degrades
 * only that one section, never the exact-ratio numbers above it. This is the
 * first page to mount two independent snapshot hooks over the SAME loaded
 * release; the underlying content load and component derivation are each
 * coalesced to run once (`useActiveContent`'s in-flight promise share,
 * `lib/derived-components-cache.ts`), so composing the two hooks here never
 * doubles the network/verification/derivation cost.
 */
import Link from "next/link";
import type { ReactNode } from "react";

import { ActivityTrend } from "@/components/analytics/activity-trend";
import { AnalyticsSection } from "@/components/analytics/analytics-section";
import { RatioBar } from "@/components/analytics/ratio-bar";
import { SnapshotFallback } from "@/components/analytics/snapshot-fallback";
import {
  useAnalyticsSnapshot,
  type AnalyticsView,
  type GroupCompletion,
} from "@/components/analytics/use-analytics-snapshot";
import { useWeaknessSnapshot } from "@/components/analytics/use-weakness-snapshot";
import { ArabicText } from "@/components/arabic-text";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { WeaknessEmptyState } from "@/components/progress/weakness-empty-state";
import { WeaknessGroupList } from "@/components/progress/weakness-group-list";
import { formatDayCount, formatInt } from "@/lib/format-number";
import {
  SOURCE_FORM_METADATA,
  SOURCE_QUIZ_FORM_FIELDS,
} from "@/lib/form-metadata";
import { SKILL_LABELS } from "@/lib/skill-labels";
import { SKILL_TYPES } from "@/modules/content/constants";

/** The top cross-dimension priorities (§15), never the full ranked list —
 * that stays on the dedicated Weak Areas page. */
const PROGRESS_WEAK_AREAS_LIMIT = 3;

function ProgressWeakAreasSection() {
  const { state, retry } = useWeaknessSnapshot();

  let body: ReactNode;
  if (state.status === "loading") {
    body = (
      <div className="space-y-2" role="status" aria-label="Loading weak areas">
        <Skeleton className="h-16 w-full rounded-xl" />
        <span className="sr-only">Loading…</span>
      </div>
    );
  } else if (state.status === "error") {
    body = (
      <div role="alert" className="space-y-3">
        <p className="text-destructive text-sm">{state.message}</p>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={retry}
        >
          Retry
        </Button>
      </div>
    );
  } else if (state.view.weaknessEvidence.size === 0) {
    body = <WeaknessEmptyState variant="no-evidence" />;
  } else {
    body = (
      <WeaknessGroupList
        groups={state.view.topOverall.slice(0, PROGRESS_WEAK_AREAS_LIMIT)}
        babArabic={state.babArabic}
        verbTypeArabic={state.verbTypeArabic}
        nowMs={state.nowMs}
      />
    );
  }

  return (
    <AnalyticsSection
      headingId="progress-weak-areas-heading"
      title="Weak areas"
    >
      {body}
      <div>
        <Button asChild variant="outline" className="min-h-11">
          <Link href="/progress/weak-areas">See all weak areas</Link>
        </Button>
      </div>
    </AnalyticsSection>
  );
}

/** Bāb / verb-type completion bars labelled by their Arabic display pair. */
function GroupBars({ groups }: { groups: readonly GroupCompletion[] }) {
  return (
    <>
      {groups.map((group) => (
        <RatioBar
          key={group.id}
          label={<ArabicText>{group.arabic}</ArabicText>}
          accessibleLabel={group.arabic}
          ratio={group.ratio}
        />
      ))}
    </>
  );
}

function ProgressView({ view }: { view: AnalyticsView }) {
  return (
    <div className="space-y-6">
      <AnalyticsSection headingId="progress-overview-heading" title="Overview">
        <RatioBar
          label="Words mastered"
          accessibleLabel="Words mastered"
          ratio={view.summary.overallCompletion}
        />
        <RatioBar
          label="Components mastered"
          accessibleLabel="Components mastered"
          ratio={view.summary.componentMastery}
        />
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Not started</dt>
            <dd className="font-medium tabular-nums">
              {formatInt(view.summary.wordStates.wordsNotStarted)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Started</dt>
            <dd className="font-medium tabular-nums">
              {formatInt(view.summary.wordStates.wordsStarted)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Learning</dt>
            <dd className="font-medium tabular-nums">
              {formatInt(view.summary.wordStates.wordsLearning)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Mastered</dt>
            <dd className="font-medium tabular-nums">
              {formatInt(view.summary.wordStates.wordsMastered)}
            </dd>
          </div>
        </dl>
      </AnalyticsSection>

      <AnalyticsSection headingId="progress-skill-heading" title="By skill">
        {SKILL_TYPES.map((skill) => (
          <RatioBar
            key={skill}
            label={SKILL_LABELS[skill]}
            accessibleLabel={SKILL_LABELS[skill]}
            ratio={view.summary.perSkill[skill]}
          />
        ))}
      </AnalyticsSection>

      <AnalyticsSection headingId="progress-form-heading" title="By form">
        {SOURCE_QUIZ_FORM_FIELDS.map((field) => (
          <RatioBar
            key={field}
            label={SOURCE_FORM_METADATA[field].label}
            accessibleLabel={SOURCE_FORM_METADATA[field].label}
            ratio={view.summary.perForm[field]}
          />
        ))}
      </AnalyticsSection>

      <AnalyticsSection headingId="progress-streaks-heading" title="Streaks">
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-muted-foreground">Current streak</dt>
            <dd className="font-medium tabular-nums">
              {formatDayCount(view.streaks.current)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Longest streak</dt>
            <dd className="font-medium tabular-nums">
              {formatDayCount(view.streaks.longest)}
            </dd>
          </div>
        </dl>
      </AnalyticsSection>

      <AnalyticsSection
        headingId="progress-activity-heading"
        title="Recent activity"
      >
        <ActivityTrend
          label="Attempts per day over the last 30 days"
          endDate={view.todayLocalDate}
          days={30}
          activity={view.dailyActivity}
        />
      </AnalyticsSection>

      <AnalyticsSection headingId="progress-bab-heading" title="By bāb">
        <GroupBars groups={view.babCompletion} />
      </AnalyticsSection>

      <AnalyticsSection
        headingId="progress-verb-type-heading"
        title="By verb type"
      >
        <GroupBars groups={view.verbTypeCompletion} />
      </AnalyticsSection>

      <ProgressWeakAreasSection />

      <div>
        <Button asChild className="min-h-11">
          <Link href="/study">Go to Study</Link>
        </Button>
      </div>
    </div>
  );
}

/** Top-level Progress page: loads the snapshot, renders every section. */
export function ProgressDetails() {
  const { state, retry } = useAnalyticsSnapshot();

  if (state.status === "loading") {
    return (
      <SnapshotFallback
        status="loading"
        ariaLabel="Loading progress"
        retry={retry}
      />
    );
  }
  if (state.status === "error") {
    return (
      <SnapshotFallback
        status="error"
        message={state.message}
        ariaLabel="Loading progress"
        retry={retry}
      />
    );
  }
  return <ProgressView view={state.view} />;
}
