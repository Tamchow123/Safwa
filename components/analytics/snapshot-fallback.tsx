/**
 * Loading skeleton + recoverable error state for the analytics pages (Phase
 * 12 §18). Mirrors the study runner's `ContentStateFallback` deliberately
 * WITHOUT importing it: pulling quiz-runner into the dashboard/progress
 * bundles would drag the whole study engine along. Stable skeleton blocks
 * avoid layout shift; the error text is the caller's user-safe message
 * (never Dexie/stack/key internals) with a keyboard-accessible retry.
 */
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function SnapshotFallback({
  status,
  message,
  ariaLabel,
  retry,
}: {
  status: "loading" | "error";
  /** User-safe error text (ignored while loading). */
  message?: string;
  /** Accessible name announced for the loading state. */
  ariaLabel: string;
  retry: () => void;
}) {
  if (status === "loading") {
    return (
      <div className="space-y-4" role="status" aria-label={ariaLabel}>
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
        <span className="sr-only">Loading…</span>
      </div>
    );
  }
  return (
    <Card>
      <CardContent role="alert" className="space-y-3">
        <p className="text-destructive text-sm">{message}</p>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={retry}
        >
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}
