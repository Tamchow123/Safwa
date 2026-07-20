"use client";

/** Standalone "create a list" dialog (Phase 14 §9/§15/§24) — name only, no entry. */
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
import { createList } from "@/modules/collections/persistence";
import { LIST_NAME_MAX_LENGTH } from "@/modules/collections/validation";

export function CreateListDialog({
  trigger,
  onCreated,
}: {
  trigger: ReactNode;
  onCreated: (list: CustomListRecord) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const list = await createList(getSafwaDb(), { name, now: Date.now() });
      onCreated(list);
      setOpen(false);
      setName("");
    } catch (submitError) {
      // Keep the dialog open and preserve the entered text (§24).
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
        if (!next) setError(null);
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent data-testid="create-list-dialog">
        <DialogHeader>
          <DialogTitle>Create a list</DialogTitle>
          <DialogDescription>
            Group vocabulary you want to practise together.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="create-list-name">List name</Label>
            <Input
              id="create-list-name"
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
              {pending ? "Creating…" : "Create list"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
