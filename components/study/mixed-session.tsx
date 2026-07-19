"use client";

/**
 * The zero-configuration "Start studying" mixed-revision session (Phase 10,
 * §4.3). No options bar: the plan is due reviews first, then weak items
 * (recent first-attempt accuracy heuristic v1), then new items, within
 * whatever remains of TODAY's daily targets (repeated same-day sessions share
 * one daily allowance). A brand-new guest with no history gets a plan of new
 * items — a sensible session with zero configuration.
 */
import { useCallback, useState } from "react";

import { useActiveContent } from "@/components/content/use-active-content";
import {
  ContentStateFallback,
  QuizRunner,
  type QuizPlanEntry,
} from "@/components/study/quiz-runner";
import { browserClock } from "@/components/study/study-shared";
import { useSessionDefaults } from "@/lib/preferences/use-session-defaults";
import { getSafwaDb } from "@/modules/content/db";
import type { LearnerEntry } from "@/modules/content/schema";
import { computeEventTimeFields } from "@/modules/study-engine/attempts";
import {
  buildMixedPlan,
  computeWeakScores,
  remainingDailyTargets,
} from "@/modules/study-session/mixed";
import { readSchedulingSnapshot } from "@/modules/study-session/persistence";

/** Top-level: loads content, reads local scheduling state, mounts the runner. */
export function MixedSession() {
  const { state, retry } = useActiveContent();
  // The learner-editable session defaults (§4.4): daily targets + count.
  const { defaults, loaded: defaultsLoaded } = useSessionDefaults();
  // Bumping this token remounts the runner, starting a fresh session (used by
  // "Study again").
  const [sessionToken, setSessionToken] = useState(0);

  const buildPlan = useCallback(
    async (entries: LearnerEntry[]): Promise<QuizPlanEntry[]> => {
      const snapshot = await readSchedulingSnapshot(getSafwaDb());
      const weakScores = computeWeakScores(snapshot.attempts);
      // Today's REMAINING budgets: the local date uses the same clock/zone
      // scheme the events themselves were stamped with, so consumption and
      // rollover agree with the recorded history. The full daily targets are
      // the user's configured new/day + reviews/day (§4.4 defaults 10 · 20).
      const clock = browserClock();
      const nowMs = clock.now();
      const localDate = computeEventTimeFields(nowMs, clock).localDateAtEvent;
      const targets = remainingDailyTargets(snapshot.events, localDate, {
        newLimit: defaults.newPerDay,
        reviewLimit: defaults.reviewsPerDay,
      });
      return buildMixedPlan(
        entries,
        snapshot.components,
        weakScores,
        nowMs,
        targets,
        defaults.questionCount,
      );
    },
    [defaults.newPerDay, defaults.reviewsPerDay, defaults.questionCount],
  );

  if (
    state.status === "loading" ||
    state.status === "error" ||
    !defaultsLoaded
  ) {
    return (
      <ContentStateFallback
        status={state.status === "error" ? "error" : "loading"}
        message={state.status === "error" ? state.message : undefined}
        ariaLabel="Loading session"
        retry={retry}
      />
    );
  }

  return (
    <QuizRunner
      key={`${defaults.questionCount}|${defaults.optionCount}|${defaults.newPerDay}|${defaults.reviewsPerDay}|${sessionToken}`}
      entries={state.entries}
      releaseId={state.releaseId}
      contentVersion={state.contentVersion}
      questionGeneratorVersion={state.questionGeneratorVersion}
      buildPlan={buildPlan}
      delivery="immediate"
      optionCount={defaults.optionCount}
      emptyMessage="Nothing to study right now — you've reached today's targets. Come back when reviews are due, or start a specific mode."
      onStudyAgain={() => setSessionToken((token) => token + 1)}
    />
  );
}
