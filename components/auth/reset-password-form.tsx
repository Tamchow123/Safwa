"use client";

/**
 * Reset-password form (Phase 15, phases-15.md §36). Better Auth's
 * `/reset-password/:token` GET callback (verified against the installed
 * package) redirects here with either `?token=<TOKEN>` (valid, unexpired)
 * or `?error=INVALID_TOKEN` — it uses the SAME code for "expired" and
 * "invalid/already used", so this page shows one combined message rather
 * than inventing a distinction Better Auth itself doesn't make. The token
 * is read once from the URL and passed straight to `resetPassword()`; it
 * is never logged, rendered, or written to storage.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";

import { useAuthFormSubmit } from "@/components/auth/use-auth-form-submit";
import { resetPassword } from "@/modules/auth/client";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "@/modules/auth/password-policy";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const linkInvalid = token === null || searchParams.get("error") !== null;

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [done, setDone] = useState(false);
  const { pending, error, setError, submit } = useAuthFormSubmit();

  const canSubmit =
    newPassword.length >= MIN_PASSWORD_LENGTH &&
    newPassword.length <= MAX_PASSWORD_LENGTH &&
    newPassword === confirmPassword;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || token === null) return;
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    await submit(
      () => resetPassword({ newPassword, token }),
      () => setDone(true),
    );
  }

  if (linkInvalid) {
    return (
      <Card data-testid="reset-password-invalid">
        <CardHeader>
          <CardTitle>This link isn&apos;t valid</CardTitle>
          <CardDescription>
            This password reset link is invalid or has expired. Request a new
            one to continue.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild className="w-full">
            <Link href="/forgot-password">Request a new link</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (done) {
    return (
      <Card data-testid="reset-password-done">
        <CardHeader>
          <CardTitle>Password updated</CardTitle>
          <CardDescription>
            Your password has been changed and you&apos;ve been signed out
            everywhere else. Sign in with your new password.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild className="w-full">
            <Link href="/login">Go to sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="reset-password-form">
      <CardHeader>
        <CardTitle>Choose a new password</CardTitle>
        <CardDescription>
          You&apos;ll be signed out of all other sessions once it&apos;s
          updated.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="reset-new-password">New password</Label>
            <Input
              id="reset-new-password"
              name="newPassword"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              disabled={pending}
              minLength={MIN_PASSWORD_LENGTH}
              maxLength={MAX_PASSWORD_LENGTH}
              aria-describedby="reset-new-password-hint"
              required
            />
            <p
              id="reset-new-password-hint"
              className="text-muted-foreground text-xs"
            >
              {MIN_PASSWORD_LENGTH}-{MAX_PASSWORD_LENGTH} characters.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reset-confirm-password">Confirm password</Label>
            <Input
              id="reset-confirm-password"
              name="confirmPassword"
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
            {confirmPassword.length > 0 && confirmPassword !== newPassword && (
              <p className="text-destructive text-xs">
                Passwords do not match.
              </p>
            )}
          </div>
          {error !== null && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={pending || !canSubmit}
          >
            {pending ? "Updating…" : "Update password"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
