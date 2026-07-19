"use client";

/**
 * The zero-configuration "Start studying" mixed-revision session (Phase 10,
 * §4.3). No options bar: the plan is due reviews first, then weak items
 * (Phase 13 weakness heuristic v2 — the same score Weak Areas and the Custom
 * Session weak filter use), then new items, within whatever remains of
 * TODAY's daily targets (repeated same-day sessions share one daily
 * allowance). A brand-new guest with no history gets a plan of new items — a
 * sensible session with zero configuration.
 */
import { useCallback, useState } from "react";

import { useActiveContent } from "@/components/content/use-active-content";
import {
  ContentStateFallback,
  QuizRunner,
  type QuizPlanEntry,
} from "@/components/study/quiz-runner";
import { useSessionDefaults } from "@/lib/preferences/use-session-defaults";
import { loadWeakScores } from "@/modules/analytics/weakness-persistence";
import { getSafwaDb } from "@/modules/content/db";
import type { LearnerEntry } from "@/modules/content/schema";
import {
  computeEventTimeFields,
  type AttemptClock,
} from "@/modules/study-engine/attempts";
import { deriveAllComponents } from "@/modules/study-engine/components";
import {
  buildMixedPlan,
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
    async (
      entries: LearnerEntry[],
      _seed: string,
      clock: AttemptClock,
    ): Promise<QuizPlanEntry[]> => {
      const db = getSafwaDb();
      const snapshot = await readSchedulingSnapshot(db);
      // Today's REMAINING budgets: the runner's session-frozen EFFECTIVE
      // clock (timezone preference aware) decides what "today" means, the
      // same clock/zone that stamps this session's events — so consumption
      // and rollover agree with the recorded history. The full daily targets
      // are the user's configured new/day + reviews/day (§4.4 defaults 10·20).
      const nowMs = clock.now();
      const localDate = computeEventTimeFields(nowMs, clock).localDateAtEvent;
      const targets = remainingDailyTargets(snapshot.events, localDate, {
        newLimit: defaults.newPerDay,
        reviewLimit: defaults.reviewsPerDay,
      });
      // Phase 13 weakness v2: the ONE authoritative score, shared with Weak
      // Areas and the Custom Session weak filter (never a second/parallel
      // weakness computation for the mixed-revision weak tier).
      const derived = deriveAllComponents(entries);
      const weakScores = await loadWeakScores(db, derived, nowMs);
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
