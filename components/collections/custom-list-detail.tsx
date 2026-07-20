"use client";

/**
 * Custom-list detail page body (Phase 14 §16). Validates the route `id`
 * against the current collections snapshot — an unknown or deleted id shows
 * a safe not-found state, never a crash or an unrestricted session.
 */
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo } from "react";

import { AddEntriesDialog } from "@/components/collections/add-entries-dialog";
import { CollectionEntryRow } from "@/components/collections/collection-entry-row";
import { DeleteListDialog } from "@/components/collections/delete-list-dialog";
import { RenameListDialog } from "@/components/collections/rename-list-dialog";
import { useCollections } from "@/components/collections/use-collections";
import { useActiveContent } from "@/components/content/use-active-content";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getSafwaDb } from "@/modules/content/db";
import { removeEntryFromList } from "@/modules/collections/persistence";
import { createLibrarySearchIndex } from "@/modules/content/query";

function BackToSaved() {
  return (
    <Link
      href="/library/saved"
      className="text-muted-foreground hover:text-foreground inline-flex min-h-11 items-center gap-2 text-sm"
    >
      <ArrowLeft aria-hidden className="size-4" />
      Back to Saved vocabulary
    </Link>
  );
}

function NotFoundCard() {
  return (
    <div className="space-y-4">
      <BackToSaved />
      <Card>
        <CardContent role="alert" className="space-y-2">
          <p className="font-medium">List not found</p>
          <p className="text-muted-foreground text-sm">
            This list may have been deleted, or the address may be wrong.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export function CustomListDetail({ listId }: { listId: string }) {
  const router = useRouter();
  const { state: content, retry: retryContent } = useActiveContent();
  const { state: collections, refresh: refreshCollections } = useCollections();

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
  const searchIndex = useMemo(
    () =>
      content.status === "ready"
        ? createLibrarySearchIndex(content.entries)
        : [],
    [content],
  );

  const handleRemoveEntry = useCallback(
    async (entryId: number) => {
      await removeEntryFromList(getSafwaDb(), listId, entryId, Date.now());
      refreshCollections();
    },
    [listId, refreshCollections],
  );

  const handleDeleted = useCallback(() => {
    router.push("/library/saved");
  }, [router]);

  // Defence in depth (§21): list ids are always uuidv7 (36 chars); reject
  // anything overlong, empty, or shaped like JSON/a path/a component key
  // before it ever reaches a snapshot lookup. A real unknown-but-plausible
  // id still falls through safely to the snapshot-driven not-found below.
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(listId)) {
    return <NotFoundCard />;
  }

  if (content.status === "loading" || collections.status === "loading") {
    return (
      <div className="space-y-4">
        <BackToSaved />
        <div role="status" aria-label="Loading list" className="space-y-4">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
          <span className="sr-only">Loading list…</span>
        </div>
      </div>
    );
  }

  if (content.status === "error") {
    return (
      <div className="space-y-4">
        <BackToSaved />
        <Card>
          <CardContent role="alert" className="space-y-3">
            <p className="text-destructive text-sm">{content.message}</p>
            <Button type="button" variant="outline" onClick={retryContent}>
              Retry loading content
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (collections.status === "error") {
    return (
      <div className="space-y-4">
        <BackToSaved />
        <Card>
          <CardContent role="alert" className="space-y-3">
            <p className="text-destructive text-sm">{collections.message}</p>
            <Button
              type="button"
              variant="outline"
              onClick={refreshCollections}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const list = collections.snapshot.listsById.get(listId);
  if (!list) {
    return <NotFoundCard />;
  }

  const memberEntries = list.entryIds
    .map((entryId) => entriesById.get(entryId))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  const memberEntryIds = new Set(list.entryIds);

  return (
    <div className="space-y-5">
      <BackToSaved />
      <article className="space-y-5" data-testid="custom-list-detail">
        <header className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {list.name}
            </h1>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" className="min-h-11">
                <Link
                  href={`/study/custom?list=${encodeURIComponent(list.id)}`}
                >
                  Study list
                </Link>
              </Button>
              <RenameListDialog
                trigger={
                  <Button type="button" variant="outline" className="min-h-11">
                    Rename
                  </Button>
                }
                list={list}
                onRenamed={refreshCollections}
              />
              <DeleteListDialog
                trigger={
                  <Button
                    type="button"
                    variant="outline"
                    className="text-destructive min-h-11"
                  >
                    Delete
                  </Button>
                }
                list={list}
                onDeleted={handleDeleted}
              />
            </div>
          </div>
          <p className="text-muted-foreground text-sm">
            {list.entryIds.length}{" "}
            {list.entryIds.length === 1 ? "entry" : "entries"}
          </p>
        </header>

        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Entries</h2>
          <AddEntriesDialog
            trigger={
              <Button type="button" className="min-h-11">
                Add entries
              </Button>
            }
            listId={list.id}
            memberEntryIds={memberEntryIds}
            searchIndex={searchIndex}
            knownEntryIds={knownEntryIds}
            onChanged={refreshCollections}
          />
        </div>

        {memberEntries.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            This list is empty. Use “Add entries” to start adding vocabulary.
          </p>
        ) : (
          <ul className="space-y-2" data-testid="custom-list-entries">
            {memberEntries.map((entry) => (
              <CollectionEntryRow
                key={entry.id}
                entry={entry}
                onRemove={() => handleRemoveEntry(entry.id)}
              />
            ))}
          </ul>
        )}
      </article>
    </div>
  );
}
