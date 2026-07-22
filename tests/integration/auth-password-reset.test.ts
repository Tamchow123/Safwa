import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAuth } from "@/modules/auth/server";
import {
  createVerifiedUser,
  signInAndGetSessionHeaders,
  TEST_PASSWORD as PASSWORD,
} from "@/tests/integration/helpers/auth-session";
import {
  extractTokenFromMessage,
  waitForOutboxMessage,
} from "@/tests/integration/helpers/email-outbox";

const NEW_PASSWORD = "brand-new-password-1";

/**
 * Password-reset integration suite (phases-15.md §60).
 */
describe("auth: password reset", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes a reset email when requested", async () => {
    const email = `reset.email.${randomUUID()}@example.test`;
    await createVerifiedUser(email);

    await getAuth().api.requestPasswordReset({ body: { email } });

    const message = await waitForOutboxMessage(email, "reset-password");
    expect(message).not.toBeNull();
  });

  it("a valid reset changes the password: old password fails, new password works, and other sessions are revoked", async () => {
    const email = `reset.valid.${randomUUID()}@example.test`;
    await createVerifiedUser(email);
    const existingSessionHeaders = await signInAndGetSessionHeaders(
      email,
      PASSWORD,
    );
    expect(
      (await getAuth().api.getSession({ headers: existingSessionHeaders }))
        ?.user.email,
    ).toBe(email);

    await getAuth().api.requestPasswordReset({ body: { email } });
    const message = await waitForOutboxMessage(email, "reset-password");
    if (!message) throw new Error("expected a reset-password message");
    const token = extractTokenFromMessage(message);

    await getAuth().api.resetPassword({
      body: { newPassword: NEW_PASSWORD, token },
    });

    await expect(
      getAuth().api.signInEmail({ body: { email, password: PASSWORD } }),
    ).rejects.toThrow();
    const signedInWithNew = await getAuth().api.signInEmail({
      body: { email, password: NEW_PASSWORD },
    });
    expect(signedInWithNew.token).not.toBeNull();

    // revokeSessionsOnPasswordReset: true (modules/auth/server.ts) — the
    // session that existed BEFORE the reset must no longer be valid.
    expect(
      await getAuth().api.getSession({ headers: existingSessionHeaders }),
    ).toBeNull();
  });

  it("rejects an invalid reset token without changing the password", async () => {
    const email = `reset.invalid.${randomUUID()}@example.test`;
    await createVerifiedUser(email);

    await expect(
      getAuth().api.resetPassword({
        body: {
          newPassword: NEW_PASSWORD,
          token: `not-a-real-token-${randomUUID()}`,
        },
      }),
    ).rejects.toThrow();

    const stillWorks = await getAuth().api.signInEmail({
      body: { email, password: PASSWORD },
    });
    expect(stillWorks.token).not.toBeNull();
  });

  it("rejects a reset token once its expiry has passed, without changing the password", async () => {
    const email = `reset.expired.${randomUUID()}@example.test`;
    await createVerifiedUser(email);

    await getAuth().api.requestPasswordReset({ body: { email } });
    const message = await waitForOutboxMessage(email, "reset-password");
    if (!message) throw new Error("expected a reset-password message");
    const token = extractTokenFromMessage(message);

    // Reset-password tokens share the same 1-hour expiry as email
    // verification (RESET_PASSWORD_TOKEN_EXPIRES_IN_SECONDS,
    // modules/auth/server.ts) — advancing the fake system clock past it is
    // the only way to exercise this without waiting an hour in real time.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60 * 60 * 1000 + 5_000);

    await expect(
      getAuth().api.resetPassword({
        body: { newPassword: NEW_PASSWORD, token },
      }),
    ).rejects.toThrow();

    vi.useRealTimers();
    const stillWorks = await getAuth().api.signInEmail({
      body: { email, password: PASSWORD },
    });
    expect(stillWorks.token).not.toBeNull();
  });
});
