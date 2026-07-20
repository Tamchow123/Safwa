"use client";

/**
 * Searchable "add entries" dialog for a custom list (Phase 14 §16). Reuses
 * the existing library search utilities (Arabic + meaning) rather than
 * building a second full Library page. Already-added entries are visibly
 * marked, not hidden, so the learner can see full context while adding
 * several entries in one visit.
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { collectionErrorMessage } from "@/components/collections/error-messages";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { getSafwaDb } from "@/modules/content/db";
import { addEntryToList } from "@/modules/collections/persistence";
import {
  DEFAULT_LIBRARY_QUERY,
  queryLibraryEntries,
  type LibrarySearchIndex,
} from "@/modules/content/query";

const MAX_RESULTS = 50;

export function AddEntriesDialog({
  trigger,
  listId,
  memberEntryIds,
  searchIndex,
  knownEntryIds,
  onChanged,
}: {
  trigger: ReactNode;
  listId: string;
  memberEntryIds: ReadonlySet<number>;
  searchIndex: LibrarySearchIndex;
  knownEntryIds: ReadonlySet<number>;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [pendingEntryId, setPendingEntryId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const matched = useMemo(
    () =>
      queryLibraryEntries(searchIndex, {
        ...DEFAULT_LIBRARY_QUERY,
        search,
      }),
    [searchIndex, search],
  );
  const results = useMemo(() => matched.slice(0, MAX_RESULTS), [matched]);
  const truncated = matched.length > MAX_RESULTS;

  const handleAdd = useCallback(
    async (entryId: number) => {
      if (pendingEntryId !== null) return;
      setError(null);
      setPendingEntryId(entryId);
      try {
        await addEntryToList(
          getSafwaDb(),
          listId,
          entryId,
          knownEntryIds,
          Date.now(),
        );
        onChanged();
      } catch (addError) {
        setError(collectionErrorMessage(addError));
      } finally {
        setPendingEntryId(null);
      }
    },
    [pendingEntryId, listId, knownEntryIds, onChanged],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setSearch("");
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent data-testid="add-entries-dialog">
        <DialogHeader>
          <DialogTitle>Add entries</DialogTitle>
          <DialogDescription>
            Search by Arabic form or meaning.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search vocabulary"
          aria-label="Search vocabulary"
          autoFocus
        />
        <ul
          className="max-h-72 space-y-1 overflow-y-auto"
          data-testid="add-entries-results"
        >
          {results.length === 0 && (
            <li className="text-muted-foreground text-sm">
              No vocabulary matched your search.
            </li>
          )}
          {results.map((entry) => {
            const already = memberEntryIds.has(entry.id);
            return (
              <li
                key={entry.id}
                className="flex items-center justify-between gap-3 rounded-md px-2 py-1 text-sm"
              >
                <span className="flex-1 truncate">{entry.meaning}</span>
                <Button
                  type="button"
                  variant={already ? "secondary" : "outline"}
                  size="sm"
                  className="min-h-11"
                  disabled={already || pendingEntryId === entry.id}
                  onClick={() => void handleAdd(entry.id)}
                  aria-label={
                    already
                      ? `“${entry.meaning}” is already in this list`
                      : `Add “${entry.meaning}” to this list`
                  }
                >
                  {already ? "Added" : "Add"}
                </Button>
              </li>
            );
          })}
        </ul>
        {truncated && (
          <p className="text-muted-foreground text-xs" role="status">
            Showing the first {MAX_RESULTS} matches — refine your search to find
            more.
          </p>
        )}
        {error !== null && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Done
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
