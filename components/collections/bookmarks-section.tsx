import Link from "next/link";

import { AddToListDialog } from "@/components/collections/add-to-list-dialog";
import { BookmarkToggle } from "@/components/collections/bookmark-toggle";
import { Button } from "@/components/ui/button";
import type { BookmarkRecord, CustomListRecord } from "@/modules/content/db";
import type { LearnerEntry } from "@/modules/content/schema";

/**
 * The Saved Vocabulary page's Bookmarks section (Phase 14 §15). Unknown
 * stored ids (not in the active release) are silently excluded here, never
 * destroyed (§8.5) — they simply have no `entriesById` entry to resolve.
 */
export function BookmarksSection({
  bookmarks,
  entriesById,
  lists,
  knownEntryIds,
  onRemove,
  onListsChanged,
}: {
  bookmarks: readonly BookmarkRecord[];
  entriesById: ReadonlyMap<number, LearnerEntry>;
  lists: readonly CustomListRecord[];
  knownEntryIds: ReadonlySet<number>;
  onRemove: (entryId: number) => Promise<void>;
  onListsChanged: () => void;
}) {
  const resolvable = bookmarks.filter((b) => entriesById.has(b.entryId));
  // Newest bookmark first, stable entry-id tie-break (§15) — never locale sort.
  const sorted = [...resolvable].sort(
    (a, b) => b.createdAt - a.createdAt || a.entryId - b.entryId,
  );

  return (
    <section aria-labelledby="saved-bookmarks-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="saved-bookmarks-heading" className="text-lg font-semibold">
          Bookmarks
        </h2>
        <span
          className="text-muted-foreground text-sm"
          data-testid="saved-bookmarks-count"
        >
          {sorted.length}
        </span>
      </div>
      {sorted.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Save words from the Library or after a study session to find them
          here.
        </p>
      ) : (
        <>
          <Button asChild variant="outline" className="min-h-11">
            <Link href="/study/custom?collection=bookmarks">
              Study bookmarks
            </Link>
          </Button>
          <ul className="space-y-2" data-testid="saved-bookmarks-list">
            {sorted.map((bookmark) => {
              const entry = entriesById.get(bookmark.entryId)!;
              return (
                <li
                  key={bookmark.entryId}
                  className="bg-card flex items-center justify-between gap-3 rounded-xl border p-3"
                >
                  <Link
                    href={`/library/${entry.id}`}
                    className="min-h-11 flex-1 truncate py-1 text-sm hover:underline"
                  >
                    {entry.meaning}
                  </Link>
                  <div className="flex shrink-0 items-center gap-1">
                    <AddToListDialog
                      trigger={
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="min-h-11"
                        >
                          Add to list
                        </Button>
                      }
                      entryId={entry.id}
                      entryLabel={entry.meaning}
                      lists={lists}
                      knownEntryIds={knownEntryIds}
                      onChanged={onListsChanged}
                    />
                    <BookmarkToggle
                      entryLabel={entry.meaning}
                      bookmarked={true}
                      onToggle={() => onRemove(entry.id)}
                      size="sm"
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
