"use client";

/**
 * "Add to list" dialog for one entry (Phase 14 §14). Shows existing lists
 * with current membership, lets the learner toggle membership per list, and
 * offers an inline create-and-add-atomically flow for a brand-new list.
 * Never repeats the whole detail page inside the dialog.
 */
import { useCallback, useState, type FormEvent, type ReactNode } from "react";

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
import { Label } from "@/components/ui/label";
import { getSafwaDb } from "@/modules/content/db";
import type { CustomListRecord } from "@/modules/content/db";
import {
  addEntryToList,
  createListWithEntry,
  removeEntryFromList,
} from "@/modules/collections/persistence";
import { LIST_NAME_MAX_LENGTH } from "@/modules/collections/validation";

export function AddToListDialog({
  trigger,
  entryId,
  entryLabel,
  lists,
  knownEntryIds,
  onChanged,
}: {
  trigger: ReactNode;
  entryId: number;
  entryLabel: string;
  lists: readonly CustomListRecord[];
  knownEntryIds: ReadonlySet<number>;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pendingListId, setPendingListId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newListName, setNewListName] = useState("");
  const [creating, setCreating] = useState(false);

  const toggleMembership = useCallback(
    async (list: CustomListRecord) => {
      if (pendingListId !== null) return;
      setError(null);
      setPendingListId(list.id);
      try {
        const db = getSafwaDb();
        if (list.entryIds.includes(entryId)) {
          await removeEntryFromList(db, list.id, entryId, Date.now());
        } else {
          await addEntryToList(db, list.id, entryId, knownEntryIds, Date.now());
        }
        onChanged();
      } catch (toggleError) {
        setError(collectionErrorMessage(toggleError));
      } finally {
        setPendingListId(null);
      }
    },
    [pendingListId, entryId, knownEntryIds, onChanged],
  );

  const handleCreateAndAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      await createListWithEntry(getSafwaDb(), {
        name: newListName,
        entryId,
        knownEntryIds,
        now: Date.now(),
      });
      // Preserve entered text only on failure (§24) — clear it on success.
      setNewListName("");
      onChanged();
    } catch (createError) {
      setError(collectionErrorMessage(createError));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent data-testid="add-to-list-dialog">
        <DialogHeader>
          <DialogTitle>Add “{entryLabel}” to a list</DialogTitle>
          <DialogDescription>
            Choose existing lists or create a new one.
          </DialogDescription>
        </DialogHeader>

        {lists.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            You don’t have any lists yet.
          </p>
        ) : (
          <ul
            className="max-h-64 space-y-1 overflow-y-auto"
            data-testid="add-to-list-existing-lists"
          >
            {lists.map((list) => {
              const inList = list.entryIds.includes(entryId);
              return (
                <li key={list.id}>
                  <label className="hover:bg-muted flex min-h-11 items-center gap-2 rounded-md px-2 py-1 text-sm">
                    <input
                      type="checkbox"
                      checked={inList}
                      disabled={pendingListId === list.id}
                      onChange={() => void toggleMembership(list)}
                      aria-label={`${inList ? "Remove" : "Add"} “${entryLabel}” ${inList ? "from" : "to"} “${list.name}”`}
                    />
                    <span className="flex-1 truncate">{list.name}</span>
                    <span className="text-muted-foreground text-xs">
                      {list.entryIds.length}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        <form
          onSubmit={handleCreateAndAdd}
          className="flex items-end gap-2 border-t pt-3"
        >
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="add-to-list-new-name">New list</Label>
            <Input
              id="add-to-list-new-name"
              value={newListName}
              onChange={(event) => setNewListName(event.target.value)}
              maxLength={LIST_NAME_MAX_LENGTH}
              disabled={creating}
              placeholder="List name"
            />
          </div>
          <Button
            type="submit"
            disabled={creating || newListName.trim().length === 0}
          >
            {creating ? "Adding…" : "Create & add"}
          </Button>
        </form>

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
