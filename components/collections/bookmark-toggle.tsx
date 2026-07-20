"use client";

/**
 * Reusable bookmark toggle control (Phase 14 §12). Purely presentational
 * and generic: the caller injects `onToggle` (wired to
 * `modules/collections/persistence.ts` plus a `useCollections().refresh()`
 * call) and an `entryLabel` (the entry's base meaning — never Arabic typed
 * here, never the raw entry id).
 *
 * State handling:
 * - Optimistic: the visible pressed state flips immediately on click.
 * - Pending: the control disables and shows a spinner while the write is
 *   in flight; a second click cannot start an overlapping write.
 * - Failure: the optimistic flip is rolled back and a concise, user-safe
 *   error is shown in a polite live region (never a raw Dexie message).
 * - The optimistic override clears once the caller's `bookmarked` prop
 *   catches up to it (i.e. once the parent's snapshot refresh lands),
 *   collapsing cleanly back to the authoritative source of truth.
 */
import { useCallback, useRef, useState } from "react";
import { Bookmark, BookmarkCheck, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const WRITE_FAILURE_MESSAGE =
  "Couldn't update your saved vocabulary. Please try again.";

export type BookmarkToggleProps = {
  /** The entry's base meaning (or another short, learner-facing label). */
  entryLabel: string;
  bookmarked: boolean;
  onToggle: () => Promise<void>;
  className?: string;
  size?: "default" | "sm";
};

export function BookmarkToggle({
  entryLabel,
  bookmarked,
  onToggle,
  className,
  size = "default",
}: BookmarkToggleProps) {
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A synchronous guard, not just the `pending` state: two clicks
  // dispatched back-to-back in the same tick (a genuine double-click) both
  // run before React re-renders with `disabled`, so both handlers would
  // otherwise close over the same stale `pending === false`. The ref is
  // read/written synchronously and can never be stale across two calls in
  // the same tick (§11 race-safety).
  const pendingRef = useRef(false);

  // Once the authoritative prop catches up with the optimistic guess,
  // collapse back to it — this also naturally picks up a bookmark change
  // made elsewhere (another tab, another mounted toggle for the same entry).
  // Adjusted during render (React's documented pattern for resetting state
  // when a prop changes: https://react.dev/learn/you-might-not-need-an-effect),
  // not in an effect — an effect would cause an extra, avoidable re-render.
  const [prevBookmarked, setPrevBookmarked] = useState(bookmarked);
  if (bookmarked !== prevBookmarked) {
    setPrevBookmarked(bookmarked);
    setOptimistic(null);
  }

  const visiblyBookmarked = optimistic ?? bookmarked;

  const handleClick = useCallback(() => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setError(null);
    const next = !visiblyBookmarked;
    setOptimistic(next);
    setPending(true);
    // Routed through Promise.resolve().then(...) so a caller whose onToggle
    // throws SYNCHRONOUSLY (violating its declared () => Promise<void>
    // contract) still reaches .catch()/.finally() below, instead of
    // permanently stranding pendingRef/pending in the "true" state with no
    // error shown and no way to retry.
    void Promise.resolve()
      .then(onToggle)
      .catch(() => {
        setOptimistic(null);
        setError(WRITE_FAILURE_MESSAGE);
      })
      .finally(() => {
        pendingRef.current = false;
        setPending(false);
      });
  }, [onToggle, visiblyBookmarked]);

  const Icon = visiblyBookmarked ? BookmarkCheck : Bookmark;
  const actionLabel = visiblyBookmarked
    ? `Remove "${entryLabel}" from bookmarks`
    : `Save "${entryLabel}"`;

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <Button
        type="button"
        variant={visiblyBookmarked ? "default" : "outline"}
        size={size === "sm" ? "icon" : "icon-lg"}
        aria-pressed={visiblyBookmarked}
        aria-label={actionLabel}
        disabled={pending}
        onClick={handleClick}
        data-testid="bookmark-toggle"
        data-bookmarked={visiblyBookmarked}
        data-pending={pending}
        className={cn("min-h-11 min-w-11", className)}
      >
        {pending ? (
          <Loader2 aria-hidden className="animate-spin" />
        ) : (
          <Icon aria-hidden />
        )}
      </Button>
      {error !== null && (
        <p role="status" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
}
