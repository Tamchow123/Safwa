"use client";

/**
 * The ONE weakness load for the Weak Areas page and the weak drill route
 * (Phase 13 §7, §15-20) — mirrors `use-analytics-snapshot.ts`'s conventions
 * exactly: verified content through the Phase 3 loader, the effective clock
 * through the shared resolver, one consistent persistence snapshot (shared
 * with the dashboard/progress load path via `readAnalyticsSnapshot`), and
 * every displayed number computed HERE through the pure weakness modules.
 *
 * Refresh: the snapshot loads on mount, re-loads when the document regains
 * visibility, and on the caller's explicit retry — exactly the Phase 12
 * pattern, so "Study this area again" (§19) recomputing a fresh snapshot is
 * just another `retry()` call, never a second refresh mechanism.
 *
 * A load that never settles is bounded by the same shared read-side
 * watchdog (lib/with-timeout.ts) used by the analytics snapshot.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useActiveContent } from "@/components/content/use-active-content";
import { deriveAllComponentsCached } from "@/lib/derived-components-cache";
import { TimeoutError, withTimeout } from "@/lib/with-timeout";
import {
  babGroup,
  groupArabicLookup,
  verbTypeGroup,
} from "@/modules/analytics/progress";
import { getSafwaDb } from "@/modules/content/db";
import type { LearnerEntry } from "@/modules/content/schema";
import { readEffectiveClock } from "@/modules/profile/timezone";
import {
  loadWeaknessView,
  type WeaknessView,
} from "@/modules/analytics/weakness-persistence";
import type { DerivedComponent } from "@/modules/study-engine/components";

export type WeaknessSnapshotState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      view: WeaknessView;
      /** Bāb/verb-type group id -> Arabic display pair (hard rules 3 & 5),
       * resolved HERE from the release — mirrors `use-analytics-snapshot.ts`'s
       * `groupCompletions` via the shared `groupArabicLookup` helper, so
       * presentational components never see raw entries or re-derive this. */
      babArabic: ReadonlyMap<string, string>;
      verbTypeArabic: ReadonlyMap<string, string>;
      /** The clock instant the view was scored/loaded at (§10 TIME MODEL) —
       * exposed so display-only relative-time text ("Practised N days ago")
       * never calls an ambient clock during render. */
      nowMs: number;
    };

/** User-safe persistence failure text — never Dexie/stack/key internals. */
const SNAPSHOT_FAILURE_MESSAGE =
  "Something went wrong loading your weak areas. Your study history is safe — please retry.";

/** User-safe text for a load that never settled (watchdog fired). */
const SNAPSHOT_TIMEOUT_MESSAGE =
  "Loading your weak areas is taking longer than expected. If Safwa is open in another tab, close it and retry.";

/** Same bound as the analytics snapshot watchdog — real loads are fast. */
export const WEAKNESS_SNAPSHOT_WATCHDOG_MS = 10_000;

/** Internal marker so the catch block can pick the timeout message. */
const WATCHDOG_ERROR = "weakness-load-watchdog-timeout";

async function loadView(
  derived: readonly DerivedComponent[],
  entries: readonly LearnerEntry[],
): Promise<{
  view: WeaknessView;
  babArabic: ReadonlyMap<string, string>;
  verbTypeArabic: ReadonlyMap<string, string>;
  nowMs: number;
}> {
  const db = getSafwaDb();
  const clock = await readEffectiveClock(db);
  const nowMs = clock.now();
  const view = await loadWeaknessView(db, derived, entries, nowMs);
  const babArabic = groupArabicLookup(
    entries,
    babGroup,
    (entry) => entry.bab_arabic,
  );
  const verbTypeArabic = groupArabicLookup(
    entries,
    verbTypeGroup,
    (entry) => entry.verb_type_arabic,
  );
  return { view, babArabic, verbTypeArabic, nowMs };
}

export function useWeaknessSnapshot(): {
  state: WeaknessSnapshotState;
  retry: () => void;
} {
  const { state: content, retry: retryContent } = useActiveContent();
  const [snapshot, setSnapshot] = useState<WeaknessSnapshotState>({
    status: "loading",
  });
  const [attempt, setAttempt] = useState(0);
  // True while a load is running — visibility bursts coalesce to one load.
  const inFlight = useRef(false);

  const entries = useMemo<LearnerEntry[] | null>(
    () => (content.status === "ready" ? content.entries : null),
    [content],
  );
  // The eligible universe, derived ONCE per loaded release (mirrors
  // use-analytics-snapshot.ts §28) — never re-derived on retry or a
  // visibility-triggered refresh.
  const derived = useMemo<DerivedComponent[] | null>(
    () => (entries === null ? null : deriveAllComponentsCached(entries)),
    [entries],
  );

  useEffect(() => {
    if (content.status !== "ready" || entries === null || derived === null) {
      return;
    }
    let cancelled = false;
    inFlight.current = true;
    void (async () => {
      try {
        const { view, babArabic, verbTypeArabic, nowMs } = await withTimeout(
          loadView(derived, entries),
          WEAKNESS_SNAPSHOT_WATCHDOG_MS,
          WATCHDOG_ERROR,
        );
        if (!cancelled) {
          setSnapshot({
            status: "ready",
            view,
            babArabic,
            verbTypeArabic,
            nowMs,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setSnapshot({
            status: "error",
            message:
              error instanceof TimeoutError
                ? SNAPSHOT_TIMEOUT_MESSAGE
                : SNAPSHOT_FAILURE_MESSAGE,
          });
        }
      } finally {
        inFlight.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [content, entries, derived, attempt]);

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

  if (content.status === "loading") {
    return { state: { status: "loading" }, retry };
  }
  if (content.status === "error") {
    return { state: { status: "error", message: content.message }, retry };
  }
  return { state: snapshot, retry };
}
