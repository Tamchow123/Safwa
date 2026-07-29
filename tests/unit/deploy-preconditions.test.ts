import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Scoped to this file, exactly as tests/env/server.test.ts does it and for the
// same reason: Vitest resolves `server-only`'s default export condition, which
// throws by design. Mocking it globally would remove the unit-level tripwire
// against a client-reachable file importing a server-only module.
vi.mock("server-only", () => ({}));

import { PRODUCTION_RATE_LIMIT_BOUNDS } from "@/modules/env/rules";
import {
  getServerEnv,
  requiredServerEnvKeys,
  resetServerEnvCacheForTests,
} from "@/modules/env/server";
import {
  checkDeployPreconditions,
  formatFailures,
  REQUIRED_PRODUCTION_ENV,
} from "@/scripts/verify-deploy-preconditions";

/**
 * The pre-deploy check, tested for the thing it is actually for: catching a bad
 * production configuration BEFORE the deployment exists.
 *
 * `docs/DEPLOYMENT.md` §2 explains why the ordering matters — `getServerEnv()`
 * validates lazily, so a misconfigured production deployment comes up looking
 * fine and throws on the first request that touches auth, the database or
 * email. This script is the earlier signal, and it is only worth having if it
 * fails on the mistakes people actually make: pasting an E2E `.env`, forgetting
 * the allowlist, leaving the console email transport on.
 *
 * The last describe is what keeps it honest over time. Rather than restating
 * the runtime's rules and hoping the two stay in step, it RUNS the real
 * validator and asserts this script is never the more permissive of the two.
 */
const VALID: Record<string, string> = {
  DATABASE_URL: "postgres://user:pw@db.example.com:5432/safwa",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "https://safwa.example.com",
  NEXT_PUBLIC_APP_URL: "https://safwa.example.com",
  SIGNUP_ALLOWED_EMAILS: "owner@example.com",
  EMAIL_TRANSPORT: "resend",
  RESEND_API_KEY: "re_test_key",
  EMAIL_FROM: "Safwa <noreply@safwa.example.com>",
};

/** The documented escape hatch: console email transport, explicitly permitted. */
const DEV_EMAIL_HATCH: Record<string, string | undefined> = {
  EMAIL_TRANSPORT: "console-file",
  ALLOW_DEV_EMAIL_TRANSPORT_IN_PRODUCTION: "true",
  RESEND_API_KEY: undefined,
  EMAIL_FROM: undefined,
};

function check(overrides: Record<string, string | undefined> = {}) {
  return checkDeployPreconditions({ ...VALID, ...overrides });
}

function failed(overrides: Record<string, string | undefined> = {}): string[] {
  return check(overrides).failures.map((failure) => failure.variable);
}

describe("a deployable production environment", () => {
  it("passes when every variable is set correctly", () => {
    const report = check();
    expect(report.failures).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it("accepts the four rate-limit variables left unset, since the defaults are in bounds", () => {
    // DEPLOYMENT.md §2 states this outright: a production deployment that sets
    // none of them starts normally. If a bound ever moved past a default, this
    // is the test that would say so.
    const names = Object.keys(PRODUCTION_RATE_LIMIT_BOUNDS);
    expect(failed().filter((variable) => names.includes(variable))).toEqual([]);
  });
});

describe("what it refuses", () => {
  it("names every missing required variable at once, not just the first", () => {
    // A precondition check that reports one problem per run turns a
    // misconfiguration into several deploy attempts.
    expect(
      failed({
        DATABASE_URL: undefined,
        BETTER_AUTH_SECRET: undefined,
        BETTER_AUTH_URL: undefined,
      }),
    ).toEqual(
      expect.arrayContaining([
        "DATABASE_URL",
        "BETTER_AUTH_SECRET",
        "BETTER_AUTH_URL",
      ]),
    );
  });

  it("treats a blank value as unset", () => {
    expect(failed({ DATABASE_URL: "   " })).toContain("DATABASE_URL");
  });

  it("rejects a connection string that is not postgres", () => {
    // Presence alone is not enough: the runtime schema requires the scheme, so
    // a typo'd one must not pass the build gate and surface live instead.
    expect(failed({ DATABASE_URL: "mysql://user@host/db" })).toContain(
      "DATABASE_URL",
    );
    expect(failed({ DATABASE_URL: "postgresql://user@host/db" })).not.toContain(
      "DATABASE_URL",
    );
  });

  it("rejects a short signing secret without printing it", () => {
    const secret = "tooshort";
    const report = check({ BETTER_AUTH_SECRET: secret });
    expect(report.failures.map((f) => f.variable)).toContain(
      "BETTER_AUTH_SECRET",
    );
    // This output goes into a CI log. It may say how long the secret is; it may
    // never say what it is.
    expect(formatFailures(report.failures)).not.toContain(secret);
  });

  it("rejects a non-https or malformed origin", () => {
    expect(
      failed({ NEXT_PUBLIC_APP_URL: "http://safwa.example.com" }),
    ).toContain("NEXT_PUBLIC_APP_URL");
    expect(failed({ BETTER_AUTH_URL: "not-a-url" })).toContain(
      "BETTER_AUTH_URL",
    );
  });

  it("fails closed when the sign-up allowlist is unset", () => {
    // The most consequential default here: an unset allowlist on a publicly
    // reachable personal instance means anyone may register.
    expect(failed({ SIGNUP_ALLOWED_EMAILS: undefined })).toContain(
      "SIGNUP_ALLOWED_EMAILS",
    );
    expect(failed({ SIGNUP_ALLOWED_EMAILS: "  " })).toContain(
      "SIGNUP_ALLOWED_EMAILS",
    );
  });

  it("reports a malformed allowlist instead of throwing", () => {
    // A trailing comma is how people actually mistype a comma-separated list,
    // and the parser throws on it. An uncaught throw here would put a stack
    // trace in the build log AND hide every other problem in the same run.
    for (const malformed of ["owner@example.com,", "not-an-email", ","]) {
      expect(
        failed({ SIGNUP_ALLOWED_EMAILS: malformed }),
        `"${malformed}" must be reported, not thrown`,
      ).toContain("SIGNUP_ALLOWED_EMAILS");
    }
  });

  it("keeps checking after a malformed allowlist rather than stopping there", () => {
    // The specific regression: one bad variable must not mask the others.
    const names = failed({
      SIGNUP_ALLOWED_EMAILS: "owner@example.com,",
      AUTH_RATE_LIMIT_MAX: "1000",
    });
    expect(names).toContain("SIGNUP_ALLOWED_EMAILS");
    expect(names).toContain("AUTH_RATE_LIMIT_MAX");
  });

  it("reports a malformed allowlist once, not twice", () => {
    // It is checked in two places (the parser throwing, and the null/empty
    // result); a variable reported twice reads as two separate mistakes.
    const names = failed({ SIGNUP_ALLOWED_EMAILS: "not-an-email" });
    expect(
      names.filter((variable) => variable === "SIGNUP_ALLOWED_EMAILS"),
    ).toHaveLength(1);
  });

  it("refuses the E2E rate limits specifically", () => {
    // e2e/helpers/e2e-server-env.ts really does set these two values.
    expect(
      failed({
        AUTH_RATE_LIMIT_DEFAULT_MAX: "100000",
        AUTH_RATE_LIMIT_MAX: "1000",
      }),
    ).toEqual(
      expect.arrayContaining([
        "AUTH_RATE_LIMIT_DEFAULT_MAX",
        "AUTH_RATE_LIMIT_MAX",
      ]),
    );
  });

  it("checks both ends of every rate-limit bound", () => {
    for (const [variable, bound] of Object.entries(
      PRODUCTION_RATE_LIMIT_BOUNDS,
    )) {
      expect(
        failed({ [variable]: String(bound.min - 1) }),
        `${variable} below its floor`,
      ).toContain(variable);
      expect(
        failed({ [variable]: String(bound.max + 1) }),
        `${variable} above its ceiling`,
      ).toContain(variable);
      expect(
        failed({ [variable]: String(bound.min) }),
        `${variable} at its floor must be accepted`,
      ).not.toContain(variable);
      expect(
        failed({ [variable]: String(bound.max) }),
        `${variable} at its ceiling must be accepted`,
      ).not.toContain(variable);
    }
  });

  it("rejects a non-integer rate limit rather than coercing it", () => {
    expect(failed({ AUTH_RATE_LIMIT_MAX: "5.5" })).toContain(
      "AUTH_RATE_LIMIT_MAX",
    );
    expect(failed({ AUTH_RATE_LIMIT_MAX: "lots" })).toContain(
      "AUTH_RATE_LIMIT_MAX",
    );
  });

  it("refuses the console email transport, because email is a hard dependency", () => {
    expect(
      failed({
        EMAIL_TRANSPORT: "console-file",
        RESEND_API_KEY: undefined,
        EMAIL_FROM: undefined,
      }),
    ).toContain("EMAIL_TRANSPORT");
  });

  it("requires the Resend credentials when Resend is selected", () => {
    expect(failed({ RESEND_API_KEY: undefined })).toContain("RESEND_API_KEY");
    expect(failed({ EMAIL_FROM: undefined })).toContain("EMAIL_FROM");
  });

  it("rejects sync enabled without auth, however the booleans are spelled", () => {
    // The runtime trims and lower-cases these. A stricter comparison here would
    // let `TRUE` pass the gate and then fail at boot — the exact "found late"
    // outcome this script exists to prevent.
    for (const [sync, auth] of [
      ["true", "false"],
      ["TRUE", "False"],
      [" true ", " FALSE "],
    ]) {
      expect(
        failed({ SYNC_ENABLED: sync, AUTH_ENABLED: auth }),
        `SYNC_ENABLED=${sync} AUTH_ENABLED=${auth}`,
      ).toContain("SYNC_ENABLED");
    }
  });

  it("rejects a boolean that is neither true nor false", () => {
    expect(failed({ SYNC_ENABLED: "treu" })).toContain("SYNC_ENABLED");
    expect(
      failed({ ALLOW_DEV_EMAIL_TRANSPORT_IN_PRODUCTION: "yes" }),
    ).toContain("ALLOW_DEV_EMAIL_TRANSPORT_IN_PRODUCTION");
  });
});

describe("the dev email escape hatch", () => {
  it("warns rather than failing, because the runtime permits it", () => {
    // A build gate stricter than the runtime it gates is a gate nobody can
    // satisfy: making this fatal would mean the documented escape hatch could
    // never produce a deployment at all.
    const report = check(DEV_EMAIL_HATCH);
    expect(report.failures).toEqual([]);
    expect(report.warnings.map((w) => w.variable)).toEqual([
      "ALLOW_DEV_EMAIL_TRANSPORT_IN_PRODUCTION",
    ]);
  });

  it("is still loud about what it means", () => {
    const report = check(DEV_EMAIL_HATCH);
    expect(report.warnings[0]?.note).toMatch(/local directory/i);
  });
});

describe("parity with the runtime validator", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    resetServerEnvCacheForTests();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetServerEnvCacheForTests();
  });

  /** Does the REAL runtime validator accept this environment as production? */
  function runtimeAccepts(env: Record<string, string | undefined>): boolean {
    const defined = Object.entries(env).filter(
      ([, value]) => value !== undefined,
    );
    // Assigning `undefined` through `process.env` stringifies it to "undefined",
    // so an unset variable has to be genuinely absent from the object.
    process.env = {
      ...Object.fromEntries(defined),
      NODE_ENV: "production",
    } as unknown as NodeJS.ProcessEnv;
    resetServerEnvCacheForTests();
    try {
      getServerEnv();
      return true;
    } catch {
      return false;
    }
  }

  it("derives the required-variable list from the schema rather than by hand", () => {
    // A variable that becomes required in the schema and is not mirrored in the
    // script would make the pre-deploy check report OK for a configuration the
    // deployed instance rejects on its first request.
    expect([...REQUIRED_PRODUCTION_ENV].sort()).toEqual(
      requiredServerEnvKeys(),
    );
  });

  it("agrees with the runtime about the environments that should deploy", () => {
    const accepted: Record<string, string | undefined>[] = [
      { ...VALID },
      { ...VALID, ...DEV_EMAIL_HATCH },
      { ...VALID, BETTER_AUTH_SECRET: "y".repeat(64) },
      { ...VALID, SYNC_ENABLED: "false", AUTH_ENABLED: "false" },
      { ...VALID, AUTH_RATE_LIMIT_MAX: "20", AUTH_RATE_LIMIT_DEFAULT_MAX: "1" },
    ];
    for (const [index, env] of accepted.entries()) {
      expect(checkDeployPreconditions(env).failures, `case ${index}`).toEqual(
        [],
      );
      expect(runtimeAccepts(env), `case ${index}`).toBe(true);
    }
  });

  it("is never more permissive than the runtime", () => {
    // The property that matters. This script may reject MORE than the runtime
    // does — it knows about https and deploy-time concerns the schema cannot
    // see — but it must never ACCEPT something the runtime will refuse. That
    // direction is the "discovered live" failure it exists to prevent.
    const cases: Record<string, string | undefined>[] = [
      {},
      { ...VALID },
      { ...VALID, ...DEV_EMAIL_HATCH },
      { ...VALID, DATABASE_URL: undefined },
      { ...VALID, DATABASE_URL: "mysql://user@host/db" },
      { ...VALID, BETTER_AUTH_SECRET: "short" },
      { ...VALID, BETTER_AUTH_URL: "http://safwa.example.com" },
      { ...VALID, SIGNUP_ALLOWED_EMAILS: undefined },
      { ...VALID, SIGNUP_ALLOWED_EMAILS: "owner@example.com," },
      { ...VALID, AUTH_RATE_LIMIT_MAX: "1000" },
      { ...VALID, AUTH_RATE_LIMIT_DEFAULT_MAX: "100000" },
      { ...VALID, AUTH_RATE_LIMIT_WINDOW_SECONDS: "1" },
      { ...VALID, SYNC_ENABLED: "true", AUTH_ENABLED: "false" },
      { ...VALID, SYNC_ENABLED: "TRUE", AUTH_ENABLED: "False" },
      { ...VALID, EMAIL_TRANSPORT: "console-file" },
      { ...VALID, RESEND_API_KEY: undefined },
      { ...VALID, EMAIL_FROM: undefined },
    ];

    for (const [index, env] of cases.entries()) {
      if (checkDeployPreconditions(env).failures.length > 0) continue;
      expect(
        runtimeAccepts(env),
        `case ${index}: the pre-deploy check accepted an environment the runtime rejects`,
      ).toBe(true);
    }
  });
});
