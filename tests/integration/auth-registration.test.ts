import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { accounts, users } from "@/db/schema";
import { getAuth } from "@/modules/auth/server";
import { TEST_PASSWORD as PASSWORD } from "@/tests/integration/helpers/auth-session";
import { waitForOutboxMessage } from "@/tests/integration/helpers/email-outbox";

/**
 * Comprehensive registration integration suite (phases-15.md §60), against
 * the real Better Auth API and disposable Postgres DB.
 */
describe("auth: registration", () => {
  it("creates the account row with the documented defaults", async () => {
    const email = `register.${randomUUID()}@example.test`;

    const result = await getAuth().api.signUpEmail({
      body: { name: "New Learner", email, password: PASSWORD },
    });

    expect(result.user.email).toBe(email);
    const [row] = await getDb()
      .select()
      .from(users)
      .where(eq(users.email, email));
    expect(row?.name).toBe("New Learner");
    expect(row?.emailVerified).toBe(false);
  });

  it("stores only a hashed password, never the plaintext", async () => {
    const email = `register.hash.${randomUUID()}@example.test`;

    const result = await getAuth().api.signUpEmail({
      body: { name: "Hash Check", email, password: PASSWORD },
    });

    const [account] = await getDb()
      .select()
      .from(accounts)
      .where(eq(accounts.userId, result.user.id));
    expect(account?.password).toBeDefined();
    expect(account?.password).not.toBe(PASSWORD);
    expect(account?.password).not.toContain(PASSWORD);
  });

  it("creates a verification email and never issues a session before verification", async () => {
    const email = `register.verify.${randomUUID()}@example.test`;

    const result = await getAuth().api.signUpEmail({
      body: { name: "Pending Verify", email, password: PASSWORD },
    });

    expect(result.token).toBeNull();
    const message = await waitForOutboxMessage(email, "verify-email");
    expect(message).not.toBeNull();
  });

  it("defaults role to learner and a client-supplied role is never honoured", async () => {
    const email = `register.role.${randomUUID()}@example.test`;

    const result = await getAuth().api.signUpEmail({
      body: {
        name: "Role Test",
        email,
        password: PASSWORD,
        // Not part of the documented body shape — proves any extra field
        // a malicious client sends is simply ignored, never applied.
        role: "admin",
      } as never,
    });

    const [row] = await getDb()
      .select()
      .from(users)
      .where(eq(users.id, result.user.id));
    expect(row?.role).toBe("learner");
  });

  it("rejects a duplicate registration whose email differs only by case", async () => {
    const email = `register.dup.${randomUUID()}@example.test`;
    await getAuth().api.signUpEmail({
      body: { name: "First", email, password: PASSWORD },
    });

    const second = await getAuth().api.signUpEmail({
      body: {
        name: "Second",
        email: email.toUpperCase(),
        password: "a-different-password-1",
      },
    });

    // Better Auth's own generic-duplicate-response design under mandatory
    // verification: a synthetic user with token:null, structurally
    // identical to a genuine new signup — never a distinguishing error.
    expect(second.token).toBeNull();
    const rows = await getDb()
      .select()
      .from(users)
      .where(eq(users.email, email));
    expect(rows).toHaveLength(1);
  });
});
