"use client";

/**
 * One word's progress for the entry page's "Your progress" card (Phase 18.5),
 * following the read-side snapshot conventions of `use-collections.ts`: a
 * bounded watchdog, user-safe failure text, a silent refresh on visibility
 * regain (coalesced while one is in flight), and a tolerance for transient
 * background-refresh failures — a working card is never replaced by an error
 * until failures persist.
 *
 * The read is bounded to this word's own components
 * (`readComponentsSchedulingState`), and every value is derived by
 * `entryProgress` from the same rules Start studying plans by. Read-only, so
 * the owner is the live session owner (`useLocalOwner`).
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { useLocalOwner } from "@/components/sync/use-local-owner";
import {
  DB_READ_TIMEOUT_MS,
  TimeoutError,
  withTimeout,
} from "@/lib/with-timeout";
import { getSafwaDb } from "@/modules/content/db";
import { toOwnerKey } from "@/modules/content/owner-key";
import type { LearnerEntry } from "@/modules/content/schema";
import { deriveComponentsForEntry } from "@/modules/study-engine/components";
import {
  entryProgress,
  type EntryProgress,
} from "@/modules/study-session/entry-progress";
import { readComponentsSchedulingState } from "@/modules/study-session/persistence";

export type EntryProgressState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; progress: EntryProgress };

/** User-safe failure text — never raw Dexie errors. */
const FAILURE_MESSAGE =
  "Couldn't load your progress for this word. Your study history is safe — please retry.";

/** User-safe text for a load that never settled (watchdog fired). */
const TIMEOUT_MESSAGE =
  "Loading your progress is taking longer than expected. If Safwa is open in another tab, close it and retry.";

const WATCHDOG_ERROR = "entry-progress-load-watchdog-timeout";

/**
 * Consecutive background-refresh failures tolerated (with a card showing)
 * before the error state appears — the same bound as `use-collections.ts`.
 */
const MAX_SILENT_BACKGROUND_FAILURES = 3;

export function useEntryProgress(entry: LearnerEntry): {
  state: EntryProgressState;
  retry: () => void;
} {
  const owner = useLocalOwner();
  const [state, setState] = useState<EntryProgressState>({
    status: "loading",
  });
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef(false);
  const latestRun = useRef(0);
  const consecutiveBackgroundFailures = useRef(0);

  // Adjusted DURING RENDER (React's documented reset pattern, as in
  // use-collections.ts): the card stays mounted across a client-side
  // navigation between entries, so another word — or another owner — must
  // never show the previous one's progress while its own read is pending.
  const subject = `${toOwnerKey(owner)}|${entry.id}`;
  const [shownSubject, setShownSubject] = useState(subject);
  if (subject !== shownSubject) {
    setShownSubject(subject);
    setState({ status: "loading" });
  }

  useEffect(() => {
    let cancelled = false;
    const run = ++latestRun.current;
    inFlight.current = true;
    void (async () => {
      try {
        const componentKeys = deriveComponentsForEntry(entry).map(
          (component) => component.key,
        );
        const stored = await withTimeout(
          readComponentsSchedulingState(getSafwaDb(), owner, componentKeys),
          DB_READ_TIMEOUT_MS,
          WATCHDOG_ERROR,
        );
        if (cancelled) return;
        consecutiveBackgroundFailures.current = 0;
        setState({
          status: "ready",
          progress: entryProgress(entry, stored, Date.now()),
        });
      } catch (error) {
        if (cancelled) return;
        const message =
          error instanceof TimeoutError ? TIMEOUT_MESSAGE : FAILURE_MESSAGE;
        consecutiveBackgroundFailures.current += 1;
        const persistent =
          consecutiveBackgroundFailures.current >=
          MAX_SILENT_BACKGROUND_FAILURES;
        // A transient failure of a background refresh keeps the card that is
        // already showing; a first load, or a persistent failure, says so.
        setState((prev) =>
          prev.status === "ready" && !persistent
            ? prev
            : { status: "error", message },
        );
      } finally {
        if (latestRun.current === run) inFlight.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entry, owner, attempt]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible" && !inFlight.current) {
        setAttempt((n) => n + 1);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  return { state, retry };
}
