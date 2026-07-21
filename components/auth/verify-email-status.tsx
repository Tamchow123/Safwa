"use client";

/**
 * Verify-email status + resend (Phase 15, phases-15.md §35). Reads the
 * `error` query param Better Auth's own `/api/auth/verify-email` GET
 * endpoint appends on redirect (verified against the installed package):
 * on success it redirects to the plain `callbackURL` (no query param at
 * all — this covers BOTH "just verified" and "already verified", which
 * are indistinguishable from this redirect alone, hence one combined
 * success state, "already-verified state where available"); on failure
 * it appends `?error=<CODE>` where CODE is one of Better Auth's own
 * BASE_ERROR_CODES keys (TOKEN_EXPIRED, INVALID_TOKEN, USER_NOT_FOUND).
 * Never displays the raw token — this page never reads or reflects the
 * `token` query param at all.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";

import { sendVerificationEmail } from "@/modules/auth/client";
import { toLearnerSafeMessage } from "@/modules/auth/errors";
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

const RESEND_GENERIC_MESSAGE =
  "If an account exists for that email and isn't verified yet, a new link is on its way.";

type VerifyState = "success" | "expired" | "invalid";

function resolveVerifyState(errorCode: string | null): VerifyState {
  if (errorCode === null) return "success";
  if (errorCode === "TOKEN_EXPIRED") return "expired";
  // INVALID_TOKEN, USER_NOT_FOUND, or any other/unrecognised code — all
  // mean the same thing to a learner: this link can't be used, request a
  // new one. Never reveal which specific reason applied.
  return "invalid";
}

function ResendForm() {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function handleResend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      const result = await sendVerificationEmail({
        email: email.trim().toLowerCase(),
        callbackURL: "/verify-email",
      });
      if (result.error) {
        setError(toLearnerSafeMessage(result.error));
        return;
      }
      setSent(true);
    } catch {
      setError(toLearnerSafeMessage(null));
    } finally {
      setPending(false);
    }
  }

  if (sent) {
    return (
      <p role="status" className="text-sm">
        {RESEND_GENERIC_MESSAGE}
      </p>
    );
  }

  return (
    <form onSubmit={handleResend} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="verify-resend-email">Email</Label>
        <Input
          id="verify-resend-email"
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
        {pending ? "Sending…" : "Resend verification email"}
      </Button>
    </form>
  );
}

export function VerifyEmailStatus() {
  const searchParams = useSearchParams();
  const state = resolveVerifyState(searchParams.get("error"));

  if (state === "success") {
    return (
      <Card data-testid="verify-email-success">
        <CardHeader>
          <CardTitle>Email verified</CardTitle>
          <CardDescription>
            Your email address is verified. You can sign in now.
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
    <Card
      data-testid={
        state === "expired" ? "verify-email-expired" : "verify-email-invalid"
      }
    >
      <CardHeader>
        <CardTitle>
          {state === "expired"
            ? "This link has expired"
            : "This link isn't valid"}
        </CardTitle>
        <CardDescription>
          {state === "expired"
            ? "Verification links expire after a while. Enter your email to get a new one."
            : "This verification link is invalid or has already been used. Enter your email to get a new one."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ResendForm />
        <p className="text-muted-foreground text-center text-sm">
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
