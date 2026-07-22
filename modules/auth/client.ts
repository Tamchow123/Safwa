"use client";

/**
 * Browser auth client (Phase 15, phases-15.md §32). One Better Auth React
 * client, thinly re-exported — no wrapping of individual functions, no
 * secret/DB imports (this file is safe for client bundles; it must never
 * import modules/auth/server.ts, modules/env/server.ts, or db/client.ts).
 *
 * Method names verified against the actually-installed better-auth
 * package (not assumed): `createAuthClient` returns a dynamic proxy where
 * every property access resolves to a callable function regardless of
 * whether a real endpoint exists behind it, so a runtime check alone
 * cannot prove a method is genuine — every name re-exported below was
 * confirmed by TYPE-CHECKING a call against it (an intentionally bogus
 * method name fails to typecheck; all of these do not).
 */
import { createAuthClient } from "better-auth/react";
import { clientEnv } from "@/modules/env/client";

export const authClient = createAuthClient({
  baseURL: clientEnv.appUrl,
});

export const {
  signUp,
  signIn,
  signOut,
  useSession,
  requestPasswordReset,
  resetPassword,
  changePassword,
  sendVerificationEmail,
  verifyEmail,
  deleteUser,
} = authClient;
