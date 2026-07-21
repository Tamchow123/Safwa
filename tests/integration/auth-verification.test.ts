import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { getAuth } from "@/modules/auth/server";
import { TEST_PASSWORD as PASSWORD } from "@/tests/integration/helpers/auth-session";
import {
  extractTokenFromMessage,
  latestOutboxMessage,
} from "@/tests/integration/helpers/email-outbox";

/**
 * Email-verification integration suite (phases-15.md §60): valid/invalid/
 * expired/reuse token handling, and that a verified account can sign in.
 */
describe("auth: email verification", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a valid token verifies the account, and reusing it afterward is a safe no-op", async () => {
    const email = `verify.valid.${randomUUID()}@example.test`;
    await getAuth().api.signUpEmail({
      body: { name: "Verify Me", email, password: PASSWORD },
    });
    const message = await latestOutboxMessage(email, "verify-email");
    if (!message) throw new Error("expected a verify-email message");
    const token = extractTokenFromMessage(message);

    const result = await getAuth().api.verifyEmail({ query: { token } });
    if (!result) throw new Error("expected verifyEmail to return a result");
    expect(result.status).toBe(true);

    const [row] = await getDb()
      .select()
      .from(users)
      .where(eq(users.email, email));
    expect(row?.emailVerified).toBe(true);

    // Reusing an already-consumed token is a safe no-op (Better Auth's
    // own idempotent design — see verify-email-status.tsx's "already
    // verified" handling): it neither errors nor re-identifies a user,
    // since the one-time verification value was already consumed.
    const reuse = await getAuth().api.verifyEmail({ query: { token } });
    if (!reuse) throw new Error("expected verifyEmail to return a result");
    // The installed better-auth version's declared return type omits `user`
    // (StrictEndpoint<..., void | { status: boolean }>) even though the
    // already-verified branch of its own implementation
    // (api/routes/email-verification.mjs) genuinely returns
    // `{ status: true, user: null }` at runtime — a type-declaration gap,
    // not a reason to skip asserting the real shape.
    expect((reuse as { status: boolean; user: unknown }).user).toBeNull();
  });

  it("rejects an invalid token without verifying anything", async () => {
    await expect(
      getAuth().api.verifyEmail({
        query: { token: `not-a-real-token-${randomUUID()}` },
      }),
    ).rejects.toThrow();
  });

  it("rejects a token once its expiry has passed", async () => {
    const email = `verify.expired.${randomUUID()}@example.test`;
    await getAuth().api.signUpEmail({
      body: { name: "Expiry Test", email, password: PASSWORD },
    });
    const message = await latestOutboxMessage(email, "verify-email");
    if (!message) throw new Error("expected a verify-email message");
    const token = extractTokenFromMessage(message);

    // The token is a self-contained signed JWT whose `exp` claim is
    // checked against wall-clock time at verify time (not a DB row this
    // suite could edit directly) — advancing the fake system clock past
    // the configured 1-hour expiry is the only way to exercise this
    // without actually waiting an hour in real time.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60 * 60 * 1000 + 5_000);

    await expect(
      getAuth().api.verifyEmail({ query: { token } }),
    ).rejects.toThrow();

    vi.useRealTimers();
    const [row] = await getDb()
      .select()
      .from(users)
      .where(eq(users.email, email));
    expect(row?.emailVerified).toBe(false);
  });

  it("a verified account can then sign in and receive a real session", async () => {
    const email = `verify.thensignin.${randomUUID()}@example.test`;
    await getAuth().api.signUpEmail({
      body: { name: "Verify Then Signin", email, password: PASSWORD },
    });
    const message = await latestOutboxMessage(email, "verify-email");
    if (!message) throw new Error("expected a verify-email message");
    const token = extractTokenFromMessage(message);
    await getAuth().api.verifyEmail({ query: { token } });

    const result = await getAuth().api.signInEmail({
      body: { email, password: PASSWORD },
    });

    expect(result.token).not.toBeNull();
    expect(result.user.emailVerified).toBe(true);
  });
});
