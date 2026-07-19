"use client";

/**
 * The exact weak-set drill session (Phase 13 §17-19): validates the
 * `dimension`/`value` request against the CURRENT materialised weak-area
 * groups, shows a weak-area context header, then runs the existing shared
 * `QuizRunner` with a zero-configuration setup (current session defaults,
 * existing hint/undo/persistence/results — no second session-configuration
 * form).
 *
 * "Study this area again" (§19 "Refresh on Study again") is NOT a special
 * case: `buildPlan` reads a fresh raw analytics snapshot and recomputes
 * weakness evidence/scores from scratch on every call — including the call
 * QuizRunner makes on remount after "Study again" — so a component that has
 * stopped qualifying as weak is excluded from the rebuilt plan without any
 * separate refresh mechanism. An empty rebuilt plan surfaces QuizRunner's
 * own encouraging empty state.
 *
 * `useWeaknessSnapshot()` re-loads in the background on tab visibility
 * regain (its documented Phase 12 refresh behaviour), independent of
 * whether a drill session is active, and that background reload can either
 * change the group set OR fail/time out outright (`weakness.status`
 * flipping to `"error"`). Neither may tear down an already-running
 * QuizRunner session: the validated request AND its resolved header label
 * are COMMITTED once, the first time validation succeeds for the current
 * `dimensionParam`/`valueParam` pair, and a session, once started
 * (`committedRequest !== null`), is no longer gated on `weakness.status` at
 * all — a background refresh failing is an analytics-only hiccup, not a
 * reason to discard the live quiz. A genuinely invalid link still resolves
 * to the not-found state (the commit only ever happens on success); "the
 * area emptied out" is exactly what `buildPlan`'s own independent fresh
 * read already handles via QuizRunner's encouraging empty state (Study
 * again and ordinary session completion alike).
 */
import Link from "next/link";
import { useCallback, useState, type ReactNode } from "react";

import { useActiveContent } from "@/components/content/use-active-content";
import { useWeaknessSnapshot } from "@/components/analytics/use-weakness-snapshot";
import {
  ContentStateFallback,
  QuizRunner,
  type QuizPlanEntry,
} from "@/components/study/quiz-runner";
import { Card, CardContent } from "@/components/ui/card";
import { resolveWeaknessGroupLabel } from "@/components/weakness/weakness-group-label";
import { useSessionDefaults } from "@/lib/preferences/use-session-defaults";
import { loadWeaknessEvidence } from "@/modules/analytics/weakness-persistence";
import { getSafwaDb } from "@/modules/content/db";
import type { LearnerEntry } from "@/modules/content/schema";
import type { AttemptClock } from "@/modules/study-engine/attempts";
import { deriveAllComponents } from "@/modules/study-engine/components";
import {
  buildWeakDrillPlan,
  validateWeakDrillRequest,
  type WeakDrillRequest,
} from "@/modules/study-session/weak-drill";

/** Unknown/invalid dimension or value (§17 "safe not-found/invalid-set
 * state") — never rendered for a genuinely empty (but valid) weak set,
 * which is QuizRunner's own encouraging empty state instead. */
function InvalidRequestCard() {
  return (
    <div className="space-y-4">
      <Card>
        <CardContent role="alert" className="space-y-2">
          <p className="font-medium">This practice link isn&apos;t valid</p>
          <p className="text-muted-foreground text-sm">
            The area it points to no longer matches your current weak areas.
            Open Weak Areas to pick a current one.
          </p>
        </CardContent>
      </Card>
      <Link
        href="/progress/weak-areas"
        className="text-muted-foreground hover:text-foreground inline-flex min-h-11 items-center text-sm"
      >
        Back to Weak Areas
      </Link>
    </div>
  );
}

function DrillContextHeader({ label }: { label: ReactNode }) {
  return (
    <Card>
      <CardContent className="space-y-1">
        <p className="text-muted-foreground text-xs">Practising</p>
        <p className="font-medium">{label}</p>
      </CardContent>
    </Card>
  );
}

/** Top-level: validates the request, then mounts the drill runner. */
export function WeakDrillSession({
  dimensionParam,
  valueParam,
}: {
  dimensionParam: string | null;
  valueParam: string | null;
}) {
  const { state: content, retry } = useActiveContent();
  const { state: weakness, retry: retryWeakness } = useWeaknessSnapshot();
  const { defaults, loaded: defaultsLoaded } = useSessionDefaults();
  // Bumping this token remounts the runner, starting a fresh session (used by
  // "Study again") — buildPlan below re-reads everything fresh on remount.
  const [sessionToken, setSessionToken] = useState(0);

  // The request + header label COMMITTED for this dimensionParam/valueParam
  // pair — set once on the first successful validation and never overwritten
  // by a later background weakness refresh (see module doc comment).
  // Adjusted directly during render (React's documented "adjusting state
  // when a prop changes" pattern — https://react.dev/learn/you-might-not-need-an-effect),
  // never inside a useEffect: every write below is guarded by an equality
  // check, so it fires at most once per genuine change and React re-renders
  // immediately with the settled state before anything is painted.
  const [committedRequest, setCommittedRequest] =
    useState<WeakDrillRequest | null>(null);
  const [committedLabel, setCommittedLabel] = useState<ReactNode>(null);
  const [committedParams, setCommittedParams] = useState<{
    dimension: string | null;
    value: string | null;
  }>({ dimension: dimensionParam, value: valueParam });
  if (
    committedParams.dimension !== dimensionParam ||
    committedParams.value !== valueParam
  ) {
    setCommittedParams({ dimension: dimensionParam, value: valueParam });
    setCommittedRequest(null);
    setCommittedLabel(null);
  }

  const liveRequest =
    weakness.status === "ready"
      ? validateWeakDrillRequest(
          dimensionParam,
          valueParam,
          weakness.view.groups,
        )
      : null;
  let liveLabel: ReactNode = null;
  if (weakness.status === "ready" && liveRequest !== null) {
    liveLabel = resolveWeaknessGroupLabel(
      liveRequest,
      weakness.babArabic,
      weakness.verbTypeArabic,
    ).label;
  }
  if (committedRequest === null && liveRequest !== null) {
    setCommittedRequest(liveRequest);
    setCommittedLabel(liveLabel);
  }

  // Renders from the commitment once it exists; falls back to the live
  // validation/label for the render where they first become non-null (the
  // state update above lands in the SAME render pass before paint), so a
  // first-time-valid request never flashes the not-found state.
  const request = committedRequest ?? liveRequest;
  const label = committedLabel ?? liveLabel;
  // Once true, a background weakness refresh — whether it drops the group
  // or the read itself fails/times out — must never unmount the live
  // session (see module doc comment).
  const sessionStarted = committedRequest !== null;

  const buildPlan = useCallback(
    async (
      entries: LearnerEntry[],
      seed: string,
      clock: AttemptClock,
    ): Promise<QuizPlanEntry[]> => {
      if (request === null) return [];
      const db = getSafwaDb();
      const nowMs = clock.now();
      const derived = deriveAllComponents(entries);
      const { weaknessEvidence, componentWeakness } =
        await loadWeaknessEvidence(db, derived, nowMs);
      return buildWeakDrillPlan(
        entries,
        weaknessEvidence,
        componentWeakness,
        request,
        { questionCount: defaults.questionCount },
        seed,
      );
    },
    [request, defaults.questionCount],
  );

  if (
    content.status === "loading" ||
    (!sessionStarted && weakness.status === "loading") ||
    !defaultsLoaded
  ) {
    return (
      <ContentStateFallback
        status="loading"
        ariaLabel="Loading practice session"
        retry={retry}
      />
    );
  }
  if (content.status === "error") {
    return (
      <ContentStateFallback
        status="error"
        message={content.message}
        ariaLabel="Loading practice session"
        retry={retry}
      />
    );
  }
  if (!sessionStarted && weakness.status === "error") {
    return (
      <ContentStateFallback
        status="error"
        message={weakness.message}
        ariaLabel="Loading practice session"
        retry={retryWeakness}
      />
    );
  }
  if (request === null) {
    return <InvalidRequestCard />;
  }

  return (
    <div className="space-y-6">
      <DrillContextHeader label={label} />
      <QuizRunner
        key={`${request.dimension}|${request.value}|${defaults.questionCount}|${defaults.optionCount}|${sessionToken}`}
        entries={content.entries}
        releaseId={content.releaseId}
        contentVersion={content.contentVersion}
        questionGeneratorVersion={content.questionGeneratorVersion}
        buildPlan={buildPlan}
        delivery="immediate"
        optionCount={defaults.optionCount}
        emptyMessage="Nice work — there's nothing left to practise in this area right now. Check Weak Areas for what's next."
        onStudyAgain={() => setSessionToken((token) => token + 1)}
      />
      <div>
        <Link
          href="/progress/weak-areas"
          className="text-muted-foreground hover:text-foreground inline-flex min-h-11 items-center text-sm"
        >
          Back to Weak Areas
        </Link>
      </div>
    </div>
  );
}
