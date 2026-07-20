"use client";

/** One entry row inside a collection view (custom-list detail, §16) with a
 * detail link and a self-contained remove action (own pending/error state,
 * mirroring bookmark-toggle.tsx's honest-failure convention). */
import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { LearnerEntry } from "@/modules/content/schema";

const WRITE_FAILURE_MESSAGE =
  "Couldn't update your saved vocabulary. Please try again.";

export function CollectionEntryRow({
  entry,
  onRemove,
}: {
  entry: LearnerEntry;
  onRemove: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRemove = () => {
    if (pending) return;
    setError(null);
    setPending(true);
    void onRemove()
      .catch(() => setError(WRITE_FAILURE_MESSAGE))
      .finally(() => setPending(false));
  };

  return (
    <li
      className="bg-card flex items-center justify-between gap-3 rounded-xl border p-3"
      data-testid="collection-entry-row"
    >
      <Link
        href={`/library/${entry.id}`}
        className="min-h-11 flex-1 truncate py-1 text-sm hover:underline"
      >
        {entry.meaning}
      </Link>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-11"
          disabled={pending}
          onClick={handleRemove}
          aria-label={`Remove “${entry.meaning}” from this list`}
        >
          {pending ? "Removing…" : "Remove"}
        </Button>
        {error !== null && (
          <span role="alert" className="text-destructive text-xs">
            {error}
          </span>
        )}
      </div>
    </li>
  );
}
