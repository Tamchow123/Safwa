/**
 * Better Auth server instance (Phase 15, phases-15.md §30). This slice
 * (T11) wires email/password auth with mandatory verification, password
 * reset and self-service account deletion — all three callbacks dispatch
 * through the provider-neutral email adapter (modules/email/send-email.ts,
 * T9/T10), never a specific transport. Database-backed rate limiting adds
 * explicit rules on every sensitive endpoint. No OAuth, magic links,
 * passkeys, 2FA or organisations are enabled — only the features listed
 * here exist.
 *
 * `role` is exposed as an `additionalField` with `input: false`: Better
 * Auth then strips it from anything a client can set via sign-up/update
 * calls (CLAUDE.md — role is server-owned), while still returning it on
 * the session/user object.
 *
 * Construction is LAZY and memoised (`getAuth()`), matching
 * `getServerEnv()`/`getDb()`'s own pattern: building the instance touches
 * both, so merely importing this module must never validate env or
 * construct a DB pool on its own. Only an actual call (a route handler, a
 * session read) pays that cost.
 *
 * The `AUTH_ENABLED` kill-switch is enforced HERE, inside `getAuth()`
 * itself (throwing `AuthDisabledError`) — not merely as a convention each
 * caller must remember to apply. app/api/auth/[...all]/route.ts still
 * checks the flag before calling `getAuth()` too, as a fast path that
 * returns a clean 503 without paying for a throw/catch, but that is a UX
 * optimisation layered on top of this module's own guarantee, not the
 * sole enforcement — any future caller (e.g. a session-check helper) is
 * protected even if it forgets to check the flag itself, so disabling
 * auth can never construct the Drizzle adapter or touch the DB.
 */
import "server-only";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { sendEmail } from "@/modules/email/send-email";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "@/modules/auth/password-policy";
import { getServerEnv } from "@/modules/env/server";

// Explicit per phases-15.md §30 ("Configure verification and reset token
// expiry explicitly") — these match Better Auth's own sensible defaults,
// made intentional/documented rather than left implicit.
const EMAIL_VERIFICATION_EXPIRES_IN_SECONDS = 60 * 60; // 1 hour
const RESET_PASSWORD_TOKEN_EXPIRES_IN_SECONDS = 60 * 60; // 1 hour
const DELETE_ACCOUNT_TOKEN_EXPIRES_IN_SECONDS = 60 * 60 * 24; // 1 day
// Explicit per phases-15.md §44 ("Session expiry/refresh policy
// explicitly configured") — again matching Better Auth's own defaults.
const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7; // 7 days
const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24; // 1 day

export class AuthDisabledError extends Error {
  constructor() {
    super("Authentication is disabled (AUTH_ENABLED=false)");
    this.name = "AuthDisabledError";
  }
}

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

  // One customRule per phases-15.md §43's explicit endpoint list, all
  // sharing one configurable window/max pair so integration tests can
  // dial both down to trigger the limit quickly without disabling rate
  // limiting outright. Exact path strings verified against this
  // installed Better Auth version's endpoint definitions.
  const sensitiveEndpointRule = {
    window: env.authRateLimitWindowSeconds,
    max: env.authRateLimitMax,
  };
  const rateLimitCustomRules = {
    "/sign-up/email": sensitiveEndpointRule,
    "/sign-in/email": sensitiveEndpointRule,
    "/send-verification-email": sensitiveEndpointRule,
    "/request-password-reset": sensitiveEndpointRule,
    "/reset-password": sensitiveEndpointRule,
    "/delete-user": sensitiveEndpointRule,
    // The endpoint that actually performs the irreversible deletion (the
    // learner's emailed confirmation link lands here) — every other
    // sensitive endpoint above gets this same tuned rule, and this one
    // guards the highest-consequence action of the six.
    "/delete-user/callback": sensitiveEndpointRule,
  };

  return betterAuth({
    baseURL: env.betterAuthUrl,
    secret: env.betterAuthSecret,
    // The drizzle adapter looks up each table by the CONFIGURED modelName
    // string (e.g. "users", set below via user.modelName), not by the
    // base model identifier ("user") — these keys must match user/
    // session/account/verification/rateLimit's modelName values exactly,
    // or every DB operation fails at runtime with "The model ... was not
    // found in the schema object" (this mismatch is NOT caught by
    // constructing the Auth instance alone; only an actual DB call
    // surfaces it, which is why this fix required exercising the live
    // sign-up flow, not just typechecking the config shape).
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: {
        users: schema.users,
        sessions: schema.sessions,
        accounts: schema.accounts,
        verifications: schema.verifications,
        rate_limits: schema.rateLimits,
      },
    }),
    advanced: {
      database: { generateId: "uuid" },
      // BETTER_AUTH_URL is required to be https:// in production
      // (modules/env/server.ts's assertProductionInvariants); deriving
      // from the configured URL rather than NODE_ENV also secures a
      // non-production preview deployment that legitimately uses https.
      useSecureCookies: env.betterAuthUrl.startsWith("https://"),
    },
    rateLimit: {
      // Better Auth's own default is `enabled: isProduction` — silently
      // off outside a production NODE_ENV. Sensitive auth endpoints must
      // stay rate-limited in every environment (a dev/staging deployment
      // handling real accounts is just as brute-forceable as production,
      // and phases-15.md §60 requires this be provably enforced by
      // integration tests, which is only possible if it is never
      // silently disabled), so this is set explicitly rather than left
      // to that default.
      enabled: true,
      storage: "database",
      modelName: "rate_limits",
      customRules: rateLimitCustomRules,
      // No advanced.ipAddress.trustedProxies configured: Better Auth then
      // only trusts a single-value x-forwarded-for header, never an
      // arbitrary position in a multi-hop chain (phases-15.md §43 — "no
      // trusted-client IP derived from arbitrary untrusted forwarded-
      // header positions"). This assumes Vercel's edge is the only hop in
      // front of the deployed function (docs/DEPLOYMENT.md §10) — if a
      // CDN/WAF is ever added in front of Vercel, trustedProxies must be
      // updated to name its real egress ranges, or every request whose IP
      // can't be resolved falls back to one shared "no-trusted-ip" bucket
      // per endpoint (fails closed to a coarser limit, never bypasses
      // rate limiting outright).
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: RESET_PASSWORD_TOKEN_EXPIRES_IN_SECONDS,
      sendResetPassword: async ({ user, url, token }) => {
        await sendEmail({
          template: "reset-password",
          to: user.email,
          url,
          token,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      expiresIn: EMAIL_VERIFICATION_EXPIRES_IN_SECONDS,
      sendVerificationEmail: async ({ user, url, token }) => {
        await sendEmail({
          template: "verify-email",
          to: user.email,
          url,
          token,
        });
      },
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
      deleteUser: {
        enabled: true,
        deleteTokenExpiresIn: DELETE_ACCOUNT_TOKEN_EXPIRES_IN_SECONDS,
        sendDeleteAccountVerification: async ({ user, url, token }) => {
          await sendEmail({
            template: "delete-account",
            to: user.email,
            url,
            token,
          });
        },
      },
    },
    session: {
      modelName: "sessions",
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
    },
    account: { modelName: "accounts" },
    verification: { modelName: "verifications" },
  });
}

/**
 * The shared Better Auth instance. Lazy: constructed on first call only.
 * Throws `AuthDisabledError` — without constructing anything, even if a
 * prior call already cached an instance — whenever `AUTH_ENABLED=false`,
 * so every current and future caller inherits the kill-switch.
 */
export function getAuth(): Auth {
  if (!getServerEnv().authEnabled) {
    throw new AuthDisabledError();
  }
  if (!cachedAuth) {
    cachedAuth = createAuth();
  }
  return cachedAuth;
}
