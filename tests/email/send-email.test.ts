import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const sendMock = vi.fn<(input: SendEmailInput) => Promise<SendEmailResult>>(
  async () => ({
    success: true,
    messageId: "mock-id",
  }),
);
vi.mock("@/modules/email/transports/console-file", () => ({
  createConsoleFileTransport: vi.fn(() => ({ send: sendMock })),
}));

const smtpSendMock = vi.fn<(input: SendEmailInput) => Promise<SendEmailResult>>(
  async () => ({
    success: true,
    messageId: "smtp-mock-id",
  }),
);
const createSmtpTransportMock = vi.fn<
  (options: SmtpTransportOptions) => { send: typeof smtpSendMock }
>(() => ({ send: smtpSendMock }));
vi.mock("@/modules/email/transports/smtp", () => ({
  createSmtpTransport: (options: SmtpTransportOptions) =>
    createSmtpTransportMock(options),
}));

import { UnsafeEmailLinkError } from "@/modules/email/link-safety";
import type { SmtpTransportOptions } from "@/modules/email/transports/smtp";
import { SMTP_REQUIRED_ENV } from "@/modules/env/rules";
import type { SendEmailInput, SendEmailResult } from "@/modules/email/types";
import {
  resetEmailTransportCacheForTests,
  sendEmail,
} from "@/modules/email/send-email";
import { resetServerEnvCacheForTests } from "@/modules/env/server";

const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://user:pass@localhost:5432/db",
  BETTER_AUTH_SECRET: "test-secret-not-real-but-long-enough-for-tests",
  BETTER_AUTH_URL: "https://safwa.example.com",
  NEXT_PUBLIC_APP_URL: "https://safwa.example.com",
  EMAIL_TRANSPORT: "console-file",
};

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  Object.assign(process.env, BASE_ENV);
  resetServerEnvCacheForTests();
  resetEmailTransportCacheForTests();
  sendMock.mockClear();
  smtpSendMock.mockClear();
  createSmtpTransportMock.mockClear();
});

/** Points the next sendEmail() at EMAIL_TRANSPORT=smtp with these settings. */
function useSmtp(settings: Record<string, string | undefined>) {
  process.env.EMAIL_TRANSPORT = "smtp";
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetServerEnvCacheForTests();
  resetEmailTransportCacheForTests();
}

const SMTP_SETTINGS = {
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "587",
  SMTP_USER: "mailer@example.com",
  SMTP_PASSWORD: "app-password-not-real",
  EMAIL_FROM: "Safwa <mailer@example.com>",
};

afterEach(() => {
  process.env = originalEnv;
  resetServerEnvCacheForTests();
  resetEmailTransportCacheForTests();
});

describe("sendEmail", () => {
  it("dispatches to the configured transport with a derived idempotency key", async () => {
    await sendEmail({
      template: "verify-email",
      to: "learner@example.com",
      url: "https://safwa.example.com/verify-email?token=abc",
      token: "abc",
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [input] = sendMock.mock.calls[0];
    expect(input.template).toBe("verify-email");
    expect(input.to).toBe("learner@example.com");
    expect(input.data).toEqual({
      url: "https://safwa.example.com/verify-email?token=abc",
    });
    expect(input.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("derives the SAME idempotency key for the same template+recipient+token", async () => {
    await sendEmail({
      template: "verify-email",
      to: "learner@example.com",
      url: "https://safwa.example.com/x",
      token: "tok-1",
    });
    await sendEmail({
      template: "verify-email",
      to: "learner@example.com",
      url: "https://safwa.example.com/x",
      token: "tok-1",
    });
    const keys = sendMock.mock.calls.map((call) => call[0].idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
  });

  it("derives the same idempotency key regardless of recipient casing", async () => {
    await sendEmail({
      template: "verify-email",
      to: "Learner@Example.com",
      url: "https://safwa.example.com/x",
      token: "tok-2",
    });
    await sendEmail({
      template: "verify-email",
      to: "learner@example.com",
      url: "https://safwa.example.com/x",
      token: "tok-2",
    });
    const keys = sendMock.mock.calls.map((call) => call[0].idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
  });

  it("derives a DIFFERENT idempotency key for a different token", async () => {
    await sendEmail({
      template: "verify-email",
      to: "learner@example.com",
      url: "https://safwa.example.com/x",
      token: "tok-a",
    });
    await sendEmail({
      template: "verify-email",
      to: "learner@example.com",
      url: "https://safwa.example.com/x",
      token: "tok-b",
    });
    const keys = sendMock.mock.calls.map((call) => call[0].idempotencyKey);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("derives a DIFFERENT idempotency key for a different template", async () => {
    await sendEmail({
      template: "verify-email",
      to: "learner@example.com",
      url: "https://safwa.example.com/x",
      token: "tok-same",
    });
    await sendEmail({
      template: "reset-password",
      to: "learner@example.com",
      url: "https://safwa.example.com/x",
      token: "tok-same",
    });
    const keys = sendMock.mock.calls.map((call) => call[0].idempotencyKey);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("rejects a url whose origin does not match the canonical app origin, before ever calling the transport", async () => {
    await expect(
      sendEmail({
        template: "verify-email",
        to: "learner@example.com",
        url: "https://evil.example.com/verify-email?token=abc",
        token: "abc",
      }),
    ).rejects.toThrow(UnsafeEmailLinkError);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("dispatches to the SMTP transport, built from the configured server, account and sender, when EMAIL_TRANSPORT=smtp", async () => {
    useSmtp(SMTP_SETTINGS);

    const result = await sendEmail({
      template: "verify-email",
      to: "learner@example.com",
      url: "https://safwa.example.com/verify-email?token=abc",
      token: "abc",
    });

    expect(result).toEqual({ success: true, messageId: "smtp-mock-id" });
    expect(createSmtpTransportMock).toHaveBeenCalledWith({
      host: "smtp.example.com",
      port: 587,
      user: "mailer@example.com",
      password: "app-password-not-real",
      from: "Safwa <mailer@example.com>",
    });
    expect(smtpSendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("names every missing SMTP setting, and never a configured value, before building the transport", async () => {
    useSmtp({
      ...SMTP_SETTINGS,
      SMTP_PORT: undefined,
      SMTP_USER: undefined,
      EMAIL_FROM: undefined,
    });

    const attempt = sendEmail({
      template: "verify-email",
      to: "learner@example.com",
      url: "https://safwa.example.com/verify-email?token=abc",
      token: "abc",
    });

    await expect(attempt).rejects.toThrow(
      /EMAIL_TRANSPORT=smtp requires SMTP_PORT, SMTP_USER, EMAIL_FROM/,
    );
    const message = String(await attempt.catch((error: unknown) => error));
    expect(message).not.toContain(SMTP_SETTINGS.SMTP_PASSWORD);
    expect(message).not.toContain(SMTP_SETTINGS.SMTP_HOST);
    expect(createSmtpTransportMock).not.toHaveBeenCalled();
  });

  it("names every setting in the shared SMTP_REQUIRED_ENV list when none is configured", async () => {
    // The runtime and pre-deploy validators read the same list; this pins the
    // third reader, so the three cannot disagree about what SMTP needs.
    useSmtp(
      Object.fromEntries(SMTP_REQUIRED_ENV.map((name) => [name, undefined])),
    );

    await expect(
      sendEmail({
        template: "verify-email",
        to: "learner@example.com",
        url: "https://safwa.example.com/verify-email?token=abc",
        token: "abc",
      }),
    ).rejects.toThrow(
      `EMAIL_TRANSPORT=smtp requires ${SMTP_REQUIRED_ENV.join(", ")} to be set`,
    );
  });

  it("refuses EMAIL_TRANSPORT=resend, which no longer exists, before sending anything", async () => {
    // Phase 18.2 removed the Resend transport. An environment still naming it
    // must fail at validation, not fall through to some other transport.
    process.env.EMAIL_TRANSPORT = "resend";
    resetServerEnvCacheForTests();
    resetEmailTransportCacheForTests();

    await expect(
      sendEmail({
        template: "verify-email",
        to: "learner@example.com",
        url: "https://safwa.example.com/verify-email?token=abc",
        token: "abc",
      }),
    ).rejects.toThrow(/EMAIL_TRANSPORT/);
    expect(sendMock).not.toHaveBeenCalled();
    expect(createSmtpTransportMock).not.toHaveBeenCalled();
  });
});
