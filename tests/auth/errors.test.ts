import { BASE_ERROR_CODES } from "better-auth";
import { describe, expect, it } from "vitest";
import {
  ERROR_CODE_MESSAGES,
  toLearnerSafeMessage,
} from "@/modules/auth/errors";

describe("toLearnerSafeMessage", () => {
  it("maps INVALID_EMAIL_OR_PASSWORD to a generic credentials message", () => {
    expect(toLearnerSafeMessage({ code: "INVALID_EMAIL_OR_PASSWORD" })).toBe(
      "Incorrect email or password.",
    );
  });

  it("maps EMAIL_NOT_VERIFIED to a clear actionable message", () => {
    expect(toLearnerSafeMessage({ code: "EMAIL_NOT_VERIFIED" })).toBe(
      "Verify your email address before signing in.",
    );
  });

  it("maps USER_ALREADY_EXISTS to an account-exists message", () => {
    expect(toLearnerSafeMessage({ code: "USER_ALREADY_EXISTS" })).toBe(
      "An account with that email already exists.",
    );
  });

  it("maps TOKEN_EXPIRED to a request-a-new-link message", () => {
    expect(toLearnerSafeMessage({ code: "TOKEN_EXPIRED" })).toBe(
      "This link has expired. Request a new one.",
    );
  });

  it("maps a 429 status to a rate-limit message regardless of code", () => {
    expect(toLearnerSafeMessage({ status: 429 })).toBe(
      "Too many attempts. Please wait a moment and try again.",
    );
    expect(
      toLearnerSafeMessage({ status: 429, code: "INVALID_EMAIL_OR_PASSWORD" }),
    ).toBe("Too many attempts. Please wait a moment and try again.");
  });

  it("falls back to a generic message for an unrecognised code", () => {
    expect(toLearnerSafeMessage({ code: "SOME_FUTURE_CODE" })).toBe(
      "Something went wrong. Please try again.",
    );
  });

  it("falls back to a generic message for null, undefined, or a non-object", () => {
    expect(toLearnerSafeMessage(null)).toBe(
      "Something went wrong. Please try again.",
    );
    expect(toLearnerSafeMessage(undefined)).toBe(
      "Something went wrong. Please try again.",
    );
  });

  it("reads a code nested under error.error.code (BetterFetchError shape)", () => {
    expect(toLearnerSafeMessage({ error: { code: "TOKEN_EXPIRED" } })).toBe(
      "This link has expired. Request a new one.",
    );
  });

  it("never includes the raw error's message, even when it contains sensitive-looking content", () => {
    const poisoned = {
      code: "INVALID_EMAIL_OR_PASSWORD",
      message:
        'duplicate key value violates unique constraint "users_email_lower_unique_idx" — token=abc123 at Object.<anonymous> (/app/db/client.ts:42:10)',
    };
    const result = toLearnerSafeMessage(poisoned);
    expect(result).toBe("Incorrect email or password.");
    expect(result).not.toContain("constraint");
    expect(result).not.toContain("token=abc123");
    expect(result).not.toContain("db/client.ts");
  });

  it("never includes a raw stack trace embedded in the error object", () => {
    const poisoned = {
      code: "SOME_FUTURE_CODE",
      stack: "Error: boom\n    at Object.<anonymous> (/app/secret-path.ts:1:1)",
    };
    const result = toLearnerSafeMessage(poisoned);
    expect(result).not.toContain("secret-path.ts");
    expect(result).not.toContain("at Object.<anonymous>");
  });

  it("every mapped key is still a real Better Auth error code (catches drift on a library upgrade)", () => {
    // Runtime cross-check against the actually-installed better-auth
    // package, independent of the compile-time `satisfies` check in
    // modules/auth/errors.ts — either one failing means a Better Auth
    // upgrade renamed/removed a code this mapping still relies on.
    for (const key of Object.keys(ERROR_CODE_MESSAGES)) {
      expect(BASE_ERROR_CODES).toHaveProperty(key);
    }
  });
});
