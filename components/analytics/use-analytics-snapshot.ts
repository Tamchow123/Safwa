"use client";

/**
 * The ONE analytics load for the Dashboard and Progress pages (Phase 12
 * §15–16, §28): verified content through the Phase 3 loader, the effective
 * clock through the shared resolver, one consistent persistence snapshot,
 * and every displayed number computed HERE through the pure analytics
 * modules — presentational components receive finished values and never
 * re-derive a formula. `todayLocalDate` is validated at production so a
 * malformed date can never reach a fail-loud consumer mid-render.
 *
 * The eligible component universe is derived ONCE per loaded release and
 * joined ONCE with stored scheduling state per snapshot; the summary, group,
 * due-today and streak consumers all share that join (§28 — never one
 * IndexedDB query or derivation pass per metric).
 *
 * Refresh (§14.4): the snapshot loads on mount, re-loads when the document
 * regains visibility (study in another tab/route stays current) and on the
 * caller's explicit retry. A visibility refresh keeps the previous view on
 * screen while the new one loads — no skeleton flash — and a burst of
 * visibility events coalesces to one load via the in-flight guard; a failed
 * refresh surfaces the recoverable error state with retry.
 *
 * A load that never settles (e.g. the Dexie v2→v3 upgrade blocked behind a
 * stale tab's connection — Dexie's default `versionchange` handler closes
 * old connections, but a hung open must still not strand the page on the
 * skeleton) is bounded by a watchdog that fails over to the same
 * recoverable error state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useActiveContent } from "@/components/content/use-active-content";
import {
  babGroup,
  computeProgressSummary,
  computeStreaks,
  countDueToday,
  effectiveComponents,
  essentialGroupProgress,
  isIsoDate,
  verbTypeGroup,
  type DailyActivity,
  type EffectiveComponent,
  type ProgressRatio,
  type ProgressSummary,
  type StreakSummary,
} from "@/modules/analytics";
import { readAnalyticsSnapshot } from "@/modules/analytics/persistence";
import { getSafwaDb, type SafwaDb } from "@/modules/content/db";
import type { LearnerEntry } from "@/modules/content/schema";
import { readEffectiveClock } from "@/modules/profile/timezone";
import { computeEventTimeFields } from "@/modules/study-engine/attempts";
import {
  deriveAllComponents,
  type DerivedComponent,
} from "@/modules/study-engine/components";

/** One group's completion with its Arabic display pair from the release. */
export type GroupCompletion = {
  /** Internal group id (entry classification value) — never displayed. */
  id: string;
  /** Arabic display pair read from the loaded release (hard rules 3 & 5). */
  arabic: string;
  ratio: ProgressRatio;
};

/** Every finished value the two pages render. */
export type AnalyticsView = {
  /** The effective zone's current local date at snapshot time (validated). */
  todayLocalDate: string;
  summary: ProgressSummary;
  streaks: StreakSummary;
  /** Eligible components due on or before the end of today (§11). */
  dueToday: number;
  /** Today's derived activity — zeros when the learner has none today. */
  today: DailyActivity;
  /** The complete derived daily activity, ascending by local date. */
  dailyActivity: DailyActivity[];
  babCompletion: GroupCompletion[];
  verbTypeCompletion: GroupCompletion[];
};

export type AnalyticsSnapshotState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; view: AnalyticsView };

/** User-safe persistence failure text — never Dexie/stack/key internals. */
const SNAPSHOT_FAILURE_MESSAGE =
  "Something went wrong loading your progress. Your study history is safe — please retry.";

/** User-safe text for a load that never settled (watchdog fired). */
const SNAPSHOT_TIMEOUT_MESSAGE =
  "Loading your progress is taking longer than expected. If Safwa is open in another tab, close it and retry.";

/**
 * How long a load may run before the watchdog fails it over to the error
 * state. Real loads complete in milliseconds; this only guards a hung
 * IndexedDB open (e.g. a blocked schema upgrade).
 */
export const SNAPSHOT_WATCHDOG_MS = 10_000;

/** Internal marker so the catch block can pick the timeout message. */
const WATCHDOG_ERROR = "analytics-load-watchdog-timeout";

/**
 * Group completions in release (source) order with their Arabic display
 * pairs, from the SHARED essential-group formula. `groupOf` returning null
 * excludes an entry entirely (e.g. an unverified verb type — hard rule 2).
 */
function groupCompletions(
  effective: readonly EffectiveComponent[],
  entries: readonly LearnerEntry[],
  groupOf: (entry: LearnerEntry) => string | null,
  arabicOf: (entry: LearnerEntry) => string,
): GroupCompletion[] {
  const ratios = essentialGroupProgress(effective, entries, groupOf);
  const completions: GroupCompletion[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const id = groupOf(entry);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    const ratio = ratios.get(id);
    if (ratio) completions.push({ id, arabic: arabicOf(entry), ratio });
  }
  return completions;
}

/** The full impure load + pure computation producing one finished view. */
async function loadAnalyticsView(
  db: SafwaDb,
  derived: readonly DerivedComponent[],
  entries: readonly LearnerEntry[],
): Promise<AnalyticsView> {
  // The dashboard is NOT a study session: each load re-resolves the
  // effective clock so "today" always reflects the current preference
  // (session freezing per §10.6 applies to study runners only).
  const clock = await readEffectiveClock(db);
  const nowMs = clock.now();
  const todayLocalDate = computeEventTimeFields(nowMs, clock).localDateAtEvent;
  // Fail INSIDE the guarded load, not later in a consumer's render (§18):
  // ActivityTrend's date arithmetic fail-louds on a malformed label.
  if (!isIsoDate(todayLocalDate)) {
    throw new Error("effective clock produced an invalid local date");
  }
  const persisted = await readAnalyticsSnapshot(db, nowMs);

  // ONE join shared by every consumer below (§28).
  const effective = effectiveComponents(derived, persisted.components, nowMs);
  return {
    todayLocalDate,
    summary: computeProgressSummary(effective, entries.length),
    streaks: computeStreaks(persisted.dailyActivity, todayLocalDate),
    dueToday: countDueToday(effective, clock.timezone, todayLocalDate),
    today: persisted.dailyActivity.find(
      (row) => row.localDate === todayLocalDate,
    ) ?? {
      localDate: todayLocalDate,
      attempts: 0,
      reviews: 0,
      newItems: 0,
      studyMs: 0,
    },
    dailyActivity: persisted.dailyActivity,
    babCompletion: groupCompletions(
      effective,
      entries,
      babGroup,
      (entry) => entry.bab_arabic,
    ),
    verbTypeCompletion: groupCompletions(
      effective,
      entries,
      verbTypeGroup,
      (entry) => entry.verb_type_arabic,
    ),
  };
}

export function useAnalyticsSnapshot(): {
  state: AnalyticsSnapshotState;
  retry: () => void;
} {
  const { state: content, retry: retryContent } = useActiveContent();
  const [snapshot, setSnapshot] = useState<AnalyticsSnapshotState>({
    status: "loading",
  });
  const [attempt, setAttempt] = useState(0);
  // True while a load is running — visibility bursts coalesce to one load.
  const inFlight = useRef(false);

  // The eligible universe, derived ONCE per loaded release (§28).
  const derived = useMemo<DerivedComponent[] | null>(
    () =>
      content.status === "ready" ? deriveAllComponents(content.entries) : null,
    [content],
  );

  useEffect(() => {
    if (content.status !== "ready" || derived === null) return;
    const entries = content.entries;
    let cancelled = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    inFlight.current = true;
    void (async () => {
      try {
        const view = await Promise.race([
          loadAnalyticsView(getSafwaDb(), derived, entries),
          new Promise<never>((_, reject) => {
            watchdog = setTimeout(
              () => reject(new Error(WATCHDOG_ERROR)),
              SNAPSHOT_WATCHDOG_MS,
            );
          }),
        ]);
        if (!cancelled) setSnapshot({ status: "ready", view });
      } catch (error) {
        if (!cancelled) {
          setSnapshot({
            status: "error",
            message:
              error instanceof Error && error.message === WATCHDOG_ERROR
                ? SNAPSHOT_TIMEOUT_MESSAGE
                : SNAPSHOT_FAILURE_MESSAGE,
          });
        }
      } finally {
        inFlight.current = false;
        if (watchdog !== undefined) clearTimeout(watchdog);
      }
    })();
    return () => {
      cancelled = true;
      if (watchdog !== undefined) clearTimeout(watchdog);
    };
  }, [content, derived, attempt]);

  // §14.4: regaining visibility after study elsewhere refreshes the numbers.
  // The previous ready view stays mounted while the fresh one loads; a
  // toggle burst starts at most one load (the running one is fresh enough).
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && !inFlight.current) {
        setAttempt((n) => n + 1);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  const retry = useCallback(() => {
    setSnapshot({ status: "loading" });
    if (content.status === "error") retryContent();
    setAttempt((n) => n + 1);
  }, [content.status, retryContent]);

  // Content loading/error wins: analytics cannot be computed without the
  // release, and the content hook's message is already user-safe.
  if (content.status === "loading") {
    return { state: { status: "loading" }, retry };
  }
  if (content.status === "error") {
    return { state: { status: "error", message: content.message }, retry };
  }
  return { state: snapshot, retry };
}
