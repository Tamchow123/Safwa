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

import { UnsafeEmailLinkError } from "@/modules/email/link-safety";
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
});

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

  it("throws a clear not-yet-available error for EMAIL_TRANSPORT=resend", async () => {
    process.env.EMAIL_TRANSPORT = "resend";
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.EMAIL_FROM = "noreply@safwa.example.com";
    resetServerEnvCacheForTests();
    resetEmailTransportCacheForTests();
    await expect(
      sendEmail({
        template: "verify-email",
        to: "learner@example.com",
        url: "https://safwa.example.com/verify-email?token=abc",
        token: "abc",
      }),
    ).rejects.toThrow(/not yet available/);
  });
});
