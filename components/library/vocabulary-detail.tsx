"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useCallback, useMemo } from "react";

import { ArabicText } from "@/components/arabic-text";
import { AddToListDialog } from "@/components/collections/add-to-list-dialog";
import { BookmarkToggle } from "@/components/collections/bookmark-toggle";
import { useCollections } from "@/components/collections/use-collections";
import { useActiveContent } from "@/components/content/use-active-content";
import { useResolveOwner } from "@/components/sync/use-local-owner";
import { ContentSourceNotice } from "@/components/library/content-source-notice";
import { EligibilityBadge } from "@/components/library/eligibility-badge";
import { EntryProgressCard } from "@/components/library/entry-progress";
import { EntryRecord } from "@/components/library/entry-record";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getSafwaDb } from "@/modules/content/db";
import type { CustomListRecord } from "@/modules/content/db";
import type { LearnerEntry } from "@/modules/content/schema";
import { toggleBookmark } from "@/modules/collections/persistence";

function BackToLibrary() {
  return (
    <Link
      href="/library"
      className="text-muted-foreground hover:text-foreground inline-flex min-h-11 items-center gap-2 text-sm"
    >
      <ArrowLeft aria-hidden className="size-4" />
      Back to library
    </Link>
  );
}

function NotFoundCard() {
  return (
    <div className="space-y-4">
      <BackToLibrary />
      <Card>
        <CardContent role="alert" className="space-y-2">
          <p className="font-medium">Entry not found</p>
          <p className="text-muted-foreground text-sm">
            There is no vocabulary entry at this address. It may have been
            mistyped — the library lists every available entry.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/** Detail page body. `idParam` is the raw route segment (validated here). */
export function VocabularyDetail({ idParam }: { idParam: string }) {
  const { state, retry } = useActiveContent();
  // Hooks run unconditionally, before any early return below.
  const resolveOwner = useResolveOwner();
  const { state: collections, refresh: refreshCollections } = useCollections();
  const knownEntryIds = useMemo(
    () =>
      state.status === "ready"
        ? new Set(state.entries.map((candidate) => candidate.id))
        : new Set<number>(),
    [state],
  );
  const handleToggleBookmark = useCallback(
    async (entryId: number) => {
      // ARCH-002: resolve the owner at action time (see useResolveOwner).
      const owner = await resolveOwner();
      await toggleBookmark(
        getSafwaDb(),
        entryId,
        knownEntryIds,
        Date.now(),
        owner,
      );
      refreshCollections();
    },
    [knownEntryIds, refreshCollections, resolveOwner],
  );

  // The route id must be a positive integer (stable learner entry id).
  const valid = /^[1-9][0-9]*$/.test(idParam);
  const entryId = valid ? Number(idParam) : null;

  if (!valid) {
    return <NotFoundCard />;
  }

  if (state.status === "loading") {
    return (
      <div className="space-y-4">
        <BackToLibrary />
        <div role="status" aria-label="Loading entry" className="space-y-4">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
          <span className="sr-only">Loading entry…</span>
        </div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="space-y-4">
        <BackToLibrary />
        <Card>
          <CardContent role="alert" className="space-y-3">
            <p className="text-destructive text-sm">{state.message}</p>
            <Button type="button" variant="outline" onClick={retry}>
              Retry loading content
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Exact-id lookup only — never positional.
  const entry = state.entries.find((candidate) => candidate.id === entryId);
  if (!entry) {
    return <NotFoundCard />;
  }

  const bookmarked =
    collections.status === "ready" &&
    collections.snapshot.bookmarkedEntryIds.has(entry.id);
  const lists =
    collections.status === "ready" ? collections.snapshot.lists : [];

  return (
    <div className="space-y-5">
      <BackToLibrary />
      <EntryDetail
        entry={entry}
        bookmarked={bookmarked}
        lists={lists}
        knownEntryIds={knownEntryIds}
        onToggleBookmark={() => handleToggleBookmark(entry.id)}
        onListsChanged={refreshCollections}
      />
      <ContentSourceNotice
        releaseId={state.releaseId}
        source={state.source}
        fallbackReason={state.fallbackReason}
        onRefresh={retry}
      />
    </div>
  );
}

function EntryDetail({
  entry,
  bookmarked,
  lists,
  knownEntryIds,
  onToggleBookmark,
  onListsChanged,
}: {
  entry: LearnerEntry;
  bookmarked: boolean;
  lists: readonly CustomListRecord[];
  knownEntryIds: ReadonlySet<number>;
  onToggleBookmark: () => Promise<void>;
  onListsChanged: () => void;
}) {
  const memberLists = lists.filter((list) => list.entryIds.includes(entry.id));
  return (
    <article className="space-y-5" data-testid="entry-detail">
      <header className="space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <ArabicText
            as="h1"
            className="text-4xl font-medium"
            data-testid="detail-madi"
          >
            {entry.madi}
          </ArabicText>
          <span className="text-muted-foreground text-sm">
            Entry #{entry.id}
          </span>
        </div>
        {/* The entry's ONE base lexical meaning — shown once, here, labelled as
            such. It is not a literal translation of each supplied form. */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Base meaning
          </span>
          <EligibilityBadge eligible={entry.quiz_eligibility.meaning} />
        </div>
        <p className="text-lg" data-testid="detail-meaning">
          {entry.meaning}
        </p>
      </header>

      <EntryRecord entry={entry} />

      <div className="grid gap-5 sm:grid-cols-2">
        <EntryProgressCard entry={entry} />
        <Card data-testid="detail-collections">
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium">Saved vocabulary</span>
              <BookmarkToggle
                entryLabel={entry.meaning}
                bookmarked={bookmarked}
                onToggle={onToggleBookmark}
              />
            </div>
            <AddToListDialog
              trigger={
                <Button type="button" variant="outline" className="min-h-11">
                  Add to list
                </Button>
              }
              entryId={entry.id}
              entryLabel={entry.meaning}
              lists={lists}
              knownEntryIds={knownEntryIds}
              onChanged={onListsChanged}
            />
            {memberLists.length > 0 && (
              <p
                className="text-muted-foreground text-sm"
                data-testid="detail-list-membership"
              >
                In {memberLists.map((list) => list.name).join(", ")}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </article>
  );
}
