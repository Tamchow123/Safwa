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
    expect(env.emailTransport).toBe("console-file");
    expect(env.emailOutboxDir).toBe(".local/email-outbox");
    expect(env.contentServerDir).toBe("content-server");
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
    it("rejects a short BETTER_AUTH_SECRET in production", () => {
      setEnv({
        NODE_ENV: "production",
        BETTER_AUTH_URL: "https://safwa.example.com",
        NEXT_PUBLIC_APP_URL: "https://safwa.example.com",
        EMAIL_TRANSPORT: "resend",
        RESEND_API_KEY: "re_test",
        EMAIL_FROM: "noreply@safwa.example.com",
      });
      expect(() => getServerEnv()).toThrow(/BETTER_AUTH_SECRET/);
    });

    it("rejects a non-https BETTER_AUTH_URL in production", () => {
      setEnv({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "a".repeat(32),
        BETTER_AUTH_URL: "http://safwa.example.com",
        NEXT_PUBLIC_APP_URL: "https://safwa.example.com",
        EMAIL_TRANSPORT: "resend",
        RESEND_API_KEY: "re_test",
        EMAIL_FROM: "noreply@safwa.example.com",
      });
      expect(() => getServerEnv()).toThrow(/BETTER_AUTH_URL/);
    });

    it("rejects console-file transport in production without the escape hatch", () => {
      setEnv({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "a".repeat(32),
        BETTER_AUTH_URL: "https://safwa.example.com",
        NEXT_PUBLIC_APP_URL: "https://safwa.example.com",
        EMAIL_TRANSPORT: "console-file",
      });
      expect(() => getServerEnv()).toThrow(/console-file/);
    });

    it("allows console-file transport in production with the explicit escape hatch", () => {
      setEnv({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "a".repeat(32),
        BETTER_AUTH_URL: "https://safwa.example.com",
        NEXT_PUBLIC_APP_URL: "https://safwa.example.com",
        EMAIL_TRANSPORT: "console-file",
        ALLOW_DEV_EMAIL_TRANSPORT_IN_PRODUCTION: "true",
      });
      expect(getServerEnv().emailTransport).toBe("console-file");
    });

    it("requires RESEND_API_KEY and EMAIL_FROM when EMAIL_TRANSPORT=resend in production", () => {
      setEnv({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "a".repeat(32),
        BETTER_AUTH_URL: "https://safwa.example.com",
        NEXT_PUBLIC_APP_URL: "https://safwa.example.com",
        EMAIL_TRANSPORT: "resend",
      });
      expect(() => getServerEnv()).toThrow(/RESEND_API_KEY/);
    });

    it("accepts a fully valid production configuration", () => {
      setEnv({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "a".repeat(32),
        BETTER_AUTH_URL: "https://safwa.example.com",
        NEXT_PUBLIC_APP_URL: "https://safwa.example.com",
        EMAIL_TRANSPORT: "resend",
        RESEND_API_KEY: "re_test",
        EMAIL_FROM: "noreply@safwa.example.com",
      });
      const env = getServerEnv();
      expect(env.nodeEnv).toBe("production");
      expect(env.emailTransport).toBe("resend");
    });
  });
});
