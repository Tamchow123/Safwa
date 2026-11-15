import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Scoped to this file only (not tests/setup.ts): Vitest resolves the
// package's default export condition (throws by design), not the
// `react-server` condition Next.js's build resolves to an empty module.
// Mocking it globally would silently defeat the real throw for every other
// test file too, removing the one unit-test-level tripwire against a
// client-reachable file accidentally importing a server-only module.
vi.mock("server-only", () => ({}));

import { SMTP_REQUIRED_ENV } from "@/modules/env/rules";
import {
  getServerEnv,
  resetServerEnvCacheForTests,
} from "@/modules/env/server";

/** A complete SMTP configuration (Phase 18.2). */
const SMTP_ENV = {
  EMAIL_TRANSPORT: "smtp",
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "465",
  SMTP_USER: "mailer@example.com",
  SMTP_PASSWORD: "app-password-not-real",
  EMAIL_FROM: "Safwa <mailer@example.com>",
} as const;

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
      ...SMTP_ENV,
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
        ...SMTP_ENV,
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
      setProductionEnv({ EMAIL_TRANSPORT: "console-file" });
      expect(() => getServerEnv()).toThrow(/console-file/);
    });

    it("allows console-file transport in production with the explicit escape hatch", () => {
      setProductionEnv({
        EMAIL_TRANSPORT: "console-file",
        ALLOW_DEV_EMAIL_TRANSPORT_IN_PRODUCTION: "true",
      });
      expect(getServerEnv().emailTransport).toBe("console-file");
    });

    it("refuses EMAIL_TRANSPORT=resend, which Phase 18.2 removed", () => {
      // A production environment still configured for the old provider must
      // fail at start-up, not fall through to some other transport.
      setProductionEnv({ EMAIL_TRANSPORT: "resend" });
      expect(() => getServerEnv()).toThrow(/EMAIL_TRANSPORT/);
    });

    it("accepts a complete SMTP configuration in production", () => {
      setProductionEnv();
      const env = getServerEnv();
      expect(env.emailTransport).toBe("smtp");
      expect(env.smtpHost).toBe("smtp.example.com");
      expect(env.smtpPort).toBe(465);
      expect(env.smtpUser).toBe("mailer@example.com");
      expect(env.smtpPassword).toBe(SMTP_ENV.SMTP_PASSWORD);
      expect(env.emailFrom).toBe("Safwa <mailer@example.com>");
    });

    it.each(SMTP_REQUIRED_ENV)(
      "requires %s when EMAIL_TRANSPORT=smtp in production",
      (name) => {
        setProductionEnv({ [name]: undefined });
        expect(() => getServerEnv()).toThrow(
          new RegExp(`${name} is required when EMAIL_TRANSPORT=smtp`),
        );
      },
    );

    it("treats a blank SMTP setting as missing in production", () => {
      setProductionEnv({ SMTP_HOST: "" });
      expect(() => getServerEnv()).toThrow(/SMTP_HOST is required/);
    });

    it.each(["SMTP_HOST", "SMTP_USER", "EMAIL_FROM"])(
      "treats a whitespace-only %s as missing in production",
      (name) => {
        setProductionEnv({ [name]: " \n" });
        expect(() => getServerEnv()).toThrow(
          new RegExp(`${name} is required when EMAIL_TRANSPORT=smtp`),
        );
      },
    );

    it("never echoes the SMTP password in a production configuration error", () => {
      setProductionEnv({ SMTP_HOST: undefined });
      try {
        getServerEnv();
        expect.unreachable("expected getServerEnv to throw");
      } catch (error) {
        expect(String(error)).not.toContain(SMTP_ENV.SMTP_PASSWORD);
      }
    });

    it("accepts a fully valid production configuration", () => {
      setProductionEnv();
      const env = getServerEnv();
      expect(env.nodeEnv).toBe("production");
      expect(env.emailTransport).toBe("smtp");
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

  describe("SMTP settings", () => {
    it("reads both submission ports as numbers, tolerating surrounding spaces", () => {
      setEnv({ SMTP_PORT: "465" });
      expect(getServerEnv().smtpPort).toBe(465);
      resetServerEnvCacheForTests();
      setEnv({ SMTP_PORT: " 587 " });
      expect(getServerEnv().smtpPort).toBe(587);
    });

    it("treats an absent or blank SMTP_PORT as unset", () => {
      // A .env.local copied from .env.example carries `SMTP_PORT=`, which must
      // not stop local development from starting.
      for (const port of [undefined, "", "   "]) {
        resetServerEnvCacheForTests();
        setEnv({ SMTP_PORT: port });
        expect(getServerEnv().smtpPort, JSON.stringify(port)).toBeUndefined();
      }
    });

    it.each(["25", "2525", "4650", "465.0", "0x1D1", "smtp"])(
      "rejects SMTP_PORT=%s in any environment, since the port selects the TLS mode",
      (port) => {
        setEnv({ SMTP_PORT: port });
        expect(() => getServerEnv()).toThrow(/SMTP_PORT must be 465/);
      },
    );

    it("trims SMTP_HOST, SMTP_USER and EMAIL_FROM", () => {
      // Surrounding whitespace is the one defect a pasted value commonly
      // carries that is safe to repair (Phase 18.3).
      setEnv({
        SMTP_HOST: " smtp.gmail.com\n",
        SMTP_USER: "\tmailer@example.com ",
        EMAIL_FROM: " Safwa <mailer@example.com>\r\n",
      });
      const env = getServerEnv();
      expect(env.smtpHost).toBe("smtp.gmail.com");
      expect(env.smtpUser).toBe("mailer@example.com");
      expect(env.emailFrom).toBe("Safwa <mailer@example.com>");
    });

    it("never trims SMTP_PASSWORD", () => {
      // A credential's characters belong to its provider; a wrong one fails
      // at send time with EAUTH rather than being silently edited here.
      setEnv({ SMTP_PASSWORD: " pass word " });
      expect(getServerEnv().smtpPassword).toBe(" pass word ");
    });

    it("reads a blank SMTP_HOST, SMTP_USER or EMAIL_FROM as unset outside production", () => {
      setEnv({ SMTP_HOST: "  ", SMTP_USER: "", EMAIL_FROM: "\n" });
      const env = getServerEnv();
      expect(env.smtpHost).toBeUndefined();
      expect(env.smtpUser).toBeUndefined();
      expect(env.emailFrom).toBeUndefined();
    });

    it.each([
      "smtp.gmail.com",
      "SMTP.Example.COM",
      "mail-1.example.co.uk",
      "192.0.2.10",
      "localhost",
      "mail.example.xn--p1ai",
    ])("accepts SMTP_HOST=%j", (host) => {
      setEnv({ SMTP_HOST: host });
      expect(getServerEnv().smtpHost).toBe(host);
    });

    it.each([
      [
        "https://smtp.gmail.com",
        /SMTP_HOST must be a bare host name, without a scheme/,
      ],
      [
        "smtp://smtp.gmail.com",
        /SMTP_HOST must be a bare host name, without a scheme/,
      ],
      ["smtp.gmail.com:465", /SMTP_HOST must not contain a colon/],
      ["::1", /SMTP_HOST must not contain a colon/],
      ["smtp.gmail.com/", /SMTP_HOST must not contain a path/],
      ['"smtp.gmail.com"', /SMTP_HOST must not be quoted/],
      ["'smtp.gmail.com'", /SMTP_HOST must not be quoted/],
      ["smtp .gmail.com", /SMTP_HOST must not contain whitespace/],
      ["smtp.gmail\n.com", /SMTP_HOST must not contain whitespace/],
      ["smtp.gmail.com.", /SMTP_HOST must be a host name/],
      ["smtp..gmail.com", /SMTP_HOST must be a host name/],
      ["-smtp.gmail.com", /SMTP_HOST must be a host name/],
      ["smtp_relay.gmail.com", /SMTP_HOST must be a host name/],
      ["mailer@smtp.gmail.com", /SMTP_HOST must be a host name/],
      ["999.0.2.10", /SMTP_HOST must be a host name/],
      ["192.0.2.1x", /SMTP_HOST must be a host name/],
      ["smtp.example.1com", /SMTP_HOST must be a host name/],
      ["192.0.2", /SMTP_HOST must be a host name/],
      [`${"a".repeat(64)}.example.com`, /SMTP_HOST must be a host name/],
    ])(
      "rejects SMTP_HOST=%j in any environment, naming the defect",
      (host, defect) => {
        setEnv({ SMTP_HOST: host });
        expect(() => getServerEnv()).toThrow(defect);
      },
    );

    it("never echoes a rejected SMTP_HOST", () => {
      setEnv({ SMTP_HOST: "https://smtp.gmail.com:465/" });
      try {
        getServerEnv();
        expect.unreachable("expected getServerEnv to throw");
      } catch (error) {
        expect(String(error)).not.toContain("gmail");
      }
    });

    it("leaves the SMTP settings optional outside production", () => {
      // sendEmail's own config check names what is missing on first send;
      // refusing to start would take guest-only pages down with it.
      setEnv({ EMAIL_TRANSPORT: "smtp" });
      expect(getServerEnv().emailTransport).toBe("smtp");
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
