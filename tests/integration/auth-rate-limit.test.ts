import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAuth } from "@/modules/auth/server";
import { resetServerEnvCacheForTests } from "@/modules/env/server";

/**
 * Rate-limiting integration suite (phases-15.md §60). Rate limiting is
 * applied by Better Auth's router at the `onRequest` stage — it is NOT
 * exercised by calling `auth.api.X({body, headers})` directly (that path
 * bypasses the router entirely), so this suite goes through the real
 * `getAuth().handler(request)` HTTP entry point with genuine `Request`
 * objects, exactly as `app/api/auth/[...all]/route.ts` does in production.
 *
 * This file sets a tight, fast rate limit BEFORE the first getAuth() call
 * so every request in this suite shares that tuned window/max. Vitest's
 * per-file module-registry isolation resets module-level singletons
 * (`cachedAuth`/`cachedEnv`) between files, but NOT `process.env` itself —
 * that is a real, process-global object shared by every file in this
 * serial run (`fileParallelism: false`). The `afterAll` below restores it
 * explicitly so this file's tuned limit can never leak into a later file
 * that happens to also exercise the real HTTP handler (phase-15 T19's
 * commit-council reliability/security findings REL-001/SEC-002).
 */
const ORIGINAL_WINDOW = process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS;
const ORIGINAL_MAX = process.env.AUTH_RATE_LIMIT_MAX;
const BASE_URL = "http://localhost:3000";

function signInRequest(): Request {
  return new Request(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "rate-limit-probe@example.test",
      password: "wrong-password-on-purpose",
    }),
  });
}

function resetRequest(): Request {
  return new Request(`${BASE_URL}/api/auth/request-password-reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "rate-limit-probe@example.test" }),
  });
}

beforeAll(() => {
  // tests/integration/setup.ts's own beforeAll (resetTestDatabase) already
  // calls getServerEnv() once, caching it before this hook runs — so a
  // plain env-var assignment here would be silently ignored without an
  // explicit cache reset forcing the next getServerEnv() call to re-read.
  process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS = "30";
  process.env.AUTH_RATE_LIMIT_MAX = "2";
  resetServerEnvCacheForTests();
});

afterAll(() => {
  if (ORIGINAL_WINDOW === undefined) {
    delete process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS;
  } else {
    process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS = ORIGINAL_WINDOW;
  }
  if (ORIGINAL_MAX === undefined) {
    delete process.env.AUTH_RATE_LIMIT_MAX;
  } else {
    process.env.AUTH_RATE_LIMIT_MAX = ORIGINAL_MAX;
  }
  resetServerEnvCacheForTests();
});

describe("auth: rate limiting", () => {
  it("returns 429 with a retry-after signal once the configured limit is reached", async () => {
    const handler = getAuth().handler;

    const first = await handler(signInRequest());
    const second = await handler(signInRequest());
    const third = await handler(signInRequest());

    expect(first.status).not.toBe(429);
    expect(second.status).not.toBe(429);
    expect(third.status).toBe(429);
    expect(
      third.headers.get("x-retry-after") ?? third.headers.get("retry-after"),
    ).not.toBeNull();
  });

  it("uses an isolated key per endpoint: exhausting one path's limit never blocks a different path", async () => {
    const handler = getAuth().handler;

    await handler(signInRequest());
    await handler(signInRequest());
    const signInBlocked = await handler(signInRequest());
    expect(signInBlocked.status).toBe(429);

    const resetResponse = await handler(resetRequest());
    expect(resetResponse.status).not.toBe(429);
  });
});
