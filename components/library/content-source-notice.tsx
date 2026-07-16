"use client";

import { RefreshCw } from "lucide-react";

import { contentSourceLabel } from "@/components/content/use-active-content";
import { Button } from "@/components/ui/button";
import type { ContentSource, FallbackReason } from "@/modules/content/load";

/**
 * Restrained provenance line for the loaded release, with a refresh action
 * (also keeps the Phase 3 cache/fallback behaviour exercisable in E2E).
 */
export function ContentSourceNotice({
  releaseId,
  source,
  fallbackReason,
  onRefresh,
}: {
  releaseId: string;
  source: ContentSource;
  fallbackReason?: FallbackReason;
  onRefresh: () => void;
}) {
  const isFallback = source === "fallback-cache";
  return (
    <div
      role={isFallback ? "status" : undefined}
      className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
    >
      <span>
        Release{" "}
        <code data-testid="content-release-id" className="font-mono">
          {releaseId}
        </code>{" "}
        —{" "}
        <span data-testid="content-source">
          {contentSourceLabel(source, fallbackReason)}
        </span>
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        onClick={onRefresh}
      >
        <RefreshCw aria-hidden className="size-3" />
        Refresh content
      </Button>
    </div>
  );
}
