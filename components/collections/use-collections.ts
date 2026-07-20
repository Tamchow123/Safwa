"use client";

/**
 * The ONE bookmarks/lists snapshot for every collections-aware page and
 * session setup (Phase 14 §10, docs/phases/phases-14.md) — mirrors
 * `use-weakness-snapshot.ts`'s conventions: a single consistent read
 * (`readCollections`), a bounded watchdog, a user-safe failure message, and
 * a refresh triggered on visibility regain or an explicit call.
 *
 * Unlike the read-only analytics snapshots, this hook is also the refresh
 * target for WRITES: every collection-mutating action calls `refresh()`
 * after a successful Dexie write so every mounted consumer (library card,
 * detail page, Saved Vocabulary, Custom Session) stays consistent (§10).
 * A refresh that lands while a snapshot is already showing is SILENT — it
 * never resets the UI back to a loading skeleton, which would otherwise
 * flicker every mounted bookmark toggle on every write. Only the very
 * first load (no snapshot yet) shows the loading state; a SINGLE background
 * refresh failure with an existing snapshot keeps that snapshot displayed
 * rather than replacing working UI with an error — but this is bounded: a
 * PERSISTENT run of background failures (storage genuinely unusable, not a
 * one-off) eventually surfaces the recoverable error state instead of
 * silently showing an indefinitely stale snapshot forever.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { TimeoutError, withTimeout } from "@/lib/with-timeout";
import type { BookmarkRecord, CustomListRecord } from "@/modules/content/db";
import { getSafwaDb } from "@/modules/content/db";
import { readCollections } from "@/modules/collections/persistence";

/** One consistent bookmarks/lists snapshot, ready for pure membership lookups. */
export type CollectionsSnapshot = {
  bookmarks: BookmarkRecord[];
  lists: CustomListRecord[];
  bookmarkedEntryIds: ReadonlySet<number>;
  listsById: ReadonlyMap<string, CustomListRecord>;
};

export type CollectionsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; snapshot: CollectionsSnapshot };

/** User-safe persistence failure text — never raw Dexie errors (§24/§34). */
const FAILURE_MESSAGE =
  "Couldn't load your saved vocabulary. Please try again.";

/** User-safe text for a load that never settled (watchdog fired). */
const TIMEOUT_MESSAGE =
  "Loading your saved vocabulary is taking longer than expected. If Safwa is open in another tab, close it and retry.";

/** Same bound as the other read-side snapshots (analytics, weakness). */
export const COLLECTIONS_SNAPSHOT_WATCHDOG_MS = 10_000;

const WATCHDOG_ERROR = "collections-load-watchdog-timeout";

/**
 * How many CONSECUTIVE background-refresh failures (with an existing ready
 * snapshot) are tolerated silently before falling through to the visible
 * error state. Bounds the "silently stale forever" gap: one or two
 * transient failures never disturb the UI, but a genuinely broken
 * persistence layer (storage evicted/corrupted, blocked upgrade in another
 * tab) is eventually surfaced with a retry affordance rather than hidden.
 */
const MAX_SILENT_BACKGROUND_FAILURES = 3;

function toSnapshot(raw: {
  bookmarks: BookmarkRecord[];
  lists: CustomListRecord[];
}): CollectionsSnapshot {
  return {
    bookmarks: raw.bookmarks,
    lists: raw.lists,
    bookmarkedEntryIds: new Set(raw.bookmarks.map((b) => b.entryId)),
    listsById: new Map(raw.lists.map((l) => [l.id, l])),
  };
}

export function useCollections(): {
  state: CollectionsState;
  refresh: () => void;
} {
  const [state, setState] = useState<CollectionsState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // True while a load is running — visibility bursts coalesce to one load.
  const inFlight = useRef(false);
  // Consecutive background-refresh failures with an existing ready
  // snapshot. Reset on any success; read/written only inside this effect
  // and its own cleanup, never during render.
  const consecutiveBackgroundFailures = useRef(0);

  // Adjusted DURING RENDER, not in an effect (React's documented pattern
  // for resetting state when a value changes:
  // https://react.dev/learn/you-might-not-need-an-effect) — a NEW attempt
  // (refresh()/visibility regain) resets to the loading skeleton only when
  // there is no snapshot to show yet; an existing snapshot stays visible
  // while the effect below fetches silently in the background.
  const [lastAttempt, setLastAttempt] = useState(attempt);
  if (attempt !== lastAttempt) {
    setLastAttempt(attempt);
    if (state.status !== "ready") {
      setState({ status: "loading" });
    }
  }

  useEffect(() => {
    let cancelled = false;
    inFlight.current = true;
    void (async () => {
      try {
        const db = getSafwaDb();
        const raw = await withTimeout(
          readCollections(db),
          COLLECTIONS_SNAPSHOT_WATCHDOG_MS,
          WATCHDOG_ERROR,
        );
        if (!cancelled) {
          consecutiveBackgroundFailures.current = 0;
          setState({ status: "ready", snapshot: toSnapshot(raw) });
        }
      } catch (error) {
        if (cancelled) return;
        const message =
          error instanceof TimeoutError ? TIMEOUT_MESSAGE : FAILURE_MESSAGE;
        // Incremented and logged HERE, not inside the setState updater below
        // — updater functions must be pure (React may invoke them more than
        // once, e.g. Strict Mode double-invocation in dev), so any side
        // effect belongs in the surrounding effect body instead.
        consecutiveBackgroundFailures.current += 1;
        const persistent =
          consecutiveBackgroundFailures.current >=
          MAX_SILENT_BACKGROUND_FAILURES;
        if (persistent) {
          // Never silently stale forever (§34 — no raw Dexie internals in
          // the logged/rendered message).
          console.error(
            "collections: background refresh failed repeatedly; surfacing the recoverable error state",
          );
        }
        setState((prev) => {
          if (prev.status !== "ready" || persistent) {
            return { status: "error", message };
          }
          // A single (or a couple of) transient background failures never
          // disturb a working UI — keep the last known-good snapshot.
          return prev;
        });
      } finally {
        inFlight.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

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

  const refresh = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);

  return { state, refresh };
}
