"use client";

import Link from "next/link";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
} from "react";

import { useActiveContent } from "@/components/content/use-active-content";
import { useCollections } from "@/components/collections/use-collections";
import { ContentSourceNotice } from "@/components/library/content-source-notice";
import { LibraryToolbar } from "@/components/library/library-toolbar";
import { useLibraryQuery } from "@/components/library/use-library-query";
import { VirtualisedEntryList } from "@/components/library/virtualised-entry-list";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getSafwaDb } from "@/modules/content/db";
import type { ContentSource, FallbackReason } from "@/modules/content/load";
import type { LearnerEntry } from "@/modules/content/schema";
import {
  createLibrarySearchIndex,
  deriveLibraryFilterOptions,
  queryLibraryEntries,
} from "@/modules/content/query";
import { toggleBookmark } from "@/modules/collections/persistence";

export function LibraryPageClient() {
  const { state, retry } = useActiveContent();

  if (state.status === "loading") {
    return (
      <div className="space-y-4" role="status" aria-label="Loading vocabulary">
        <Skeleton className="h-9 w-full" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </div>
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-32 w-full rounded-xl" />
        <span className="sr-only">Loading vocabulary…</span>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <Card>
        <CardContent role="alert" className="space-y-3">
          <p className="text-destructive text-sm">{state.message}</p>
          <Button type="button" variant="outline" onClick={retry}>
            Retry loading content
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <LoadedLibrary
      entries={state.entries}
      releaseId={state.releaseId}
      source={state.source}
      fallbackReason={state.fallbackReason}
      onRefresh={retry}
    />
  );
}

function LoadedLibrary({
  entries,
  releaseId,
  source,
  fallbackReason,
  onRefresh,
}: {
  entries: LearnerEntry[];
  releaseId: string;
  source: ContentSource;
  fallbackReason?: FallbackReason;
  onRefresh: () => void;
}) {
  const options = useMemo(() => deriveLibraryFilterOptions(entries), [entries]);
  const searchIndex = useMemo(
    () => createLibrarySearchIndex(entries),
    [entries],
  );
  const knownEntryIds = useMemo(
    () => new Set(entries.map((entry) => entry.id)),
    [entries],
  );

  const { state: collections, refresh: refreshCollections } = useCollections();
  const bookmarkedEntryIds = useMemo(
    () =>
      collections.status === "ready"
        ? collections.snapshot.bookmarkedEntryIds
        : new Set<number>(),
    [collections],
  );
  const handleToggleBookmark = useCallback(
    async (entryId: number) => {
      await toggleBookmark(getSafwaDb(), entryId, knownEntryIds, Date.now());
      refreshCollections();
    },
    [knownEntryIds, refreshCollections],
  );

  const { query, updateQuery, resetFilters } = useLibraryQuery(options);

  const deferredSearch = useDeferredValue(query.search);
  const results = useMemo(
    () =>
      queryLibraryEntries(searchIndex, { ...query, search: deferredSearch }),
    [searchIndex, query, deferredSearch],
  );

  // Filter/sort changes (not search typing) reset scroll to the top of the
  // results so the virtual list starts at the first match.
  const filterKey = `${query.bab}|${query.verbType}|${query.bookPage}|${query.eligibility}|${query.sort}`;
  const previousFilterKey = useRef(filterKey);
  useEffect(() => {
    if (previousFilterKey.current !== filterKey) {
      previousFilterKey.current = filterKey;
      window.scrollTo({ top: 0 });
    }
  }, [filterKey]);

  const resultText =
    results.length === entries.length
      ? `${entries.length} entries`
      : results.length === 0
        ? "No vocabulary matched your search"
        : `${results.length} entries match your filters`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <LibraryToolbar
          query={query}
          options={options}
          onChange={updateQuery}
          onReset={resetFilters}
        />
        <Button asChild variant="outline" className="min-h-11 shrink-0">
          <Link href="/library/saved">Saved vocabulary</Link>
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p
          aria-live="polite"
          data-testid="library-result-count"
          className="text-sm font-medium"
        >
          {resultText}
        </p>
        <ContentSourceNotice
          releaseId={releaseId}
          source={source}
          fallbackReason={fallbackReason}
          onRefresh={onRefresh}
        />
      </div>
      {results.length === 0 ? (
        <Card>
          <CardContent className="space-y-3">
            <p className="text-muted-foreground text-sm">
              No vocabulary matched your search or filters.
            </p>
            <Button type="button" variant="outline" onClick={resetFilters}>
              Reset filters
            </Button>
          </CardContent>
        </Card>
      ) : (
        <VirtualisedEntryList
          entries={results}
          bookmarkedEntryIds={bookmarkedEntryIds}
          onToggleBookmark={handleToggleBookmark}
        />
      )}
    </div>
  );
}
