"use client";

/**
 * Route-segment error boundary for every shell page (Phase 12 §18): an
 * unexpected render/runtime error degrades to the same user-safe
 * recoverable message + retry pattern as SnapshotFallback instead of a
 * blank page. The caught error is NEVER rendered — no stack traces, Dexie
 * store names, component keys or other internals reach the learner.
 */
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function ShellError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <Card>
      <CardContent role="alert" className="space-y-3">
        <p className="text-destructive text-sm">
          Something went wrong showing this page. Your study history is safe —
          please try again.
        </p>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={reset}
        >
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}
