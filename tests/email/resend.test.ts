import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createResendTransport } from "@/modules/email/transports/resend";
import type { SendEmailInput } from "@/modules/email/types";

const BASE_INPUT: SendEmailInput = {
  template: "verify-email",
  to: "learner@example.com",
  data: {
    url: "https://safwa.example.com/verify-email?token=live-secret-token",
  },
  idempotencyKey: "idem-key-1",
};

describe("createResendTransport", () => {
  it("sends with the configured sender, recipient, rendered content, and idempotency key as the second argument", async () => {
    const sendMock = vi.fn().mockResolvedValue({
      data: { id: "resend-id-1" },
      error: null,
      headers: null,
    });
    const transport = createResendTransport({
      apiKey: "re_test_key",
      from: "noreply@safwa.example.com",
      client: { send: sendMock },
    });

    const result = await transport.send(BASE_INPUT);

    expect(result).toEqual({ success: true, messageId: "resend-id-1" });
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [payload, options] = sendMock.mock.calls[0];
    expect(payload.from).toBe("noreply@safwa.example.com");
    expect(payload.to).toBe("learner@example.com");
    expect(payload.subject).toMatch(/verify/i);
    expect(payload.html).toContain(BASE_INPUT.data.url);
    expect(options).toEqual({ idempotencyKey: "idem-key-1" });
  });

  it("maps a provider error response to a safe generic result without leaking the provider message", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const sendMock = vi.fn().mockResolvedValue({
        data: null,
        error: {
          message: "some internal provider detail that must not leak",
          statusCode: 422,
          name: "validation_error",
        },
        headers: null,
      });
      const transport = createResendTransport({
        apiKey: "re_test_key",
        from: "noreply@safwa.example.com",
        client: { send: sendMock },
      });

      const result = await transport.send(BASE_INPUT);

      expect(result).toEqual({ success: false, error: "Failed to send email" });
      expect(logSpy).toHaveBeenCalledTimes(1);
      const loggedArgs = logSpy.mock.calls[0].join(" ");
      expect(loggedArgs).not.toContain(
        "some internal provider detail that must not leak",
      );
      expect(loggedArgs).toContain("validation_error");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("maps a thrown network/client error to a safe generic result without leaking the rendered body or token", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const sendMock = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
      const transport = createResendTransport({
        apiKey: "re_test_key",
        from: "noreply@safwa.example.com",
        client: { send: sendMock },
      });

      const result = await transport.send(BASE_INPUT);

      expect(result).toEqual({ success: false, error: "Failed to send email" });
      const loggedArgs = logSpy.mock.calls[0].join(" ");
      expect(loggedArgs).not.toContain("live-secret-token");
      expect(loggedArgs).not.toContain(BASE_INPUT.idempotencyKey);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("fails closed (does not hang) when the provider never responds", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const sendMock = vi.fn(
        (): Promise<never> => new Promise<never>(() => {}), // never resolves
      );
      const transport = createResendTransport({
        apiKey: "re_test_key",
        from: "noreply@safwa.example.com",
        client: { send: sendMock },
      });

      const resultPromise = transport.send(BASE_INPUT);
      await vi.advanceTimersByTimeAsync(11_000);
      const result = await resultPromise;

      expect(result).toEqual({ success: false, error: "Failed to send email" });
    } finally {
      logSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("fails fast once MAX_IN_FLIGHT_REQUESTS concurrent requests are outstanding, without calling the client again", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      type ResendReply = {
        data: { id: string };
        error: null;
        headers: null;
      };
      const resolvers: Array<(value: ResendReply) => void> = [];
      // Only the first 20 calls stay pending (to fill the in-flight cap);
      // any call beyond that resolves immediately, so the post-drain
      // "afterDrain" send below isn't itself left hanging forever.
      const sendMock = vi.fn(() => {
        if (resolvers.length < 20) {
          return new Promise<ResendReply>((resolve) => {
            resolvers.push(resolve);
          });
        }
        return Promise.resolve<ResendReply>({
          data: { id: "resend-id-drained" },
          error: null,
          headers: null,
        });
      });
      const transport = createResendTransport({
        apiKey: "re_test_key",
        from: "noreply@safwa.example.com",
        client: { send: sendMock },
      });

      // 20 concurrent sends, none resolved yet — each synchronously
      // reaches client.send() before this loop finishes.
      const inFlight = Array.from({ length: 20 }, () =>
        transport.send(BASE_INPUT),
      );
      expect(sendMock).toHaveBeenCalledTimes(20);

      // The 21st call must fail fast without invoking the client again.
      const overflowResult = await transport.send(BASE_INPUT);
      expect(overflowResult).toEqual({
        success: false,
        error: "Failed to send email",
      });
      expect(sendMock).toHaveBeenCalledTimes(20);

      // Draining the in-flight requests frees capacity for a new send.
      resolvers.forEach((resolve) =>
        resolve({
          data: { id: "resend-id-drained" },
          error: null,
          headers: null,
        }),
      );
      await Promise.all(inFlight);

      const afterDrain = await transport.send(BASE_INPUT);
      expect(afterDrain).toEqual({
        success: true,
        messageId: "resend-id-drained",
      });
      expect(sendMock).toHaveBeenCalledTimes(21);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("never calls a real Resend client — only the injected fake is ever invoked", async () => {
    const sendMock = vi.fn().mockResolvedValue({
      data: { id: "resend-id-2" },
      error: null,
      headers: null,
    });
    const transport = createResendTransport({
      apiKey: "re_test_key",
      from: "noreply@safwa.example.com",
      client: { send: sendMock },
    });
    await transport.send(BASE_INPUT);
    // The only network-shaped call in this entire test file is this mock.
    expect(sendMock).toHaveBeenCalled();
  });
});
