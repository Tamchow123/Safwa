"use client";

/**
 * Saved Vocabulary page (Phase 14 §15): one client composing the verified
 * learner release (`useActiveContent`) with the ONE collections snapshot
 * (`useCollections`) into a Bookmarks section and a Custom lists section.
 */
import { useCallback, useMemo, useState } from "react";

import { BookmarksSection } from "@/components/collections/bookmarks-section";
import { CustomListsSection } from "@/components/collections/custom-lists-section";
import { useCollections } from "@/components/collections/use-collections";
import { useActiveContent } from "@/components/content/use-active-content";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getSafwaDb } from "@/modules/content/db";
import { setBookmarked } from "@/modules/collections/persistence";

export function SavedVocabularyClient() {
  const { state: content, retry: retryContent } = useActiveContent();
  const { state: collections, refresh: refreshCollections } = useCollections();
  // Resolved once per mount — this is display-only "last updated" text, not
  // a scheduling decision, so a single lazily-resolved instant is safe and
  // avoids calling Date.now() during render.
  const [nowMs] = useState(() => Date.now());

  const knownEntryIds = useMemo(
    () =>
      content.status === "ready"
        ? new Set(content.entries.map((entry) => entry.id))
        : new Set<number>(),
    [content],
  );
  const entriesById = useMemo(
    () =>
      content.status === "ready"
        ? new Map(content.entries.map((entry) => [entry.id, entry]))
        : new Map(),
    [content],
  );

  const handleRemoveBookmark = useCallback(
    async (entryId: number) => {
      await setBookmarked(
        getSafwaDb(),
        entryId,
        false,
        knownEntryIds,
        Date.now(),
      );
      refreshCollections();
    },
    [knownEntryIds, refreshCollections],
  );

  if (content.status === "loading" || collections.status === "loading") {
    return (
      <div
        className="space-y-4"
        role="status"
        aria-label="Loading saved vocabulary"
      >
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-32 w-full rounded-xl" />
        <span className="sr-only">Loading saved vocabulary…</span>
      </div>
    );
  }

  if (content.status === "error") {
    return (
      <Card>
        <CardContent role="alert" className="space-y-3">
          <p className="text-destructive text-sm">{content.message}</p>
          <Button type="button" variant="outline" onClick={retryContent}>
            Retry loading content
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (collections.status === "error") {
    return (
      <Card>
        <CardContent role="alert" className="space-y-3">
          <p className="text-destructive text-sm">{collections.message}</p>
          <Button type="button" variant="outline" onClick={refreshCollections}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { bookmarks, lists } = collections.snapshot;

  return (
    <div className="space-y-8">
      <BookmarksSection
        bookmarks={bookmarks}
        entriesById={entriesById}
        lists={lists}
        knownEntryIds={knownEntryIds}
        onRemove={handleRemoveBookmark}
        onListsChanged={refreshCollections}
      />
      <CustomListsSection
        lists={lists}
        nowMs={nowMs}
        onCreated={refreshCollections}
        onRenamed={refreshCollections}
        onDeleted={refreshCollections}
      />
    </div>
  );
}
