import { parseSetCookieHeader } from "better-auth/cookies";
import { getAuth } from "@/modules/auth/server";
import {
  extractTokenFromMessage,
  latestOutboxMessage,
} from "@/tests/integration/helpers/email-outbox";

/**
 * Shared test password: every auth-*.test.ts integration file signs up
 * fixture accounts with this same value (phase-15 T19's commit-council
 * clean-code finding CLEAN-002) — one source of truth rather than each
 * file redeclaring an identical local constant.
 */
export const TEST_PASSWORD = "correct-horse-battery-staple";

/**
 * Real signed-in session headers via Better Auth's own API (not a mock),
 * mirroring the pattern better-auth's own test-instance.mjs uses
 * internally (signInWithUser). Extracted once a second integration test
 * needed it (see phase-15 T17's ARCH-001 finding) so every test that
 * needs a genuine authenticated session shares one implementation rather
 * than each reinventing cookie extraction.
 */
export async function signInAndGetSessionHeaders(
  email: string,
  password: string,
): Promise<Headers> {
  const response = await getAuth().api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const setCookie = response.headers.get("set-cookie") ?? "";
  const token = parseSetCookieHeader(setCookie).get(
    "better-auth.session_token",
  )?.value;
  if (!token) {
    throw new Error("signInAndGetSessionHeaders: no session token in response");
  }
  return new Headers({ cookie: `better-auth.session_token=${token}` });
}

/**
 * Signs up and fully verifies a fixture account (real signUpEmail +
 * verifyEmail against the real outbox), for tests whose subject is
 * something downstream of verification (login, reset, session). Extracted
 * once a second integration test file needed the identical flow (phase-15
 * T19's commit-council clean-code finding CLEAN-001).
 */
export async function createVerifiedUser(
  email: string,
  name = "Test User",
): Promise<void> {
  await getAuth().api.signUpEmail({
    body: { name, email, password: TEST_PASSWORD },
  });
  const message = await latestOutboxMessage(email, "verify-email");
  if (!message) {
    throw new Error("createVerifiedUser: expected a verify-email message");
  }
  await getAuth().api.verifyEmail({
    query: { token: extractTokenFromMessage(message) },
  });
}
