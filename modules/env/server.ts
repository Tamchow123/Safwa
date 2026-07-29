/**
 * Server environment validation (Phase 15). Strict, fail-closed Zod parsing
 * of every server-only variable the auth/db/email stack depends on. Never
 * imported by client code — enforced by the `server-only` marker below, so a
 * client-component import fails the build instead of leaking secrets.
 *
 * Validation is LAZY and memoised (`getServerEnv()`), not run at module load:
 * pages that never touch the DB/auth/email stack must never pay for or fail
 * on server-env validation merely by being part of the same bundle graph.
 */
import "server-only";
import { z } from "zod";

import {
  parseSignupAllowlist,
  type SignupAllowlist,
} from "@/modules/auth/signup-allowlist";

export type NodeEnvironment = "development" | "test" | "production";
export type EmailTransportKind = "console-file" | "resend";

function booleanFlag(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === "") {
      return defaultValue;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true") return true;
      if (normalized === "false") return false;
    }
    return value;
  }, z.boolean());
}

const rawServerEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine(
      (value) =>
        value.startsWith("postgres://") || value.startsWith("postgresql://"),
      { message: "DATABASE_URL must be a postgres:// or postgresql:// URL" },
    ),
  BETTER_AUTH_SECRET: z.string().min(1, "BETTER_AUTH_SECRET is required"),
  BETTER_AUTH_URL: z.string().url("BETTER_AUTH_URL must be a valid URL"),
  NEXT_PUBLIC_APP_URL: z
    .string()
    .url("NEXT_PUBLIC_APP_URL must be a valid URL"),
  AUTH_ENABLED: booleanFlag(true),
  // Online-sync feature flag / rollback kill-switch (Phase 16). When false the
  // sync endpoints report a safe "unavailable" state and signed-in users
  // continue local-only study; auth and guests are unaffected. Requires
  // AUTH_ENABLED (sync is meaningless without an authenticated account).
  SYNC_ENABLED: booleanFlag(true),
  EMAIL_TRANSPORT: z.enum(["console-file", "resend"]).default("console-file"),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  EMAIL_OUTBOX_DIR: z.string().default(".local/email-outbox"),
  CONTENT_SERVER_DIR: z.string().default("content-server"),
  ALLOW_DEV_EMAIL_TRANSPORT_IN_PRODUCTION: booleanFlag(false),
  // Applied uniformly to every sensitive auth endpoint's rate-limit
  // customRule (sign-up/sign-in/send-verification-email/
  // request-password-reset/reset-password/delete-user). Overridable so
  // integration tests can configure a low, safe threshold that triggers
  // the limit quickly and deterministically instead of waiting out a
  // production-sized window.
  AUTH_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  // The DEFAULT bucket Better Auth applies to every OTHER endpoint
  // (get-session, sign-out, list-sessions, ...) — high-frequency,
  // read-mostly, not brute-forceable, so it needs a much more generous
  // limit than the sensitive customRules above. Defaults match Better
  // Auth's own built-in default (window: 10, max: 100 — see
  // node_modules/better-auth/dist/context/create-context.mjs) exactly, so
  // leaving these unset changes nothing; only the Phase 15 E2E suite
  // overrides them (its main server's heavy parallel page-load traffic —
  // every page mounts a session check — would otherwise trip Better
  // Auth's own default under normal test concurrency).
  AUTH_RATE_LIMIT_DEFAULT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(10),
  AUTH_RATE_LIMIT_DEFAULT_MAX: z.coerce.number().int().positive().default(100),
  // Who may create an account (Phase 18). Comma-separated addresses; unset
  // means sign-up is open, which production refuses below. Parsed here rather
  // than at the auth layer so a malformed list is a start-up failure with the
  // rest of the environment, not a surprise on the first sign-up attempt.
  SIGNUP_ALLOWED_EMAILS: z
    .string()
    .optional()
    .transform((raw, ctx): SignupAllowlist => {
      try {
        return parseSignupAllowlist(raw);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : "is invalid",
        });
        return z.NEVER;
      }
    }),
});

export type ServerEnv = {
  nodeEnv: NodeEnvironment;
  databaseUrl: string;
  betterAuthSecret: string;
  betterAuthUrl: string;
  appUrl: string;
  authEnabled: boolean;
  syncEnabled: boolean;
  emailTransport: EmailTransportKind;
  resendApiKey: string | undefined;
  emailFrom: string | undefined;
  emailOutboxDir: string;
  contentServerDir: string;
  authRateLimitWindowSeconds: number;
  authRateLimitMax: number;
  authRateLimitDefaultWindowSeconds: number;
  authRateLimitDefaultMax: number;
  /** Addresses permitted to register, or null when sign-up is open. */
  signupAllowedEmails: SignupAllowlist;
};

const MIN_PRODUCTION_SECRET_LENGTH = 32;

/**
 * Production bounds on the four rate-limit tuning variables (Phase 18).
 *
 * `docs/DEPLOYMENT.md` §2 has warned since Phase 15 that these are validated
 * only for positivity, and that copying an E2E- or CI-tuned `.env` into
 * production would "silently and drastically weaken rate limiting with no
 * validation error to catch it at deploy time". `e2e/helpers/e2e-server-env.ts`
 * really does set `AUTH_RATE_LIMIT_DEFAULT_MAX=100000` and
 * `AUTH_RATE_LIMIT_MAX=1000`; the bounds below make both structurally
 * unreachable in production rather than merely discouraged in prose.
 *
 * The two MAX ceilings are the security-relevant ones. The window bounds are a
 * pair of sanity limits, and it is worth being precise about which risk each
 * one addresses, because they are not the same risk:
 *  - the FLOOR is security: a one-second window makes any max meaningless,
 *    because the bucket empties faster than an attacker can be slowed down.
 *  - the CEILING is availability: an hour-long window means one fat-fingered
 *    burst locks the instance's only learner out until it expires.
 */
const PRODUCTION_RATE_LIMIT_BOUNDS = {
  /** Sensitive endpoints (sign-in, sign-up, reset, delete). Default is 5. */
  AUTH_RATE_LIMIT_MAX: { min: 1, max: 20 },
  AUTH_RATE_LIMIT_WINDOW_SECONDS: { min: 30, max: 3600 },
  /**
   * The default bucket covers get-session and friends — read-mostly, hit on
   * every page mount, not brute-forceable — so it legitimately needs far more
   * headroom than the sensitive rules. Better Auth's own default is 100/10s;
   * 1000 leaves room for a busy real session while refusing the E2E 100000.
   */
  AUTH_RATE_LIMIT_DEFAULT_MAX: { min: 1, max: 1000 },
  AUTH_RATE_LIMIT_DEFAULT_WINDOW_SECONDS: { min: 5, max: 3600 },
} as const;

function assertProductionInvariants(
  raw: z.infer<typeof rawServerEnvSchema>,
): void {
  if (raw.NODE_ENV !== "production") return;

  const problems: string[] = [];

  if (raw.BETTER_AUTH_SECRET.length < MIN_PRODUCTION_SECRET_LENGTH) {
    problems.push(
      `BETTER_AUTH_SECRET must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production`,
    );
  }
  if (!raw.BETTER_AUTH_URL.startsWith("https://")) {
    problems.push("BETTER_AUTH_URL must use https:// in production");
  }
  if (!raw.NEXT_PUBLIC_APP_URL.startsWith("https://")) {
    problems.push("NEXT_PUBLIC_APP_URL must use https:// in production");
  }
  if (
    raw.EMAIL_TRANSPORT === "console-file" &&
    !raw.ALLOW_DEV_EMAIL_TRANSPORT_IN_PRODUCTION
  ) {
    problems.push(
      "EMAIL_TRANSPORT=console-file is rejected in production unless ALLOW_DEV_EMAIL_TRANSPORT_IN_PRODUCTION=true is explicitly set (preview-only escape hatch)",
    );
  }
  if (raw.EMAIL_TRANSPORT === "resend") {
    if (!raw.RESEND_API_KEY) {
      problems.push("RESEND_API_KEY is required when EMAIL_TRANSPORT=resend");
    }
    if (!raw.EMAIL_FROM) {
      problems.push("EMAIL_FROM is required when EMAIL_TRANSPORT=resend");
    }
  }
  // Online sync is authenticated-only: a signed-in account is derived from the
  // server session on every sync endpoint. Enabling sync without auth would be
  // a broken configuration (every sync request would 401), so reject it rather
  // than ship a silently non-functional feature.
  if (raw.SYNC_ENABLED && !raw.AUTH_ENABLED) {
    problems.push("SYNC_ENABLED=true requires AUTH_ENABLED=true");
  }
  // Fail closed on sign-up. Safwa is a personal instance whose production URL
  // is reachable by anyone who finds it, so an unset allowlist means "anyone
  // may create an account here", which is never what this deployment wants.
  // Required regardless of AUTH_ENABLED: the kill-switch is a temporary
  // rollback position, and flipping it back on must not be the moment sign-up
  // silently opens.
  if (raw.SIGNUP_ALLOWED_EMAILS === null) {
    problems.push(
      "SIGNUP_ALLOWED_EMAILS must list at least one address in production (sign-up fails closed)",
    );
  }
  for (const [name, bound] of Object.entries(PRODUCTION_RATE_LIMIT_BOUNDS)) {
    const value = raw[name as keyof typeof PRODUCTION_RATE_LIMIT_BOUNDS];
    if (value < bound.min || value > bound.max) {
      problems.push(
        `${name} must be between ${bound.min} and ${bound.max} in production (got ${value})`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid production server environment configuration:\n- ${problems.join("\n- ")}`,
    );
  }
}

let cachedEnv: ServerEnv | undefined;

/**
 * Validate `process.env` on first use and memoise the result. Throws a
 * concise, secret-free error (variable names and constraints only — never
 * echoes values) the first time a caller actually needs the server
 * environment, so unrelated guest-only code paths never pay this cost.
 */
export function getServerEnv(): ServerEnv {
  if (cachedEnv) return cachedEnv;

  const parsed = rawServerEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n- ");
    throw new Error(`Invalid server environment configuration:\n- ${issues}`);
  }

  assertProductionInvariants(parsed.data);

  cachedEnv = {
    nodeEnv: parsed.data.NODE_ENV,
    databaseUrl: parsed.data.DATABASE_URL,
    betterAuthSecret: parsed.data.BETTER_AUTH_SECRET,
    betterAuthUrl: parsed.data.BETTER_AUTH_URL,
    appUrl: parsed.data.NEXT_PUBLIC_APP_URL,
    authEnabled: parsed.data.AUTH_ENABLED,
    syncEnabled: parsed.data.SYNC_ENABLED,
    emailTransport: parsed.data.EMAIL_TRANSPORT,
    resendApiKey: parsed.data.RESEND_API_KEY,
    emailFrom: parsed.data.EMAIL_FROM,
    emailOutboxDir: parsed.data.EMAIL_OUTBOX_DIR,
    contentServerDir: parsed.data.CONTENT_SERVER_DIR,
    authRateLimitWindowSeconds: parsed.data.AUTH_RATE_LIMIT_WINDOW_SECONDS,
    authRateLimitMax: parsed.data.AUTH_RATE_LIMIT_MAX,
    authRateLimitDefaultWindowSeconds:
      parsed.data.AUTH_RATE_LIMIT_DEFAULT_WINDOW_SECONDS,
    authRateLimitDefaultMax: parsed.data.AUTH_RATE_LIMIT_DEFAULT_MAX,
    signupAllowedEmails: parsed.data.SIGNUP_ALLOWED_EMAILS,
  };
  return cachedEnv;
}

/** Test-only: force re-validation on the next `getServerEnv()` call. */
export function resetServerEnvCacheForTests(): void {
  cachedEnv = undefined;
}
