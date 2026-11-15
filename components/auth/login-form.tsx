"use client";

/**
 * Login form (Phase 15, phases-15.md §36). Every credential failure —
 * unknown email, wrong password, missing credential account — maps to
 * Better Auth's own single `INVALID_EMAIL_OR_PASSWORD` code (verified
 * against the installed package's sign-in route: the password hash is
 * computed and discarded even for an unknown email, so the response time
 * and error code are identical either way). `EMAIL_NOT_VERIFIED` only
 * fires AFTER the password has already been verified correct, so showing
 * that specific message never tells an attacker anything they couldn't
 * already have learned by knowing the right password — and the same holds for
 * the "Resend verification email" offer that appears with it (Phase 18.3),
 * the only way back for an unverified learner who never got the first email.
 */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";

import { useAuthFormSubmit } from "@/components/auth/use-auth-form-submit";
import {
  RESEND_GENERIC_MESSAGE,
  useResendVerification,
} from "@/components/auth/use-resend-verification";
import { signIn } from "@/modules/auth/client";
import type { ERROR_CODE_MESSAGES } from "@/modules/auth/errors";
import { resolveSafeRedirect } from "@/modules/auth/redirects";
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

const EMAIL_NOT_VERIFIED: keyof typeof ERROR_CODE_MESSAGES =
  "EMAIL_NOT_VERIFIED";

/**
 * A new verification email for the address a sign-in was just refused for.
 * Stays clickable after a send, so a learner whose email never arrived can
 * ask again; the endpoint's own rate limit bounds how often, and a 429 reads
 * as "too many attempts" like every other auth form.
 */
function ResendVerificationOffer({ email }: { email: string }) {
  const { sent, pending, error, resend } = useResendVerification();

  return (
    <div data-testid="login-resend-verification" className="mt-4 space-y-2">
      {sent && error === null && (
        <p role="status" className="text-sm">
          {RESEND_GENERIC_MESSAGE}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={pending}
        onClick={() => void resend(email)}
      >
        {pending ? "Sending…" : "Resend verification email"}
      </Button>
    </div>
  );
}

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  // The address each sign-in was attempted with, numbered so a new attempt
  // starts the resend offer afresh. A resend goes to this address, not to
  // whatever the field holds by the time the learner clicks.
  const [attempt, setAttempt] = useState({ email: "", count: 0 });
  const { pending, error, errorCode, submit } = useAuthFormSubmit();

  const canSubmit = email.trim().length > 0 && password.length > 0;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const normalisedEmail = email.trim().toLowerCase();
    setAttempt((previous) => ({
      email: normalisedEmail,
      count: previous.count + 1,
    }));
    await submit(
      () =>
        signIn.email({
          email: normalisedEmail,
          password,
          rememberMe,
        }),
      () => router.push(resolveSafeRedirect(searchParams.get("next"))),
    );
  }

  return (
    <Card data-testid="login-form">
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Welcome back to Safwa.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="login-email">Email</Label>
            <Input
              id="login-email"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={pending}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="login-password">Password</Label>
            <Input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={pending}
              required
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(event) => setRememberMe(event.target.checked)}
              disabled={pending}
            />
            Remember me
          </label>
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
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        {errorCode === EMAIL_NOT_VERIFIED && (
          <ResendVerificationOffer key={attempt.count} email={attempt.email} />
        )}
        <div className="text-muted-foreground mt-4 flex flex-col items-center gap-1 text-center text-sm">
          <p>
            <Link
              href="/forgot-password"
              className="text-foreground underline underline-offset-4"
            >
              Forgot password?
            </Link>
          </p>
          <p>
            Don&apos;t have an account?{" "}
            <Link
              href="/register"
              className="text-foreground underline underline-offset-4"
            >
              Create one
            </Link>
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
