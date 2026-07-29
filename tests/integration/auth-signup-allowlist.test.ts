import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { getAuth } from "@/modules/auth/server";
import { SIGNUP_NOT_ALLOWED_CODE } from "@/modules/auth/signup-allowlist";
import { resetServerEnvCacheForTests } from "@/modules/env/server";
import { TEST_PASSWORD as PASSWORD } from "@/tests/integration/helpers/auth-session";

/**
 * Sign-up allowlist integration suite (phases-18.md §5 slice 6), against the
 * real Better Auth instance and the disposable Postgres database.
 *
 * The allowlist is enforced by a `hooks.before` middleware. Better Auth runs
 * that middleware inside `dispatchAuthEndpoint`, which BOTH the HTTP router and
 * a direct `auth.api.*` call go through — so no server-side caller can route
 * around it, and this suite can exercise it either way. It does both: the
 * direct-call cases prove the rule, and the last case goes through the real
 * `getAuth().handler(request)` to prove a browser sees a clean 403 that says
 * nothing about who IS allowed.
 *
 * Like tests/integration/auth-rate-limit.test.ts, this file sets its
 * environment BEFORE the first getAuth() call and restores it in afterAll:
 * Vitest's per-file module-registry isolation resets `cachedAuth`/`cachedEnv`
 * between files, but `process.env` is a genuinely process-global object shared
 * by every file in this serial run.
 */
const ALLOWED_EMAIL = "allowed.owner@example.test";
const SECOND_ALLOWED_EMAIL = "allowed.second@example.test";
/** Listed in lower case, registered in mixed case — see the case test below. */
const MIXED_CASE_ALLOWED_EMAIL = "allowed.mixed@example.test";
const ORIGINAL_ALLOWLIST = process.env.SIGNUP_ALLOWED_EMAILS;
const BASE_URL = "http://localhost:3000";

beforeAll(() => {
  process.env.SIGNUP_ALLOWED_EMAILS = [
    ALLOWED_EMAIL,
    SECOND_ALLOWED_EMAIL,
    MIXED_CASE_ALLOWED_EMAIL,
  ].join(", ");
  resetServerEnvCacheForTests();
});

afterAll(() => {
  if (ORIGINAL_ALLOWLIST === undefined) {
    delete process.env.SIGNUP_ALLOWED_EMAILS;
  } else {
    process.env.SIGNUP_ALLOWED_EMAILS = ORIGINAL_ALLOWLIST;
  }
  resetServerEnvCacheForTests();
});

/** The numeric HTTP status Better Auth's thrown `APIError` carries. */
function statusCodeOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { statusCode } = error as { statusCode?: unknown };
  return typeof statusCode === "number" ? statusCode : undefined;
}

/** Run a sign-up expected to fail, and hand back the thrown error. */
async function signUpAndCatch(email: string): Promise<unknown> {
  try {
    await getAuth().api.signUpEmail({
      body: { name: "Refused", email, password: PASSWORD },
    });
  } catch (error) {
    return error;
  }
  expect.unreachable(`sign-up unexpectedly succeeded for ${email}`);
}

async function userRowsFor(email: string) {
  return getDb().select().from(users).where(eq(users.email, email));
}

describe("auth: sign-up allowlist", () => {
  it("lets an allowlisted address register", async () => {
    const result = await getAuth().api.signUpEmail({
      body: { name: "Allowed Owner", email: ALLOWED_EMAIL, password: PASSWORD },
    });

    expect(result.user.email).toBe(ALLOWED_EMAIL);
    expect(await userRowsFor(ALLOWED_EMAIL)).toHaveLength(1);
  });

  it("lets a second allowlisted address register (the list is not just its first entry)", async () => {
    const result = await getAuth().api.signUpEmail({
      body: {
        name: "Allowed Second",
        email: SECOND_ALLOWED_EMAIL,
        password: PASSWORD,
      },
    });

    expect(result.user.email).toBe(SECOND_ALLOWED_EMAIL);
  });

  it("matches the allowlist case-insensitively", async () => {
    // The accounts table's uniqueness is already case-insensitive, so a
    // case-SENSITIVE allowlist could only ever produce the contradiction
    // "your address is on the list, and also you may not register".
    const submitted = MIXED_CASE_ALLOWED_EMAIL.toUpperCase();

    const result = await getAuth().api.signUpEmail({
      body: { name: "Allowed Mixed", email: submitted, password: PASSWORD },
    });

    expect(result.user.id).toBeDefined();
  });

  it("refuses an address that is not on the list, and writes nothing", async () => {
    const email = `stranger.${randomUUID()}@example.test`;

    const error = await signUpAndCatch(email);

    expect(statusCodeOf(error)).toBe(403);
    expect(await userRowsFor(email)).toHaveLength(0);
  });

  it("refuses a plus-address alias of an allowlisted address", async () => {
    // Deliberate: alias rules belong to someone else's mail server, and
    // guessing them in the permissive direction is the failure this closes.
    const [local, domain] = ALLOWED_EMAIL.split("@");
    const alias = `${local}+alias@${domain}`;

    const error = await signUpAndCatch(alias);

    expect(statusCodeOf(error)).toBe(403);
    expect(await userRowsFor(alias)).toHaveLength(0);
  });

  it("refuses an address that merely contains an allowlisted one", async () => {
    const error = await signUpAndCatch(`x${ALLOWED_EMAIL}`);

    expect(statusCodeOf(error)).toBe(403);
  });

  it("gates registration only — sign-in is untouched", async () => {
    // The hook matches one path. A learner whose address is later removed from
    // the list must keep the account they already have, and an ordinary failed
    // sign-in must fail for its own reason rather than this one.
    const email = `stranger.signin.${randomUUID()}@example.test`;

    let error: unknown;
    try {
      await getAuth().api.signInEmail({ body: { email, password: PASSWORD } });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeDefined();
    expect(statusCodeOf(error)).not.toBe(403);
  });

  it("returns an identical 403 through the real HTTP handler, leaking no list", async () => {
    async function signUpOverHttp(email: string): Promise<Response> {
      return getAuth().handler(
        new Request(`${BASE_URL}/api/auth/sign-up/email`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "HTTP", email, password: PASSWORD }),
        }),
      );
    }

    const stranger = await signUpOverHttp(
      `http.stranger.${randomUUID()}@example.test`,
    );
    expect(stranger.status).toBe(403);
    const strangerBody = await stranger.text();
    expect(strangerBody).not.toContain(ALLOWED_EMAIL);
    expect(strangerBody).not.toContain(SECOND_ALLOWED_EMAIL);
    // The code reaches the wire, which is what lets the register form say
    // "not accepting new accounts" instead of "something went wrong" — the
    // client mapping itself is unit-tested in tests/auth/errors.test.ts.
    expect(JSON.parse(strangerBody)).toMatchObject({
      code: SIGNUP_NOT_ALLOWED_CODE,
    });

    // A near-miss of a real allowlist entry gets byte-identical treatment, so
    // the response cannot be used to probe the list for close matches.
    const nearMiss = await signUpOverHttp(`${ALLOWED_EMAIL}x`);
    expect(nearMiss.status).toBe(403);
    expect(await nearMiss.text()).toBe(strangerBody);
  });
});
