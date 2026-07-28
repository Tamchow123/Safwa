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
 * (already in place since earlier phases). The confirmation link returns to
 * `deletedAccountCallback(nonce)`, where DeletedAccountCleanup removes this
 * device's copy of the deleted account's rows (phases-17.md §11) — a guest's own rows
 * are preserved, so someone studying as a guest on the same device keeps their
 * progress and their deferred merge. Both descriptions below say so: a learner
 * about to delete an account is entitled to know that this device's copy goes
 * with it, queued-but-unsynced work included.
 *
 * On acceptance this mints a one-time NONCE, keeps it locally
 * (`pending-account-deletion.ts`) and asks Better Auth to return to
 * `/?account-deleted=<nonce>`. Better Auth carries that URL inside the emailed
 * link and only redirects to it after the account is gone, so the nonce coming
 * back is what authorises the local clear — a link an attacker appends a marker
 * to cannot reproduce it, and neither can a session that merely ended. This is
 * the only place the nonce is written, and only after the server has verified
 * the learner's password.
 */
import { useState, type FormEvent } from "react";

import { useAuthFormSubmit } from "@/components/auth/use-auth-form-submit";
import { deletedAccountCallback } from "@/components/account/deleted-account-cleanup";
import {
  newAccountDeletionNonce,
  rememberPendingAccountDeletion,
} from "@/components/account/pending-account-deletion";
import { deleteUser, useSession } from "@/modules/auth/client";
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
  // Captured while the session is still alive — after the emailed link is
  // followed there is no session left to ask, which is the whole reason the
  // cleanup needs this written down in advance.
  const userId = useSession().data?.user?.id ?? null;

  function resetFields() {
    setPassword("");
    setRequested(false);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    // Minted BEFORE the request, because it has to be inside the callback URL
    // the server stores against the deletion token — that is what makes the
    // returning link unforgeable.
    const nonce = newAccountDeletionNonce();
    await submit(
      () =>
        deleteUser({ password, callbackURL: deletedAccountCallback(nonce) }),
      () => {
        // Only on success: the server has verified the password and sent the
        // confirmation mail. If the id could not be read there is nothing
        // honest to record, and the cleanup declines rather than guessing.
        if (userId !== null) {
          rememberPendingAccountDeletion(userId, nonce, Date.now());
        }
        setRequested(true);
      },
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
                deleting your account. Your account has not been deleted yet.
                Following that link on this device also clears this
                device&apos;s copy of the account&apos;s study progress.
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
                server-stored record tied to it. When you follow the emailed
                link on this device, this device&apos;s copy of the
                account&apos;s study progress is cleared too — including
                anything not yet synced. Progress saved while studying as a
                guest is kept.
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
