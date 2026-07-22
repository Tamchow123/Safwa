import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getAuth } from "@/modules/auth/server";
import {
  createVerifiedUser,
  signInAndGetSessionHeaders,
  TEST_PASSWORD as PASSWORD,
} from "@/tests/integration/helpers/auth-session";

/**
 * Login/session/logout integration suite (phases-15.md §60).
 */
describe("auth: login, session, logout", () => {
  it("signs in a verified account with the correct password and returns a real session", async () => {
    const email = `login.correct.${randomUUID()}@example.test`;
    await createVerifiedUser(email);

    const result = await getAuth().api.signInEmail({
      body: { email, password: PASSWORD },
    });

    expect(result.token).not.toBeNull();
    expect(result.user.email).toBe(email);
  });

  it("rejects a wrong password", async () => {
    const email = `login.wrong.${randomUUID()}@example.test`;
    await createVerifiedUser(email);

    await expect(
      getAuth().api.signInEmail({
        body: { email, password: "totally-wrong-password" },
      }),
    ).rejects.toThrow();
  });

  it("rejects sign-in for a correct password on an unverified account", async () => {
    const email = `login.unverified.${randomUUID()}@example.test`;
    await getAuth().api.signUpEmail({
      body: { name: "Unverified", email, password: PASSWORD },
    });

    await expect(
      getAuth().api.signInEmail({ body: { email, password: PASSWORD } }),
    ).rejects.toThrow();
  });

  it("retrieves the session for a signed-in cookie", async () => {
    const email = `login.session.${randomUUID()}@example.test`;
    await createVerifiedUser(email);
    const headers = await signInAndGetSessionHeaders(email, PASSWORD);

    const session = await getAuth().api.getSession({ headers });

    expect(session?.user.email).toBe(email);
  });

  it("invalidates the session on logout", async () => {
    const email = `login.logout.${randomUUID()}@example.test`;
    await createVerifiedUser(email);
    const headers = await signInAndGetSessionHeaders(email, PASSWORD);
    expect((await getAuth().api.getSession({ headers }))?.user.email).toBe(
      email,
    );

    await getAuth().api.signOut({ headers });

    const sessionAfterLogout = await getAuth().api.getSession({ headers });
    expect(sessionAfterLogout).toBeNull();
  });
});
