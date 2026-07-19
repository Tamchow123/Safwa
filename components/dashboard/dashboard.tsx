"use client";

/**
 * The Dashboard (Phase 12 §16): an approachable summary — overall word
 * completion and word counts, today's streak / active study time / due
 * reviews, daily-target progress against the Phase 11 session defaults, the
 * 14-day activity trend, and clear Start-studying / detailed-progress
 * actions. Every number arrives FINISHED from `useAnalyticsSnapshot`; this
 * file renders and never re-derives a formula. A brand-new learner sees an
 * honest zero state (real zeros, never fake percentages) with a motivating
 * next step.
 */
import Link from "next/link";

import { ActivityTrend } from "@/components/analytics/activity-trend";
import { AnalyticsSection } from "@/components/analytics/analytics-section";
import {
  formatRatio,
  ProgressTrack,
  RatioBar,
} from "@/components/analytics/ratio-bar";
import { SnapshotFallback } from "@/components/analytics/snapshot-fallback";
import {
  useAnalyticsSnapshot,
  type AnalyticsView,
} from "@/components/analytics/use-analytics-snapshot";
import { Button } from "@/components/ui/button";
import { formatStudyDuration } from "@/lib/format-duration";
import { formatDayCount, formatInt } from "@/lib/format-number";
import { useSessionDefaults } from "@/lib/preferences/use-session-defaults";
import { percentage } from "@/modules/analytics";
import type { SessionDefaults } from "@/modules/profile/session-defaults";

/**
 * One daily-target row (§12): the TEXT always shows the real count (specific
 * or manual modes can exceed the target); only the visual bar caps at 100%
 * (inside the shared track). A zero target renders as switched off — never
 * a division by zero.
 */
function TargetBar({
  label,
  done,
  target,
}: {
  label: string;
  done: number;
  target: number;
}) {
  if (target === 0) {
    return (
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span>{label}</span>
        <span className="text-muted-foreground">Off</span>
      </div>
    );
  }
  const valueText = `${formatInt(done)} of ${formatInt(target)}`;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span>{label}</span>
        <span className="text-muted-foreground tabular-nums">{valueText}</span>
      </div>
      <ProgressTrack
        ariaLabel={label}
        max={target}
        // ARIA requires valuenow within [min, max]; the real (possibly
        // exceeding) count stays in the value text.
        now={Math.min(done, target)}
        valueText={valueText}
        percent={percentage({ numerator: done, denominator: target }) ?? 0}
      />
    </div>
  );
}

function DashboardView({
  view,
  defaults,
}: {
  view: AnalyticsView;
  defaults: SessionDefaults;
}) {
  const zeroProgress =
    view.summary.wordStates.wordsStarted === 0 &&
    view.dailyActivity.length === 0;

  return (
    <div className="space-y-6">
      <AnalyticsSection
        headingId="dashboard-overview-heading"
        title="Your progress"
      >
        <p className="text-2xl font-semibold tracking-tight tabular-nums">
          {formatRatio(view.summary.overallCompletion)}{" "}
          <span className="text-muted-foreground text-base font-normal">
            words mastered
          </span>
        </p>
        <RatioBar
          label="Words mastered"
          accessibleLabel="Words mastered"
          ratio={view.summary.overallCompletion}
        />
        <dl className="grid grid-cols-3 gap-3 text-sm">
          <div>
            <dt className="text-muted-foreground">Not started</dt>
            <dd className="font-medium tabular-nums">
              {formatInt(view.summary.wordStates.wordsNotStarted)}
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
        {zeroProgress ? (
          <p className="text-muted-foreground text-sm">
            You haven&apos;t studied yet — your first session starts your
            streak.
          </p>
        ) : null}
      </AnalyticsSection>

      <AnalyticsSection headingId="dashboard-today-heading" title="Today">
        <dl
          aria-live="polite"
          className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3"
        >
          <div>
            <dt className="text-muted-foreground">Current streak</dt>
            <dd className="font-medium tabular-nums">
              {formatDayCount(view.streaks.current)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Study time today</dt>
            <dd className="font-medium tabular-nums">
              {formatStudyDuration(view.today.studyMs)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Reviews due today</dt>
            <dd
              className="font-medium tabular-nums"
              data-testid="due-today-count"
            >
              {formatInt(view.dueToday)}
            </dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-3">
          <Button asChild className="min-h-11">
            <Link href="/study">Start studying</Link>
          </Button>
          <Button asChild variant="outline" className="min-h-11">
            <Link href="/progress">View detailed progress</Link>
          </Button>
        </div>
      </AnalyticsSection>

      <AnalyticsSection
        headingId="dashboard-targets-heading"
        title="Daily targets"
      >
        <TargetBar
          label="New items today"
          done={view.today.newItems}
          target={defaults.newPerDay}
        />
        <TargetBar
          label="Reviews today"
          done={view.today.reviews}
          target={defaults.reviewsPerDay}
        />
      </AnalyticsSection>

      <AnalyticsSection
        headingId="dashboard-activity-heading"
        title="Recent activity"
      >
        <ActivityTrend
          label="Attempts per day over the last 14 days"
          endDate={view.todayLocalDate}
          days={14}
          activity={view.dailyActivity}
        />
      </AnalyticsSection>
    </div>
  );
}

/** Top-level dashboard: loads the snapshot, renders the summary sections. */
export function Dashboard() {
  const { state, retry } = useAnalyticsSnapshot();
  // The learner-editable daily targets (§12) — never duplicate settings.
  const { defaults, loaded: defaultsLoaded } = useSessionDefaults();

  // The error state wins over a pending defaults read: a failed analytics
  // load must surface its retry action even if the settings read hangs.
  if (state.status === "error") {
    return (
      <SnapshotFallback
        status="error"
        message={state.message}
        ariaLabel="Loading dashboard"
        retry={retry}
      />
    );
  }
  if (state.status === "loading" || !defaultsLoaded) {
    return (
      <SnapshotFallback
        status="loading"
        ariaLabel="Loading dashboard"
        retry={retry}
      />
    );
  }
  return <DashboardView view={state.view} defaults={defaults} />;
}
