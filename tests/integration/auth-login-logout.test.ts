import { randomUUID } from "node:crypto";
import { parseSetCookieHeader } from "better-auth/cookies";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { sessions, users } from "@/db/schema";
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

/**
 * The session cookie itself (Phase 18.1).
 *
 * The suite above proves the SESSION is invalidated — `getSession` returns
 * null and the row is gone. That is the authoritative half, and it is the half
 * that matters if a token is stolen. It says nothing about the COOKIE, which
 * is the half that matters on a shared device: a browser still holding a
 * `better-auth.session_token` after sign-out will keep presenting it, and the
 * next person to use that machine inherits whatever a future bug decides to do
 * with an expired-but-present credential.
 *
 * These assertions are also where the app's CSRF posture is pinned. Nothing in
 * this repository sets `sameSite` — it is Better Auth's default, and defaults
 * are exactly the kind of security property that changes in a minor upgrade
 * without anyone noticing. `SameSite=Lax` is what makes a cross-site POST to
 * `/api/sync/push` arrive with no cookie at all, which is the reason this app
 * needs no CSRF token. If a dependency bump ever changed it to `None`, that
 * defence would vanish silently; this fails instead.
 */
describe("the session cookie", () => {
  it("is HttpOnly, SameSite=Lax and scoped to the whole origin", async () => {
    const email = `cookie.attrs.${randomUUID()}@example.test`;
    await createVerifiedUser(email);

    const response = await getAuth().api.signInEmail({
      body: { email, password: PASSWORD },
      asResponse: true,
    });
    const cookie = parseSetCookieHeader(
      response.headers.get("set-cookie") ?? "",
    ).get("better-auth.session_token");

    expect(cookie).toBeDefined();
    // Unreadable to script, so an XSS cannot lift the session token.
    expect(cookie?.httponly).toBe(true);
    // The CSRF defence for every route in this app that is not Better Auth's.
    expect(String(cookie?.samesite).toLowerCase()).toBe("lax");
    expect(cookie?.path).toBe("/");
  });

  it("is expired by sign-out, not merely orphaned server-side", async () => {
    const email = `cookie.cleared.${randomUUID()}@example.test`;
    await createVerifiedUser(email);
    const headers = await signInAndGetSessionHeaders(email, PASSWORD);

    const response = await getAuth().api.signOut({
      headers,
      asResponse: true,
    });
    const cookie = parseSetCookieHeader(
      response.headers.get("set-cookie") ?? "",
    ).get("better-auth.session_token");

    expect(
      cookie,
      "sign-out must send a Set-Cookie for the session token, or the browser keeps the old one",
    ).toBeDefined();
    // Today Better Auth sends `value=""; Max-Age=0`, which is two independent
    // ways of saying the same thing. The check accepts any of the three
    // correct spellings rather than pinning that exact pair, because a switch
    // to a past `Expires` would be equally correct and should not fail here.
    // What must NOT pass is a response that leaves a live cookie in place.
    const maxAge = Number(cookie?.["max-age"] ?? NaN);
    const expires = cookie?.expires;
    const expired =
      maxAge === 0 ||
      (expires instanceof Date && expires.getTime() <= Date.now()) ||
      cookie?.value === "";
    expect(
      expired,
      `expected an expired cookie, got ${JSON.stringify(cookie)}`,
    ).toBe(true);
  });

  it("leaves no session row behind for the token to match", async () => {
    // The server-side half, asserted against the table rather than inferred
    // from getSession returning null — a lookup can return null for reasons
    // other than the row being gone.
    const email = `cookie.rows.${randomUUID()}@example.test`;
    await createVerifiedUser(email);
    const headers = await signInAndGetSessionHeaders(email, PASSWORD);

    const [user] = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));
    expect(user).toBeDefined();
    const userId = user?.id ?? "";

    const before = await getDb()
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, userId));
    expect(before.length).toBeGreaterThan(0);

    await getAuth().api.signOut({ headers });

    const after = await getDb()
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, userId));
    expect(after).toHaveLength(0);
  });
});
