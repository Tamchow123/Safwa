"use client";

/**
 * In-session password change (Phase 15, phases-15.md §37). Distinct from
 * the T14 forgot/reset-password email flow: this requires the CURRENT
 * password and an active session (Better Auth's `/change-password`
 * endpoint), for a learner who already remembers their password and just
 * wants to rotate it. `revokeOtherSessions: true` matches the reset-
 * password flow's own behaviour for consistency.
 */
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { useAuthFormSubmit } from "@/components/auth/use-auth-form-submit";
import { changePassword } from "@/modules/auth/client";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "@/modules/auth/password-policy";
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

export function ChangePasswordDialog() {
  const [open, setOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const { pending, error, setError, submit } = useAuthFormSubmit();

  const canSubmit =
    currentPassword.length > 0 &&
    newPassword.length >= MIN_PASSWORD_LENGTH &&
    newPassword.length <= MAX_PASSWORD_LENGTH &&
    newPassword === confirmPassword;

  function resetFields() {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    await submit(
      () =>
        changePassword({
          currentPassword,
          newPassword,
          revokeOtherSessions: true,
        }),
      () => {
        setOpen(false);
        resetFields();
        toast("Password updated", {
          description: "You've been signed out of your other sessions.",
        });
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          resetFields();
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" className="min-h-11">
          Change password
        </Button>
      </DialogTrigger>
      <DialogContent data-testid="change-password-dialog">
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription>
            You&apos;ll be signed out of your other sessions once it&apos;s
            updated.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="change-password-current">Current password</Label>
            <Input
              id="change-password-current"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              disabled={pending}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="change-password-new">New password</Label>
            <Input
              id="change-password-new"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              disabled={pending}
              minLength={MIN_PASSWORD_LENGTH}
              maxLength={MAX_PASSWORD_LENGTH}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="change-password-confirm">
              Confirm new password
            </Label>
            <Input
              id="change-password-confirm"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              disabled={pending}
              aria-invalid={
                confirmPassword.length > 0 && confirmPassword !== newPassword
              }
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
            <Button type="submit" disabled={pending || !canSubmit}>
              {pending ? "Updating…" : "Update password"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
