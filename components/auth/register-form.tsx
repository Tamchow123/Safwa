"use client";

/**
 * Registration form (Phase 15, phases-15.md §34). "Generic existing-
 * account behaviour" is satisfied by Better Auth's own server-side design
 * (verified against the installed package): with `requireEmailVerification:
 * true` set in modules/auth/server.ts, `signUp.email()` returns the SAME
 * `{error: null, data: {token: null, user: {...}}}` shape whether the
 * email is genuinely new or already registered — this form never needs to
 * (and never does) special-case "already exists" itself; it only ever
 * branches on `result.error`.
 */
import Link from "next/link";
import { useState, type FormEvent } from "react";

import { signUp } from "@/modules/auth/client";
import { toLearnerSafeMessage } from "@/modules/auth/errors";
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

export function RegisterForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registeredEmail, setRegisteredEmail] = useState<string | null>(null);

  const passwordsMatch =
    confirmPassword.length === 0 || password === confirmPassword;
  const canSubmit =
    name.trim().length > 0 &&
    email.trim().length > 0 &&
    password.length >= MIN_PASSWORD_LENGTH &&
    password.length <= MAX_PASSWORD_LENGTH &&
    password === confirmPassword;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (
      password.length < MIN_PASSWORD_LENGTH ||
      password.length > MAX_PASSWORD_LENGTH
    ) {
      setError(
        `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.`,
      );
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();
    setPending(true);
    try {
      const result = await signUp.email({
        name: name.trim(),
        email: normalizedEmail,
        password,
        callbackURL: "/verify-email",
      });
      if (result.error) {
        setError(toLearnerSafeMessage(result.error));
        return;
      }
      setRegisteredEmail(normalizedEmail);
    } catch {
      setError(toLearnerSafeMessage(null));
    } finally {
      setPending(false);
    }
  }

  if (registeredEmail !== null) {
    return (
      <Card data-testid="register-verification-notice">
        <CardHeader>
          <CardTitle>Check your email</CardTitle>
          <CardDescription>
            We sent a verification link to {registeredEmail}. Follow it to
            finish creating your account — you can&apos;t sign in until your
            email is verified.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline" className="w-full">
            <Link href="/login">Go to sign in</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="register-form">
      <CardHeader>
        <CardTitle>Create an account</CardTitle>
        <CardDescription>
          Track your progress with a Safwa account.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="register-name">Name</Label>
            <Input
              id="register-name"
              name="name"
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={pending}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="register-email">Email</Label>
            <Input
              id="register-email"
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
            <Label htmlFor="register-password">Password</Label>
            <Input
              id="register-password"
              name="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={pending}
              minLength={MIN_PASSWORD_LENGTH}
              maxLength={MAX_PASSWORD_LENGTH}
              aria-describedby="register-password-hint"
              required
            />
            <p
              id="register-password-hint"
              className="text-muted-foreground text-xs"
            >
              {MIN_PASSWORD_LENGTH}-{MAX_PASSWORD_LENGTH} characters.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="register-confirm-password">Confirm password</Label>
            <Input
              id="register-confirm-password"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              disabled={pending}
              aria-invalid={!passwordsMatch}
              required
            />
            {!passwordsMatch && (
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
            {pending ? "Creating account…" : "Create account"}
          </Button>
        </form>
        <p className="text-muted-foreground mt-4 text-center text-sm">
          Already have an account?{" "}
          <Link
            href="/login"
            className="text-foreground underline underline-offset-4"
          >
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
