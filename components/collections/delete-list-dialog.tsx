"use client";

/**
 * Delete-list confirmation (Phase 14 §17). Names the list explicitly and
 * explains exactly what is and is not affected. Deletion never touches
 * bookmarks, vocabulary data, study components, attempts, events, progress
 * or other lists — only the selected list's own row.
 */
import { useState, type ReactNode } from "react";

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
import { getSafwaDb } from "@/modules/content/db";
import type { CustomListRecord } from "@/modules/content/db";
import { deleteList } from "@/modules/collections/persistence";

export function DeleteListDialog({
  trigger,
  list,
  onDeleted,
}: {
  trigger: ReactNode;
  list: CustomListRecord;
  onDeleted: (listId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await deleteList(getSafwaDb(), list.id);
      setOpen(false);
      onDeleted(list.id);
    } catch (deleteError) {
      setError(collectionErrorMessage(deleteError));
    } finally {
      setPending(false);
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
      <DialogContent data-testid="delete-list-dialog">
        <DialogHeader>
          <DialogTitle>Delete “{list.name}”?</DialogTitle>
          <DialogDescription>
            The list will be deleted. Vocabulary progress is not affected.
            Bookmarks are not affected. Study attempts are not affected.
          </DialogDescription>
        </DialogHeader>
        {error !== null && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => void handleConfirm()}
          >
            {pending ? "Deleting…" : "Delete list"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
