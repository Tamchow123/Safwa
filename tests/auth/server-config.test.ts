import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const sendEmailMock = vi.fn().mockResolvedValue({
  success: true,
  messageId: "mock-id",
});
vi.mock("@/modules/email/send-email", () => ({
  sendEmail: (...args: unknown[]) => sendEmailMock(...args),
}));

const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://safwa:pw@localhost:5432/safwa_test",
  BETTER_AUTH_SECRET: "test-secret-value",
  BETTER_AUTH_URL: "http://localhost:3000",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
} as const;

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  process.env = { ...BASE_ENV } as unknown as NodeJS.ProcessEnv;
  vi.resetModules();
  sendEmailMock.mockClear();
});

afterEach(() => {
  process.env = originalEnv;
});

describe("modules/auth/server", () => {
  // vi.resetModules() forces a genuinely cold re-import of the whole
  // better-auth/drizzle-orm/pg dependency graph; under full-suite
  // concurrent worker load that first import can exceed Vitest's 5s
  // default, so this one test gets a longer allowance (last arg below)
  // rather than the whole run flaking — the assertion itself is unchanged.
  const COLD_IMPORT_TIMEOUT_MS = 20_000;

  it(
    "importing the module does not validate env or construct anything (lazy)",
    async () => {
      // Deliberately invalid env — if construction happened at import time,
      // this import would throw.
      process.env = { NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv;
      await expect(import("@/modules/auth/server")).resolves.toBeDefined();
    },
    COLD_IMPORT_TIMEOUT_MS,
  );

  it("getAuth() constructs a Better Auth instance exposing the expected handler/api surface", async () => {
    const { getAuth } = await import("@/modules/auth/server");
    const auth = getAuth();
    expect(auth.handler).toBeTypeOf("function");
    expect(auth.api).toBeDefined();
    expect(auth.api.getSession).toBeTypeOf("function");
    expect(auth.api.signInEmail).toBeTypeOf("function");
    expect(auth.api.signUpEmail).toBeTypeOf("function");
  });

  it("getAuth() is memoised across calls", async () => {
    const { getAuth } = await import("@/modules/auth/server");
    const first = getAuth();
    const second = getAuth();
    expect(second).toBe(first);
  });

  it("getAuth() surfaces a clear error when the environment is invalid, only when actually called", async () => {
    process.env = { NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv;
    const { getAuth } = await import("@/modules/auth/server");
    expect(() => getAuth()).toThrow(/DATABASE_URL/);
  });

  it("getAuth() refuses to construct when AUTH_ENABLED=false, without touching the DB", async () => {
    process.env.AUTH_ENABLED = "false";
    const { getAuth, AuthDisabledError } =
      await import("@/modules/auth/server");
    expect(() => getAuth()).toThrow(AuthDisabledError);
  });

  it("getAuth() refuses to return an already-cached instance once AUTH_ENABLED flips to false", async () => {
    const { getAuth, AuthDisabledError } =
      await import("@/modules/auth/server");
    // Construct once while enabled, caching an instance.
    expect(getAuth()).toBeDefined();

    process.env.AUTH_ENABLED = "false";
    const { resetServerEnvCacheForTests } =
      await import("@/modules/env/server");
    resetServerEnvCacheForTests();

    expect(() => getAuth()).toThrow(AuthDisabledError);
  });

  it("configures email/password with mandatory verification and the documented password bounds", async () => {
    const { getAuth } = await import("@/modules/auth/server");
    const options = getAuth().options;
    expect(options.emailAndPassword?.enabled).toBe(true);
    expect(options.emailAndPassword?.requireEmailVerification).toBe(true);
    expect(options.emailAndPassword?.minPasswordLength).toBe(8);
    expect(options.emailAndPassword?.maxPasswordLength).toBe(128);
    expect(options.emailAndPassword?.revokeSessionsOnPasswordReset).toBe(true);
    expect(options.emailAndPassword?.resetPasswordTokenExpiresIn).toBe(3600);
  });

  it("configures explicit email-verification and delete-account token expiry", async () => {
    const { getAuth } = await import("@/modules/auth/server");
    const options = getAuth().options;
    expect(options.emailVerification?.sendOnSignUp).toBe(true);
    expect(options.emailVerification?.expiresIn).toBe(3600);
    expect(options.user?.deleteUser?.enabled).toBe(true);
    expect(options.user?.deleteUser?.deleteTokenExpiresIn).toBe(86400);
  });

  it("configures explicit session expiry and refresh policy", async () => {
    const { getAuth } = await import("@/modules/auth/server");
    const options = getAuth().options;
    expect(options.session?.expiresIn).toBe(604800);
    expect(options.session?.updateAge).toBe(86400);
  });

  it("enables secure cookies only when BETTER_AUTH_URL is https", async () => {
    const { getAuth: getAuthHttp } = await import("@/modules/auth/server");
    expect(getAuthHttp().options.advanced?.useSecureCookies).toBe(false);

    vi.resetModules();
    process.env.BETTER_AUTH_URL = "https://safwa.example.com";
    process.env.NEXT_PUBLIC_APP_URL = "https://safwa.example.com";
    const { getAuth: getAuthHttps } = await import("@/modules/auth/server");
    expect(getAuthHttps().options.advanced?.useSecureCookies).toBe(true);
  });

  it("uses uuid ids via the Drizzle adapter", async () => {
    const { getAuth } = await import("@/modules/auth/server");
    expect(getAuth().options.advanced?.database?.generateId).toBe("uuid");
  });

  it("applies a database-backed rate-limit customRule to every sensitive endpoint, using the configured window/max", async () => {
    process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS = "30";
    process.env.AUTH_RATE_LIMIT_MAX = "2";
    const { getAuth } = await import("@/modules/auth/server");
    const options = getAuth().options;
    expect(options.rateLimit?.storage).toBe("database");
    // Better Auth's own default is enabled: isProduction — silently off
    // outside NODE_ENV=production. Explicit here so this never regresses
    // to that default and goes silently untested/unenforced again.
    expect(options.rateLimit?.enabled).toBe(true);
    // The DEFAULT (non-customRule) bucket matches Better Auth's own
    // built-in default (window: 10, max: 100) when the override env vars
    // are unset, so production/dev behaviour is unchanged by their mere
    // existence.
    expect(options.rateLimit?.window).toBe(10);
    expect(options.rateLimit?.max).toBe(100);
    const expectedRule = { window: 30, max: 2 };
    expect(options.rateLimit?.customRules).toEqual({
      "/sign-up/email": expectedRule,
      "/sign-in/email": expectedRule,
      "/send-verification-email": expectedRule,
      "/request-password-reset": expectedRule,
      "/reset-password": expectedRule,
      "/delete-user": expectedRule,
      "/delete-user/callback": expectedRule,
    });
  });

  it("the default (non-customRule) rate-limit bucket is independently configurable", async () => {
    process.env.AUTH_RATE_LIMIT_DEFAULT_WINDOW_SECONDS = "45";
    process.env.AUTH_RATE_LIMIT_DEFAULT_MAX = "9000";
    const { getAuth } = await import("@/modules/auth/server");
    const options = getAuth().options;
    expect(options.rateLimit?.window).toBe(45);
    expect(options.rateLimit?.max).toBe(9000);
  });

  it("enables no OAuth/social providers and no plugins", async () => {
    const { getAuth } = await import("@/modules/auth/server");
    const optionKeys = Object.keys(getAuth().options);
    expect(optionKeys).not.toContain("socialProviders");
    expect(optionKeys).not.toContain("plugins");
  });

  it("sendVerificationEmail dispatches through the provider-neutral email adapter with the verify-email template", async () => {
    const { getAuth } = await import("@/modules/auth/server");
    const { sendVerificationEmail } = getAuth().options.emailVerification ?? {};
    await sendVerificationEmail?.({
      user: { email: "learner@example.com" } as never,
      url: "http://localhost:3000/api/auth/verify-email?token=abc",
      token: "abc",
    });
    expect(sendEmailMock).toHaveBeenCalledWith({
      template: "verify-email",
      to: "learner@example.com",
      url: "http://localhost:3000/api/auth/verify-email?token=abc",
      token: "abc",
    });
  });

  it("sendResetPassword dispatches through the provider-neutral email adapter with the reset-password template", async () => {
    const { getAuth } = await import("@/modules/auth/server");
    const { sendResetPassword } = getAuth().options.emailAndPassword ?? {};
    await sendResetPassword?.({
      user: { email: "learner@example.com" } as never,
      url: "http://localhost:3000/api/auth/reset-password?token=xyz",
      token: "xyz",
    });
    expect(sendEmailMock).toHaveBeenCalledWith({
      template: "reset-password",
      to: "learner@example.com",
      url: "http://localhost:3000/api/auth/reset-password?token=xyz",
      token: "xyz",
    });
  });

  it("sendDeleteAccountVerification dispatches through the provider-neutral email adapter with the delete-account template", async () => {
    const { getAuth } = await import("@/modules/auth/server");
    const { sendDeleteAccountVerification } =
      getAuth().options.user?.deleteUser ?? {};
    await sendDeleteAccountVerification?.({
      user: { email: "learner@example.com" } as never,
      url: "http://localhost:3000/api/auth/delete-user/callback?token=del",
      token: "del",
    });
    expect(sendEmailMock).toHaveBeenCalledWith({
      template: "delete-account",
      to: "learner@example.com",
      url: "http://localhost:3000/api/auth/delete-user/callback?token=del",
      token: "del",
    });
  });

  describe("email delivery does not gate the response (enumeration-timing fix)", () => {
    // The fake transport below never resolves until the test explicitly
    // calls `resolve()` — this threshold only needs to be far below any
    // real resolution delay while staying generous enough to avoid CI
    // scheduling jitter, since the transport is deliberately still pending
    // when this assertion runs.
    const MAX_ACCEPTABLE_CALLBACK_MS = 100;

    function slowFakeTransport(): {
      promise: Promise<{ success: true; messageId: string }>;
      resolve: () => void;
    } {
      let resolve!: () => void;
      const promise = new Promise<{ success: true; messageId: string }>(
        (res) => {
          resolve = () => res({ success: true, messageId: "slow-id" });
        },
      );
      return { promise, resolve };
    }

    it("sendResetPassword resolves immediately even though the transport has not delivered yet", async () => {
      const slow = slowFakeTransport();
      sendEmailMock.mockReturnValueOnce(slow.promise);
      const { getAuth } = await import("@/modules/auth/server");
      const { flushPendingEmails } = await import("@/modules/email/dispatch");
      const { sendResetPassword } = getAuth().options.emailAndPassword ?? {};

      const start = Date.now();
      await sendResetPassword?.({
        user: { email: "learner@example.com" } as never,
        url: "http://localhost:3000/api/auth/reset-password?token=xyz",
        token: "xyz",
      });
      expect(Date.now() - start).toBeLessThan(MAX_ACCEPTABLE_CALLBACK_MS);
      // The send was still actually STARTED, not skipped — only its
      // completion isn't awaited.
      expect(sendEmailMock).toHaveBeenCalled();

      slow.resolve();
      await flushPendingEmails();
    });

    it("sendVerificationEmail resolves immediately even though the transport has not delivered yet", async () => {
      const slow = slowFakeTransport();
      sendEmailMock.mockReturnValueOnce(slow.promise);
      const { getAuth } = await import("@/modules/auth/server");
      const { flushPendingEmails } = await import("@/modules/email/dispatch");
      const { sendVerificationEmail } =
        getAuth().options.emailVerification ?? {};

      const start = Date.now();
      await sendVerificationEmail?.({
        user: { email: "learner@example.com" } as never,
        url: "http://localhost:3000/api/auth/verify-email?token=abc",
        token: "abc",
      });
      expect(Date.now() - start).toBeLessThan(MAX_ACCEPTABLE_CALLBACK_MS);
      expect(sendEmailMock).toHaveBeenCalled();

      slow.resolve();
      await flushPendingEmails();
    });

    it("sendDeleteAccountVerification resolves immediately even though the transport has not delivered yet", async () => {
      const slow = slowFakeTransport();
      sendEmailMock.mockReturnValueOnce(slow.promise);
      const { getAuth } = await import("@/modules/auth/server");
      const { flushPendingEmails } = await import("@/modules/email/dispatch");
      const { sendDeleteAccountVerification } =
        getAuth().options.user?.deleteUser ?? {};

      const start = Date.now();
      await sendDeleteAccountVerification?.({
        user: { email: "learner@example.com" } as never,
        url: "http://localhost:3000/api/auth/delete-user/callback?token=del",
        token: "del",
      });
      expect(Date.now() - start).toBeLessThan(MAX_ACCEPTABLE_CALLBACK_MS);
      expect(sendEmailMock).toHaveBeenCalled();

      slow.resolve();
      await flushPendingEmails();
    });

    it("a rejected send is swallowed, never surfacing to the Better Auth callback", async () => {
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      sendEmailMock.mockRejectedValueOnce(new Error("provider unavailable"));
      const { getAuth } = await import("@/modules/auth/server");
      const { flushPendingEmails } = await import("@/modules/email/dispatch");
      const { sendResetPassword } = getAuth().options.emailAndPassword ?? {};

      await expect(
        sendResetPassword?.({
          user: { email: "learner@example.com" } as never,
          url: "http://localhost:3000/api/auth/reset-password?token=xyz",
          token: "xyz",
        }),
      ).resolves.not.toThrow();

      await flushPendingEmails();
      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });
});
