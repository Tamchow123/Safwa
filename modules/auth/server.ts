/**
 * Better Auth server instance (Phase 15). This slice (T3) wires the
 * Drizzle adapter, UUID ids and explicit plural model-name mappings so the
 * CLI-generated schema (db/schema/auth.ts) and this config never drift.
 * Email delivery, rate-limit path rules and the `AUTH_ENABLED` kill-switch
 * are deliberately NOT wired here yet — a later slice (T11) expands this
 * once the provider-neutral email adapter (modules/email/*) exists.
 *
 * `role` is exposed as an `additionalField` with `input: false`: Better
 * Auth then strips it from anything a client can set via sign-up/update
 * calls (CLAUDE.md — role is server-owned), while still returning it on
 * the session/user object.
 *
 * Construction is LAZY and memoised (`getAuth()`), matching
 * `getServerEnv()`/`getDb()`'s own pattern: building the instance touches
 * both, so merely importing this module — e.g. a future shared
 * session-check helper (modules/auth/session.ts, T12) pulled into guest
 * and signed-in pages alike — must never validate env or construct a DB
 * pool on its own. Only an actual call (a route handler, a session read)
 * pays that cost.
 */
import "server-only";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { getServerEnv } from "@/modules/env/server";

// `ReturnType<typeof createAuth>`, not `ReturnType<typeof betterAuth>`: the
// latter resolves betterAuth's generic default shape, which TypeScript then
// treats as a DIFFERENT (structurally incompatible) instantiation from the
// specific one this config actually produces — annotating createAuth's
// return type against it fails to typecheck. Inferring from createAuth
// itself always matches by construction.
type Auth = ReturnType<typeof createAuth>;

let cachedAuth: Auth | undefined;

function createAuth() {
  const env = getServerEnv();
  return betterAuth({
    baseURL: env.betterAuthUrl,
    secret: env.betterAuthSecret,
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
        rateLimit: schema.rateLimits,
      },
    }),
    advanced: {
      database: { generateId: "uuid" },
    },
    rateLimit: {
      storage: "database",
      modelName: "rate_limits",
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
    },
    user: {
      modelName: "users",
      additionalFields: {
        role: {
          type: "string",
          required: false,
          defaultValue: "learner",
          input: false,
        },
      },
    },
    session: { modelName: "sessions" },
    account: { modelName: "accounts" },
    verification: { modelName: "verifications" },
  });
}

/** The shared Better Auth instance. Lazy: constructed on first call only. */
export function getAuth(): Auth {
  if (!cachedAuth) {
    cachedAuth = createAuth();
  }
  return cachedAuth;
}
