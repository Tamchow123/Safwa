"use client";

/**
 * Verify-email status + resend (Phase 15, phases-15.md §35; Phase 18.3).
 * Reads only the two query params Better Auth's own `/api/auth/verify-email`
 * GET endpoint can produce on its redirect (verified against the installed
 * package):
 * - on success it redirects to the `callbackURL` unchanged. Every link is
 *   sent with `VERIFY_EMAIL_CALLBACK_URL` (`modules/auth/verification-links`),
 *   so success arrives carrying `verified=1`. This covers both "just
 *   verified" and "already verified", which the redirect alone cannot tell
 *   apart, hence one combined success state.
 * - on failure it appends `error=<CODE>`, where CODE is one of Better Auth's
 *   own BASE_ERROR_CODES keys (TOKEN_EXPIRED, INVALID_TOKEN, USER_NOT_FOUND).
 *   An error wins over the marker, since a failed link to the same callback
 *   carries both.
 *
 * Anything else — a direct visit, a bookmark, a link sent before 18.3 with the
 * bare callback — is not evidence of anything, so it gets a neutral state that
 * claims nothing, with the resend form and a way to sign in for a learner who
 * is in fact already verified. Before 18.3 that visit said "Email verified".
 *
 * Never displays the raw token — this page never reads or reflects the
 * `token` query param at all.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";

import {
  RESEND_GENERIC_MESSAGE,
  useResendVerification,
} from "@/components/auth/use-resend-verification";
import { VERIFIED_PARAM } from "@/modules/auth/verification-links";
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

type VerifyState = "success" | "expired" | "invalid" | "unconfirmed";

function resolveVerifyState(params: URLSearchParams): VerifyState {
  const errorCode = params.get("error");
  if (errorCode !== null) {
    // INVALID_TOKEN, USER_NOT_FOUND, or any other/unrecognised code — all
    // mean the same thing to a learner: this link can't be used, request a
    // new one. Never reveal which specific reason applied.
    return errorCode === "TOKEN_EXPIRED" ? "expired" : "invalid";
  }
  return params.get(VERIFIED_PARAM) === "1" ? "success" : "unconfirmed";
}

/** The title and description of each state that offers a resend. */
const RESEND_STATE_COPY = {
  expired: {
    title: "This link has expired",
    description:
      "Verification links expire after a while. Enter your email to get a new one.",
  },
  invalid: {
    title: "This link isn't valid",
    description:
      "This verification link is invalid or has already been used. Enter your email to get a new one.",
  },
  unconfirmed: {
    title: "Verify your email",
    description:
      "Open the link in the verification email we sent you. If it hasn't arrived, enter your email to get a new one.",
  },
} as const;

function ResendForm() {
  const [email, setEmail] = useState("");
  const { sent, pending, error, resend } = useResendVerification();

  async function handleResend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    await resend(email);
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
  const state = resolveVerifyState(searchParams);

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

  const copy = RESEND_STATE_COPY[state];
  return (
    <Card data-testid={`verify-email-${state}`}>
      <CardHeader>
        <CardTitle>{copy.title}</CardTitle>
        <CardDescription>{copy.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ResendForm />
        <p className="text-muted-foreground text-center text-sm">
          {state === "unconfirmed" && "Already verified? "}
          <Link
            href="/login"
            className="text-foreground underline underline-offset-4"
          >
            {state === "unconfirmed" ? "Sign in" : "Back to sign in"}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
