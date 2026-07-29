import { BASE_ERROR_CODES } from "better-auth";
import { describe, expect, it } from "vitest";
import {
  ERROR_CODE_MESSAGES,
  toLearnerSafeMessage,
} from "@/modules/auth/errors";
import { SIGNUP_NOT_ALLOWED_CODE } from "@/modules/auth/signup-allowlist";

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

  describe("the app's own sign-up refusal (Phase 18)", () => {
    it("maps the allowlist refusal to a message that does not invite a retry", () => {
      // The generic fallback would tell someone who can never register to
      // "try again" — the one thing that is guaranteed not to work.
      expect(toLearnerSafeMessage({ code: SIGNUP_NOT_ALLOWED_CODE })).toBe(
        "This app is not accepting new accounts.",
      );
    });

    it("maps it through the nested BetterFetchError shape too", () => {
      expect(
        toLearnerSafeMessage({
          status: 403,
          error: { code: SIGNUP_NOT_ALLOWED_CODE },
        }),
      ).toBe("This app is not accepting new accounts.");
    });

    it("says nothing about who is allowed", () => {
      // Assigned first, as the "poisoned" cases above are: a bare object
      // literal would trip TypeScript's excess-property check, and the point
      // here is precisely that extra fields on the wire are ignored.
      const withExtras = {
        code: SIGNUP_NOT_ALLOWED_CODE,
        message: "Sign-up is not open on this instance.",
        allowed: ["owner@example.test"],
      };
      const message = toLearnerSafeMessage(withExtras);
      expect(message).not.toContain("@");
      expect(message).not.toContain("owner");
    });

    it("is not one of Better Auth's own codes", () => {
      // If a future Better Auth version ever defines this name, the two maps
      // would silently disagree about which message wins.
      expect(BASE_ERROR_CODES).not.toHaveProperty(SIGNUP_NOT_ALLOWED_CODE);
      expect(ERROR_CODE_MESSAGES).not.toHaveProperty(SIGNUP_NOT_ALLOWED_CODE);
    });
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
