/**
 * Server-side session read (Phase 15, phases-15.md §32). Wraps
 * `auth.api.getSession` with Next.js 16's awaited `headers()` — the
 * standard Better Auth + Next.js App Router pattern.
 *
 * Returns `null` (never throws) when auth is disabled
 * (`AUTH_ENABLED=false`, surfaced by `getAuth()` as `AuthDisabledError`)
 * instead of propagating that error — guest-facing pages/nav must be able
 * to call this unconditionally without special-casing the flag
 * themselves (phases-15.md §45/§46: disabling auth must never break
 * guest rendering, and no DB read is required to render guest content).
 */
import "server-only";
import { headers } from "next/headers";
import { AuthDisabledError, getAuth } from "@/modules/auth/server";

export type AuthSession = Awaited<
  ReturnType<ReturnType<typeof getAuth>["api"]["getSession"]>
>;

export async function getServerSession(): Promise<AuthSession | null> {
  let auth: ReturnType<typeof getAuth>;
  try {
    auth = getAuth();
  } catch (error) {
    if (error instanceof AuthDisabledError) {
      return null;
    }
    throw error;
  }
  return auth.api.getSession({ headers: await headers() });
}
