"use client";

/**
 * Forgot-password request form (Phase 15, phases-15.md §36). Always shows
 * the same generic confirmation regardless of whether the email exists or
 * is already verified — Better Auth's own `/request-password-reset`
 * endpoint is enumeration-safe server-side (constant-time floor, fixed
 * `{status:true}` response), so this form never needs to special-case
 * "not found" itself.
 */
import Link from "next/link";
import { useState, type FormEvent } from "react";

import { useAuthFormSubmit } from "@/components/auth/use-auth-form-submit";
import { requestPasswordReset } from "@/modules/auth/client";
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

const GENERIC_SENT_MESSAGE =
  "If an account exists for that email, a password reset link is on its way.";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const { pending, error, submit } = useAuthFormSubmit();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    await submit(
      () =>
        requestPasswordReset({
          email: email.trim().toLowerCase(),
          redirectTo: "/reset-password",
        }),
      () => setSent(true),
    );
  }

  if (sent) {
    return (
      <Card data-testid="forgot-password-sent">
        <CardHeader>
          <CardTitle>Check your email</CardTitle>
          <CardDescription>{GENERIC_SENT_MESSAGE}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline" className="w-full">
            <Link href="/login">Back to sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="forgot-password-form">
      <CardHeader>
        <CardTitle>Reset your password</CardTitle>
        <CardDescription>
          Enter your email and we&apos;ll send you a reset link.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="forgot-password-email">Email</Label>
            <Input
              id="forgot-password-email"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={pending}
              required
            />
          </div>
          {error !== null && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={pending || email.trim().length === 0}
          >
            {pending ? "Sending…" : "Send reset link"}
          </Button>
        </form>
        <p className="text-muted-foreground mt-4 text-center text-sm">
          <Link
            href="/login"
            className="text-foreground underline underline-offset-4"
          >
            Back to sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
