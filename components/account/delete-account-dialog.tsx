"use client";

/**
 * Self-service account deletion (Phase 15, phases-15.md §51). Names the
 * account email explicitly and requires the current password — an
 * explicit, generic-failure-safe confirmation. `modules/auth/server.ts`
 * (T11) configures `deleteUser.sendDeleteAccountVerification`, so Better
 * Auth's own `/delete-user` endpoint never deletes on this call alone: it
 * verifies the password, then emails a confirmation link the learner
 * must click to actually complete the deletion (the same two-step shape
 * as password reset) — this dialog is honest about that, never claiming
 * the account is already gone. Deletion cascades every personal server
 * row via each table's own `ON DELETE CASCADE` foreign key to `users.id`
 * (already in place since earlier phases); local Dexie guest data is
 * never touched by this action.
 */
import { useState, type FormEvent } from "react";

import { useAuthFormSubmit } from "@/components/auth/use-auth-form-submit";
import { deleteUser } from "@/modules/auth/client";
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

export function DeleteAccountDialog({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [requested, setRequested] = useState(false);
  const { pending, error, submit } = useAuthFormSubmit();

  function resetFields() {
    setPassword("");
    setRequested(false);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    await submit(
      () => deleteUser({ password, callbackURL: "/" }),
      () => setRequested(true),
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) resetFields();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="destructive" className="min-h-11">
          Delete account
        </Button>
      </DialogTrigger>
      <DialogContent data-testid="delete-account-dialog">
        {requested ? (
          <>
            <DialogHeader>
              <DialogTitle>Check your email</DialogTitle>
              <DialogDescription>
                We sent a confirmation link to {email}. Follow it to finish
                deleting your account. Your account has not been deleted yet —
                this device&apos;s local study progress is never affected by
                this action.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Close
                </Button>
              </DialogClose>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Delete {email}?</DialogTitle>
              <DialogDescription>
                This permanently deletes your Safwa account and every
                server-stored record tied to it. This device&apos;s local study
                progress stays right here unless you clear it separately in
                Settings.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="delete-account-password">Password</Label>
                <Input
                  id="delete-account-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={pending}
                  required
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
                  variant="destructive"
                  disabled={pending || password.length === 0}
                >
                  {pending ? "Confirming…" : "Delete account"}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
