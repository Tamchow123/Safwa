"use client";

/** Rename a custom list (Phase 14 §17/§24). Pre-filled with the current name. */
import { useState, type FormEvent, type ReactNode } from "react";

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
import { renameList } from "@/modules/collections/persistence";
import { LIST_NAME_MAX_LENGTH } from "@/modules/collections/validation";

export function RenameListDialog({
  trigger,
  list,
  onRenamed,
}: {
  trigger: ReactNode;
  list: CustomListRecord;
  onRenamed: (list: CustomListRecord) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(list.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const renamed = await renameList(getSafwaDb(), list.id, name, Date.now());
      onRenamed(renamed);
      setOpen(false);
    } catch (submitError) {
      setError(collectionErrorMessage(submitError));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setName(list.name);
        else setError(null);
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent data-testid="rename-list-dialog">
        <DialogHeader>
          <DialogTitle>Rename “{list.name}”</DialogTitle>
          <DialogDescription>
            Choose a new name for this list.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="rename-list-name">List name</Label>
            <Input
              id="rename-list-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={LIST_NAME_MAX_LENGTH}
              autoFocus
              disabled={pending}
              aria-invalid={error !== null}
            />
          </div>
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
              type="submit"
              disabled={pending || name.trim().length === 0}
            >
              {pending ? "Saving…" : "Save name"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
