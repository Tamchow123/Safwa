"use client";

import { useCallback, useEffect, useState } from "react";

import { ArabicText } from "@/components/arabic-text";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  loadActiveContent,
  OFFLINE_REASONS,
  type LoadContentResult,
} from "@/modules/content/load";

type SuccessResult = Extract<LoadContentResult, { ok: true }>;

/** User-safe source description; "offline" only when actually unreachable. */
function sourceLabel(result: SuccessResult): string {
  switch (result.source) {
    case "network":
      return "downloaded from network";
    case "cache":
      return "served from verified cache";
    case "fallback-cache":
      return result.fallbackReason &&
        OFFLINE_REASONS.includes(result.fallbackReason)
        ? "using the previous verified cached release (offline)"
        : "using the previous verified cached release";
  }
}

/** Short user-safe failure text — never raw checksums or Zod diagnostics. */
const FAILURE_MESSAGES = {
  "no-content-available":
    "No content is available. Check your connection and retry.",
  "checksum-mismatch":
    "The downloaded content failed verification. Please retry.",
  "invalid-release": "The downloaded content was invalid. Please retry.",
  "pointer-invalid": "The content index looks inconsistent. Please retry.",
} as const;

type Status =
  | { state: "loading" }
  | { state: "ready"; result: SuccessResult }
  | { state: "error"; message: string };

/**
 * Phase 3 content-foundation demonstration: loads the active learner
 * release through the real loader (network -> verified -> Dexie cache) and
 * shows one real entry. Replaced/expanded by the Phase 4 library.
 */
export function ContentFoundationStatus() {
  const [status, setStatus] = useState<Status>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    loadActiveContent()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setStatus({ state: "ready", result });
        } else {
          setStatus({ state: "error", message: FAILURE_MESSAGES[result.code] });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus({
            state: "error",
            message: "Something went wrong loading content. Please retry.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const reload = useCallback(() => {
    setStatus({ state: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  return (
    <Card data-testid="content-foundation">
      <CardHeader>
        <CardTitle>
          <h2 className="text-base font-semibold">Content foundation</h2>
        </CardTitle>
        <CardDescription>
          Phase 3 diagnostic: the versioned learner release, verified and cached
          locally.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {status.state === "loading" ? (
          <p
            role="status"
            data-testid="content-status"
            className="text-muted-foreground text-sm"
          >
            Loading content release…
          </p>
        ) : null}

        {status.state === "error" ? (
          <div role="alert" data-testid="content-status" className="space-y-2">
            <p className="text-destructive text-sm">{status.message}</p>
            <Button type="button" variant="outline" onClick={reload}>
              Retry loading content
            </Button>
          </div>
        ) : null}

        {status.state === "ready" ? (
          <div className="space-y-2 text-sm" data-testid="content-status">
            <p>
              Release{" "}
              <code data-testid="content-release-id">
                {status.result.releaseId}
              </code>{" "}
              —{" "}
              <span data-testid="content-entry-count">
                {status.result.entryCount}
              </span>{" "}
              entries loaded (
              <span data-testid="content-source">
                {sourceLabel(status.result)}
              </span>
              ).
            </p>
            <div className="bg-muted/50 rounded-lg border p-4">
              <p className="text-muted-foreground text-xs">
                First entry in the release (id {status.result.entries[0]?.id}):
              </p>
              <ArabicText
                as="p"
                className="mt-1 text-2xl"
                data-testid="content-sample-arabic"
              >
                {status.result.entries[0]?.madi}
              </ArabicText>
              <p
                className="text-muted-foreground mt-1 text-sm"
                data-testid="content-sample-meaning"
              >
                {status.result.entries[0]?.meaning}
              </p>
            </div>
            <Button type="button" variant="outline" onClick={reload}>
              Reload content
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
