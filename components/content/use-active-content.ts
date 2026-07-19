"use client";

import { useCallback, useEffect, useState } from "react";

import { TimeoutError, withTimeout } from "@/lib/with-timeout";
import type { LearnerEntry } from "@/modules/content/schema";
import {
  loadActiveContent,
  OFFLINE_REASONS,
  type ContentSource,
  type FallbackReason,
  type LoadContentResult,
} from "@/modules/content/load";

/** Short user-safe failure text — never raw checksums or Zod diagnostics. */
const FAILURE_MESSAGES: Record<
  Extract<LoadContentResult, { ok: false }>["code"],
  string
> = {
  "no-content-available":
    "No content is available. Check your connection and retry.",
  "checksum-mismatch":
    "The downloaded content failed verification. Please retry.",
  "invalid-release": "The downloaded content was invalid. Please retry.",
  "pointer-invalid": "The content index looks inconsistent. Please retry.",
};

/**
 * A content load that never settles (e.g. the local database open blocked
 * behind another tab's connection during a schema upgrade) must not strand
 * every content-gated page on a skeleton with no retry — it fails over to
 * the recoverable error state instead. Generous, because a legitimate
 * first download over a slow connection may take a while.
 */
export const CONTENT_WATCHDOG_MS = 30_000;

const WATCHDOG_ERROR = "content-load-watchdog-timeout";

const WATCHDOG_MESSAGE =
  "Loading is taking longer than expected. If Safwa is open in another tab, close it and retry.";

export type ActiveContentState =
  | { status: "loading" }
  | {
      status: "ready";
      entries: LearnerEntry[];
      releaseId: string;
      contentVersion: string;
      questionGeneratorVersion: string;
      entryCount: number;
      source: ContentSource;
      fallbackReason?: FallbackReason;
    }
  | { status: "error"; message: string };

/**
 * Reusable lifecycle around the verified Phase 3 content loader. Exposes
 * typed source/fallback information, a user-safe error message and a retry
 * action; never leaks internal diagnostics; guards against state updates
 * after unmount. Shared by the library and detail pages.
 */
export function useActiveContent() {
  const [state, setState] = useState<ActiveContentState>({
    status: "loading",
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    withTimeout(loadActiveContent(), CONTENT_WATCHDOG_MS, WATCHDOG_ERROR)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setState({
            status: "ready",
            entries: result.entries,
            releaseId: result.releaseId,
            contentVersion: result.contentVersion,
            questionGeneratorVersion: result.questionGeneratorVersion,
            entryCount: result.entryCount,
            source: result.source,
            fallbackReason: result.fallbackReason,
          });
        } else {
          setState({ status: "error", message: FAILURE_MESSAGES[result.code] });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message:
              error instanceof TimeoutError
                ? WATCHDOG_MESSAGE
                : "Something went wrong loading content. Please retry.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  return { state, retry };
}

/** User-safe source description; "offline" only when actually unreachable. */
export function contentSourceLabel(
  source: ContentSource,
  fallbackReason?: FallbackReason,
): string {
  switch (source) {
    case "network":
      return "downloaded from network";
    case "cache":
      return "served from verified cache";
    case "fallback-cache":
      return fallbackReason && OFFLINE_REASONS.includes(fallbackReason)
        ? "using the previous verified cached release (offline)"
        : "using the previous verified cached release";
  }
}
