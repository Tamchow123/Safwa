/**
 * Maps Better Auth / DB errors to learner-safe messages (Phase 15,
 * phases-15.md §32). Never surfaces a raw error object, its `.message`,
 * a DB/SQL detail, a stack trace, or a verification/reset token — every
 * returned string is one of the fixed, hand-written messages below,
 * selected only by the error's `code`/HTTP status, never by echoing any
 * part of the error itself.
 */

import type { BASE_ERROR_CODES } from "better-auth";

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";
const RATE_LIMIT_MESSAGE =
  "Too many attempts. Please wait a moment and try again.";

// Keys match Better Auth's own BASE_ERROR_CODES (imported as a TYPE ONLY
// below, never at runtime, so a version bump can't change behaviour
// silently) — only the subset relevant to email/password auth,
// verification, reset and account deletion (the features this app
// enables) is mapped. Anything else falls back to GENERIC_ERROR_MESSAGE.
// `satisfies` makes an upgrade that renames/removes one of these codes a
// TYPECHECK failure (not a silently-degraded runtime fallback) —
// tests/auth/errors.test.ts also cross-checks every key against the
// actual BASE_ERROR_CODES value at test time as a second, independent
// safeguard.
export const ERROR_CODE_MESSAGES = {
  INVALID_EMAIL_OR_PASSWORD: "Incorrect email or password.",
  INVALID_EMAIL: "Enter a valid email address.",
  INVALID_PASSWORD: "Incorrect email or password.",
  CREDENTIAL_ACCOUNT_NOT_FOUND: "Incorrect email or password.",
  EMAIL_NOT_VERIFIED: "Verify your email address before signing in.",
  EMAIL_ALREADY_VERIFIED: "This email address is already verified.",
  USER_ALREADY_EXISTS: "An account with that email already exists.",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:
    "An account with that email already exists.",
  PASSWORD_TOO_SHORT: "Choose a longer password.",
  PASSWORD_TOO_LONG: "Choose a shorter password.",
  INVALID_TOKEN: "This link is invalid or has already been used.",
  TOKEN_EXPIRED: "This link has expired. Request a new one.",
  SESSION_EXPIRED: "Your session has expired. Sign in again to continue.",
  SESSION_NOT_FRESH: "Sign in again to confirm this action.",
} satisfies Partial<Record<keyof typeof BASE_ERROR_CODES, string>>;

type AuthErrorLike =
  | {
      status?: number;
      code?: unknown;
      error?: unknown;
    }
  | null
  | undefined;

function extractErrorCode(error: Record<string, unknown>): string | undefined {
  const direct = error.code;
  if (typeof direct === "string") return direct;

  const nested = error.error;
  if (nested && typeof nested === "object") {
    const nestedCode = (nested as Record<string, unknown>).code;
    if (typeof nestedCode === "string") return nestedCode;
  }
  return undefined;
}

/**
 * Maps any Better Auth client error (or `null`/`undefined`, for callers
 * that pass a result's `error` field directly) to one fixed, learner-safe
 * message. Never returns anything derived from the input's `.message`.
 */
export function toLearnerSafeMessage(error: AuthErrorLike): string {
  if (!error || typeof error !== "object") {
    return GENERIC_ERROR_MESSAGE;
  }

  const record = error as Record<string, unknown>;
  if (record.status === 429) {
    return RATE_LIMIT_MESSAGE;
  }

  const code = extractErrorCode(record);
  if (code !== undefined) {
    const mapped = (ERROR_CODE_MESSAGES as Record<string, string>)[code];
    if (mapped !== undefined) {
      return mapped;
    }
  }

  return GENERIC_ERROR_MESSAGE;
}
