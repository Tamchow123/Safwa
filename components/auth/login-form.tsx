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
 * already have learned by knowing the right password.
 */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";

import { useAuthFormSubmit } from "@/components/auth/use-auth-form-submit";
import { signIn } from "@/modules/auth/client";
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

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const { pending, error, submit } = useAuthFormSubmit();

  const canSubmit = email.trim().length > 0 && password.length > 0;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    await submit(
      () =>
        signIn.email({
          email: email.trim().toLowerCase(),
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
