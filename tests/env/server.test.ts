import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Scoped to this file only (not tests/setup.ts): Vitest resolves the
// package's default export condition (throws by design), not the
// `react-server` condition Next.js's build resolves to an empty module.
// Mocking it globally would silently defeat the real throw for every other
// test file too, removing the one unit-test-level tripwire against a
// client-reachable file accidentally importing a server-only module.
vi.mock("server-only", () => ({}));

import {
  getServerEnv,
  resetServerEnvCacheForTests,
} from "@/modules/env/server";

const BASE_ENV = {
  NODE_ENV: "development",
  DATABASE_URL: "postgres://safwa:pw@localhost:5432/safwa_dev",
  BETTER_AUTH_SECRET: "dev-secret",
  BETTER_AUTH_URL: "http://localhost:3000",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
} as const;

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  resetServerEnvCacheForTests();
});

afterEach(() => {
  process.env = originalEnv;
  resetServerEnvCacheForTests();
});

function setEnv(overrides: Record<string, string | undefined>) {
  process.env = { ...BASE_ENV } as unknown as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("getServerEnv", () => {
  it("parses a minimal valid development configuration with defaults", () => {
    setEnv({});
    const env = getServerEnv();
    expect(env.nodeEnv).toBe("development");
    expect(env.databaseUrl).toBe(BASE_ENV.DATABASE_URL);
    expect(env.authEnabled).toBe(true);
    expect(env.syncEnabled).toBe(true);
    expect(env.emailTransport).toBe("console-file");
    expect(env.emailOutboxDir).toBe(".local/email-outbox");
    expect(env.contentServerDir).toBe("content-server");
    expect(env.authRateLimitWindowSeconds).toBe(60);
    expect(env.authRateLimitMax).toBe(5);
    // Matches Better Auth's own built-in default bucket exactly (window:
    // 10, max: 100) so leaving these unset changes nothing.
    expect(env.authRateLimitDefaultWindowSeconds).toBe(10);
    expect(env.authRateLimitDefaultMax).toBe(100);
  });

  it("coerces AUTH_RATE_LIMIT_WINDOW_SECONDS/AUTH_RATE_LIMIT_MAX from strings", () => {
    setEnv({
      AUTH_RATE_LIMIT_WINDOW_SECONDS: "30",
      AUTH_RATE_LIMIT_MAX: "2",
    });
    const env = getServerEnv();
    expect(env.authRateLimitWindowSeconds).toBe(30);
    expect(env.authRateLimitMax).toBe(2);
  });

  it("coerces AUTH_RATE_LIMIT_DEFAULT_WINDOW_SECONDS/AUTH_RATE_LIMIT_DEFAULT_MAX from strings", () => {
    setEnv({
      AUTH_RATE_LIMIT_DEFAULT_WINDOW_SECONDS: "45",
      AUTH_RATE_LIMIT_DEFAULT_MAX: "9000",
    });
    const env = getServerEnv();
    expect(env.authRateLimitDefaultWindowSeconds).toBe(45);
    expect(env.authRateLimitDefaultMax).toBe(9000);
  });

  it("rejects a non-positive AUTH_RATE_LIMIT_MAX", () => {
    setEnv({ AUTH_RATE_LIMIT_MAX: "0" });
    expect(() => getServerEnv()).toThrow(/AUTH_RATE_LIMIT_MAX/);
  });

  it("rejects a non-positive AUTH_RATE_LIMIT_DEFAULT_MAX", () => {
    setEnv({ AUTH_RATE_LIMIT_DEFAULT_MAX: "0" });
    expect(() => getServerEnv()).toThrow(/AUTH_RATE_LIMIT_DEFAULT_MAX/);
  });

  it("memoises the result across calls", () => {
    setEnv({});
    const first = getServerEnv();
    process.env.DATABASE_URL = "postgres://changed/should-not-be-seen";
    const second = getServerEnv();
    expect(second).toBe(first);
    expect(second.databaseUrl).toBe(BASE_ENV.DATABASE_URL);
  });

  it("re-validates after resetServerEnvCacheForTests", () => {
    setEnv({});
    getServerEnv();
    process.env.AUTH_ENABLED = "false";
    resetServerEnvCacheForTests();
    expect(getServerEnv().authEnabled).toBe(false);
  });

  it.each(["true", "TRUE", " True "])(
    "coerces AUTH_ENABLED=%s to true",
    (value) => {
      setEnv({ AUTH_ENABLED: value });
      expect(getServerEnv().authEnabled).toBe(true);
    },
  );

  it.each(["false", "FALSE", " False "])(
    "coerces AUTH_ENABLED=%s to false",
    (value) => {
      setEnv({ AUTH_ENABLED: value });
      expect(getServerEnv().authEnabled).toBe(false);
    },
  );

  it("defaults AUTH_ENABLED to true when unset", () => {
    setEnv({ AUTH_ENABLED: undefined });
    expect(getServerEnv().authEnabled).toBe(true);
  });

  it("defaults SYNC_ENABLED to true when unset", () => {
    setEnv({ SYNC_ENABLED: undefined });
    expect(getServerEnv().syncEnabled).toBe(true);
  });

  it.each(["false", "FALSE", " False "])(
    "coerces SYNC_ENABLED=%s to false",
    (value) => {
      setEnv({ SYNC_ENABLED: value });
      expect(getServerEnv().syncEnabled).toBe(false);
    },
  );

  it("allows SYNC_ENABLED=false with AUTH_ENABLED=false outside production", () => {
    setEnv({ SYNC_ENABLED: "false", AUTH_ENABLED: "false" });
    const env = getServerEnv();
    expect(env.syncEnabled).toBe(false);
    expect(env.authEnabled).toBe(false);
  });

  it("rejects a missing DATABASE_URL", () => {
    setEnv({ DATABASE_URL: undefined });
    expect(() => getServerEnv()).toThrow(/DATABASE_URL/);
  });

  it("rejects a non-Postgres DATABASE_URL scheme", () => {
    setEnv({ DATABASE_URL: "mysql://localhost/db" });
    expect(() => getServerEnv()).toThrow(/DATABASE_URL/);
  });

  it("rejects an invalid BETTER_AUTH_URL", () => {
    setEnv({ BETTER_AUTH_URL: "not-a-url" });
    expect(() => getServerEnv()).toThrow(/BETTER_AUTH_URL/);
  });

  it("never echoes secret values in the thrown error", () => {
    setEnv({ DATABASE_URL: undefined });
    try {
      getServerEnv();
      expect.unreachable("expected getServerEnv to throw");
    } catch (error) {
      expect(String(error)).not.toContain(BASE_ENV.BETTER_AUTH_SECRET);
    }
  });

  it("never echoes the rejected secret value on the production short-secret path", () => {
    const shortProductionSecret = "short-secret-value";
    setEnv({
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: shortProductionSecret,
      BETTER_AUTH_URL: "https://safwa.example.com",
      NEXT_PUBLIC_APP_URL: "https://safwa.example.com",
      EMAIL_TRANSPORT: "resend",
      RESEND_API_KEY: "re_test",
      EMAIL_FROM: "noreply@safwa.example.com",
    });
    try {
      getServerEnv();
      expect.unreachable("expected getServerEnv to throw");
    } catch (error) {
      expect(String(error)).not.toContain(shortProductionSecret);
    }
  });

  describe("production invariants", () => {
    /**
     * A production configuration that passes every invariant. Each test below
     * overrides exactly the one thing it is about, so what a case is actually
     * testing is the diff from here — and adding a new invariant means adding
     * it here once rather than to a dozen near-identical literals.
     */
    function setProductionEnv(
      overrides: Record<string, string | undefined> = {},
    ) {
      setEnv({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "a".repeat(32),
        BETTER_AUTH_URL: "https://safwa.example.com",
        NEXT_PUBLIC_APP_URL: "https://safwa.example.com",
        EMAIL_TRANSPORT: "resend",
        RESEND_API_KEY: "re_test",
        EMAIL_FROM: "noreply@safwa.example.com",
        SIGNUP_ALLOWED_EMAILS: "owner@safwa.example.com",
        ...overrides,
      });
    }

    it("rejects a short BETTER_AUTH_SECRET in production", () => {
      setProductionEnv({ BETTER_AUTH_SECRET: "too-short" });
      expect(() => getServerEnv()).toThrow(/BETTER_AUTH_SECRET/);
    });

    it("rejects a non-https BETTER_AUTH_URL in production", () => {
      setProductionEnv({ BETTER_AUTH_URL: "http://safwa.example.com" });
      expect(() => getServerEnv()).toThrow(/BETTER_AUTH_URL/);
    });

    it("rejects console-file transport in production without the escape hatch", () => {
      setProductionEnv({
        EMAIL_TRANSPORT: "console-file",
        RESEND_API_KEY: undefined,
        EMAIL_FROM: undefined,
      });
      expect(() => getServerEnv()).toThrow(/console-file/);
    });

    it("allows console-file transport in production with the explicit escape hatch", () => {
      setProductionEnv({
        EMAIL_TRANSPORT: "console-file",
        RESEND_API_KEY: undefined,
        EMAIL_FROM: undefined,
        ALLOW_DEV_EMAIL_TRANSPORT_IN_PRODUCTION: "true",
      });
      expect(getServerEnv().emailTransport).toBe("console-file");
    });

    it("requires RESEND_API_KEY and EMAIL_FROM when EMAIL_TRANSPORT=resend in production", () => {
      setProductionEnv({ RESEND_API_KEY: undefined, EMAIL_FROM: undefined });
      expect(() => getServerEnv()).toThrow(/RESEND_API_KEY/);
    });

    it("accepts a fully valid production configuration", () => {
      setProductionEnv();
      const env = getServerEnv();
      expect(env.nodeEnv).toBe("production");
      expect(env.emailTransport).toBe("resend");
      expect(env.syncEnabled).toBe(true);
      expect(env.signupAllowedEmails).toEqual(["owner@safwa.example.com"]);
    });

    it("rejects SYNC_ENABLED=true with AUTH_ENABLED=false in production", () => {
      setProductionEnv({ AUTH_ENABLED: "false", SYNC_ENABLED: "true" });
      expect(() => getServerEnv()).toThrow(/SYNC_ENABLED/);
    });

    it("accepts SYNC_ENABLED=false with AUTH_ENABLED=false in production", () => {
      setProductionEnv({ AUTH_ENABLED: "false", SYNC_ENABLED: "false" });
      expect(getServerEnv().syncEnabled).toBe(false);
    });

    describe("sign-up fails closed", () => {
      it("rejects an unset SIGNUP_ALLOWED_EMAILS in production", () => {
        setProductionEnv({ SIGNUP_ALLOWED_EMAILS: undefined });
        expect(() => getServerEnv()).toThrow(/SIGNUP_ALLOWED_EMAILS/);
      });

      it("rejects a blank SIGNUP_ALLOWED_EMAILS in production", () => {
        // Blank parses to `null` (= not configured), which must reach the same
        // refusal as an absent variable rather than reading as an empty list.
        setProductionEnv({ SIGNUP_ALLOWED_EMAILS: "   " });
        expect(() => getServerEnv()).toThrow(/SIGNUP_ALLOWED_EMAILS/);
      });

      it("still requires the allowlist when AUTH_ENABLED=false", () => {
        // The kill-switch is a temporary rollback position; flipping it back
        // on must not be the moment sign-up silently opens to the world.
        setProductionEnv({
          AUTH_ENABLED: "false",
          SYNC_ENABLED: "false",
          SIGNUP_ALLOWED_EMAILS: undefined,
        });
        expect(() => getServerEnv()).toThrow(/SIGNUP_ALLOWED_EMAILS/);
      });

      it("accepts a multi-address allowlist, normalised", () => {
        setProductionEnv({
          SIGNUP_ALLOWED_EMAILS: " Owner@Safwa.Example.com , second@x.test ",
        });
        expect(getServerEnv().signupAllowedEmails).toEqual([
          "owner@safwa.example.com",
          "second@x.test",
        ]);
      });
    });

    describe("rate-limit ceilings", () => {
      // docs/DEPLOYMENT.md §2 has warned since Phase 15 that copying an E2E-
      // tuned env into production would silently gut rate limiting. These are
      // the exact values e2e/helpers/e2e-server-env.ts really sets.
      it("rejects the E2E sensitive-endpoint max (1000) in production", () => {
        setProductionEnv({ AUTH_RATE_LIMIT_MAX: "1000" });
        expect(() => getServerEnv()).toThrow(/AUTH_RATE_LIMIT_MAX/);
      });

      it("rejects the E2E default-bucket max (100000) in production", () => {
        setProductionEnv({ AUTH_RATE_LIMIT_DEFAULT_MAX: "100000" });
        expect(() => getServerEnv()).toThrow(/AUTH_RATE_LIMIT_DEFAULT_MAX/);
      });

      it("rejects a window so short it makes the max meaningless", () => {
        setProductionEnv({ AUTH_RATE_LIMIT_WINDOW_SECONDS: "1" });
        expect(() => getServerEnv()).toThrow(/AUTH_RATE_LIMIT_WINDOW_SECONDS/);
      });

      it("rejects a window so long it locks the learner out for hours", () => {
        setProductionEnv({ AUTH_RATE_LIMIT_WINDOW_SECONDS: "86400" });
        expect(() => getServerEnv()).toThrow(/AUTH_RATE_LIMIT_WINDOW_SECONDS/);
      });

      it("rejects a default-bucket window below its floor", () => {
        setProductionEnv({ AUTH_RATE_LIMIT_DEFAULT_WINDOW_SECONDS: "1" });
        expect(() => getServerEnv()).toThrow(
          /AUTH_RATE_LIMIT_DEFAULT_WINDOW_SECONDS/,
        );
      });

      it("accepts the shipped defaults, which is what production actually runs", () => {
        // The defaults (60s/5 and 10s/100) must sit inside every bound, or a
        // deployment that sets none of these four variables cannot start.
        setProductionEnv({
          AUTH_RATE_LIMIT_WINDOW_SECONDS: undefined,
          AUTH_RATE_LIMIT_MAX: undefined,
          AUTH_RATE_LIMIT_DEFAULT_WINDOW_SECONDS: undefined,
          AUTH_RATE_LIMIT_DEFAULT_MAX: undefined,
        });
        const env = getServerEnv();
        expect(env.authRateLimitWindowSeconds).toBe(60);
        expect(env.authRateLimitMax).toBe(5);
        expect(env.authRateLimitDefaultWindowSeconds).toBe(10);
        expect(env.authRateLimitDefaultMax).toBe(100);
      });

      it("accepts values at each bound", () => {
        setProductionEnv({
          AUTH_RATE_LIMIT_WINDOW_SECONDS: "30",
          AUTH_RATE_LIMIT_MAX: "20",
          AUTH_RATE_LIMIT_DEFAULT_WINDOW_SECONDS: "5",
          AUTH_RATE_LIMIT_DEFAULT_MAX: "1000",
        });
        expect(() => getServerEnv()).not.toThrow();
      });

      it("reports every out-of-bounds variable at once, not just the first", () => {
        setProductionEnv({
          AUTH_RATE_LIMIT_MAX: "1000",
          AUTH_RATE_LIMIT_DEFAULT_MAX: "100000",
        });
        try {
          getServerEnv();
          expect.unreachable("expected getServerEnv to throw");
        } catch (error) {
          expect(String(error)).toContain("AUTH_RATE_LIMIT_MAX");
          expect(String(error)).toContain("AUTH_RATE_LIMIT_DEFAULT_MAX");
        }
      });

      it("leaves the ceilings off outside production", () => {
        // The E2E and integration suites depend on this: they set exactly
        // these values against a development/test NODE_ENV.
        setEnv({
          AUTH_RATE_LIMIT_MAX: "1000",
          AUTH_RATE_LIMIT_DEFAULT_MAX: "100000",
        });
        const env = getServerEnv();
        expect(env.authRateLimitMax).toBe(1000);
        expect(env.authRateLimitDefaultMax).toBe(100000);
      });
    });
  });

  describe("SIGNUP_ALLOWED_EMAILS parsing", () => {
    it("is null when unset (sign-up open outside production)", () => {
      setEnv({});
      expect(getServerEnv().signupAllowedEmails).toBeNull();
    });

    it("parses a comma-separated list outside production too", () => {
      setEnv({ SIGNUP_ALLOWED_EMAILS: "a@x.test,b@x.test" });
      expect(getServerEnv().signupAllowedEmails).toEqual([
        "a@x.test",
        "b@x.test",
      ]);
    });

    it("reports a malformed entry as an environment error, in any environment", () => {
      setEnv({ SIGNUP_ALLOWED_EMAILS: "a@x.test,not-an-email" });
      expect(() => getServerEnv()).toThrow(/SIGNUP_ALLOWED_EMAILS/);
    });

    it("never echoes a configured address in the thrown error", () => {
      const address = "someone.private@example.test";
      setEnv({ SIGNUP_ALLOWED_EMAILS: `${address},not-an-email` });
      try {
        getServerEnv();
        expect.unreachable("expected getServerEnv to throw");
      } catch (error) {
        expect(String(error)).not.toContain(address);
      }
    });
  });
});
