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
  type LoadContentResult,
} from "@/modules/content/load";

const SOURCE_LABELS = {
  network: "downloaded from network",
  cache: "served from existing cache",
  "offline-fallback": "offline fallback from cache",
} as const;

type Status =
  | { state: "loading" }
  | { state: "ready"; result: Extract<LoadContentResult, { ok: true }> }
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
          setStatus({
            state: "error",
            message: `${result.code}: ${result.message}`,
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setStatus({ state: "error", message: String(error) });
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
            <p className="text-destructive text-sm">
              Content could not be loaded: {status.message}
            </p>
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
                {SOURCE_LABELS[status.result.source]}
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
