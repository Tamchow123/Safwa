import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { SMTPTransportOptions } from "nodemailer";

import {
  createSmtpTransport,
  type SmtpMailer,
  type SmtpTransportOptions,
} from "@/modules/email/transports/smtp";
import type { SendEmailInput } from "@/modules/email/types";

const TOKEN = "live-secret-token";
const PASSWORD = "app-password-must-not-leak";

const BASE_INPUT: SendEmailInput = {
  template: "verify-email",
  to: "learner@example.com",
  data: { url: `https://safwa.example.com/verify-email?token=${TOKEN}` },
  idempotencyKey: "a".repeat(64),
};

type SendMail = SmtpMailer["sendMail"];

/**
 * Builds a transport around a fake mailer, capturing the config nodemailer
 * would have been handed. Every test in this file goes through here, so the
 * real `createTransport` — and with it any socket — is never reached.
 */
function setup(
  sendMail: SendMail,
  overrides: Partial<SmtpTransportOptions> = {},
) {
  const configs: SMTPTransportOptions[] = [];
  const sendMailMock = vi.fn(sendMail);
  const transport = createSmtpTransport({
    host: "smtp.example.com",
    port: 465,
    user: "mailer@example.com",
    password: PASSWORD,
    from: "Safwa <mailer@example.com>",
    createMailer: (config) => {
      configs.push(config);
      return { sendMail: sendMailMock };
    },
    ...overrides,
  });
  return { transport, sendMailMock, configs };
}

const accepted: SendMail = async () => ({
  messageId: "<server-id@example.com>",
  accepted: ["learner@example.com"],
});

describe("createSmtpTransport — connection security", () => {
  it("uses TLS from the first byte on port 465, with the certificate verified", () => {
    const { configs } = setup(accepted, { port: 465 });
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    });
  });

  it("requires STARTTLS on port 587 rather than upgrading opportunistically", () => {
    const { configs } = setup(accepted, { port: 587 });
    expect(configs[0]).toMatchObject({
      port: 587,
      secure: false,
      requireTLS: true,
      tls: { rejectUnauthorized: true },
    });
    // requireTLS takes precedence over both of these; neither may be set to
    // weaken it.
    expect(configs[0].ignoreTLS).not.toBe(true);
    expect(configs[0].opportunisticTLS).not.toBe(true);
  });

  it("authenticates with the configured account", () => {
    const { configs } = setup(accepted);
    expect(configs[0].auth).toEqual({
      user: "mailer@example.com",
      pass: PASSWORD,
    });
  });

  it("opens no pool, and bounds every connection phase", () => {
    const { configs } = setup(accepted);
    expect(configs[0].pool).toBe(false);
    for (const timeout of [
      "connectionTimeout",
      "greetingTimeout",
      "socketTimeout",
    ] as const) {
      expect(configs[0][timeout], timeout).toBeGreaterThan(0);
      expect(configs[0][timeout], timeout).toBeLessThanOrEqual(10_000);
    }
  });

  it("keeps nodemailer's own logging off, since it prints addresses and bodies", () => {
    const { configs } = setup(accepted);
    expect(configs[0].logger).toBe(false);
    expect(configs[0].debug).toBe(false);
  });
});

describe("createSmtpTransport — sending", () => {
  it("sends the rendered message from the configured sender to the recipient", async () => {
    const { transport, sendMailMock } = setup(accepted);

    const result = await transport.send(BASE_INPUT);

    expect(result).toEqual({
      success: true,
      messageId: "<server-id@example.com>",
    });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const [message] = sendMailMock.mock.calls[0];
    expect(message.from).toBe("Safwa <mailer@example.com>");
    expect(message.to).toBe("learner@example.com");
    expect(message.subject).toMatch(/verify/i);
    expect(message.html).toContain(BASE_INPUT.data.url);
    expect(message.text).toContain(BASE_INPUT.data.url);
  });

  it("derives the Message-ID from the idempotency key and the sender's domain", async () => {
    const { transport, sendMailMock } = setup(accepted);
    await transport.send(BASE_INPUT);
    expect(sendMailMock.mock.calls[0][0].messageId).toBe(
      `<${BASE_INPUT.idempotencyKey}@example.com>`,
    );
  });

  it("gives the same send the same Message-ID, and a different key a different one", async () => {
    const { transport, sendMailMock } = setup(accepted);
    await transport.send(BASE_INPUT);
    await transport.send(BASE_INPUT);
    await transport.send({ ...BASE_INPUT, idempotencyKey: "b".repeat(64) });
    const ids = sendMailMock.mock.calls.map(([message]) => message.messageId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("never puts the raw token in the Message-ID", async () => {
    const { transport, sendMailMock } = setup(accepted);
    await transport.send(BASE_INPUT);
    expect(sendMailMock.mock.calls[0][0].messageId).not.toContain(TOKEN);
  });

  it("leaves the Message-ID to nodemailer when the sender has no domain", async () => {
    const { transport, sendMailMock } = setup(accepted, { from: "Safwa" });
    await transport.send(BASE_INPUT);
    expect(sendMailMock.mock.calls[0][0].messageId).toBeUndefined();
  });

  it("treats a send the server accepted for no recipient as a failure", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { transport } = setup(async () => ({
        messageId: "<x@example.com>",
        accepted: [],
      }));
      expect(await transport.send(BASE_INPUT)).toEqual({
        success: false,
        error: "Failed to send email",
      });
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("createSmtpTransport — failures", () => {
  it("maps a server rejection to the generic result and logs only its codes", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // nodemailer folds the raw server reply into `message`, and a rejection
      // reply can quote the recipient — so it is exactly what must not be
      // logged, while the codes are what an operator needs.
      const rejection = Object.assign(
        new Error(
          `Invalid login: 535-5.7.8 learner@example.com ${PASSWORD} ${TOKEN}`,
        ),
        { code: "EAUTH", responseCode: 535, response: "535 5.7.8 rejected" },
      );
      const { transport } = setup(async () => {
        throw rejection;
      });

      const result = await transport.send(BASE_INPUT);

      expect(result).toEqual({ success: false, error: "Failed to send email" });
      expect(logSpy).toHaveBeenCalledTimes(1);
      const logged = logSpy.mock.calls[0].join(" ");
      expect(logged).toContain("verify-email");
      expect(logged).toContain("EAUTH");
      expect(logged).toContain("535");
      for (const secret of [
        "learner@example.com",
        PASSWORD,
        TOKEN,
        BASE_INPUT.idempotencyKey,
        "Invalid login",
      ]) {
        expect(logged, secret).not.toContain(secret);
      }
    } finally {
      logSpy.mockRestore();
    }
  });

  it("returns the generic result, never a rejection, when rendering fails", async () => {
    // EmailTransport reports failure as a value. A rejection would bypass this
    // file's redaction and land in dispatch.ts's catch-all, which logs the raw
    // error — so a render failure must stay on the same path as a send failure.
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { transport, sendMailMock } = setup(accepted);
      // No `url`: the link template cannot render without one.
      const result = await transport.send({ ...BASE_INPUT, data: {} });
      expect(result).toEqual({ success: false, error: "Failed to send email" });
      expect(sendMailMock).not.toHaveBeenCalled();
      expect(logSpy.mock.calls[0].join(" ")).toContain("verify-email");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("does not count a failed render against the in-flight cap", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { transport } = setup(accepted);
      for (let i = 0; i < 25; i += 1) {
        await transport.send({ ...BASE_INPUT, data: {} });
      }
      expect(await transport.send(BASE_INPUT)).toEqual({
        success: true,
        messageId: "<server-id@example.com>",
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("survives a thrown non-Error without leaking anything", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { transport } = setup(() => Promise.reject(`boom ${TOKEN}`));
      expect(await transport.send(BASE_INPUT)).toEqual({
        success: false,
        error: "Failed to send email",
      });
      expect(logSpy.mock.calls[0].join(" ")).not.toContain(TOKEN);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("fails closed (does not hang) when the server never answers", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { transport } = setup(() => new Promise<never>(() => {}));

      const resultPromise = transport.send(BASE_INPUT);
      await vi.advanceTimersByTimeAsync(10_001);
      const result = await resultPromise;

      expect(result).toEqual({ success: false, error: "Failed to send email" });
      expect(logSpy.mock.calls[0].join(" ")).toContain("TIMEOUT");
    } finally {
      logSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("fails fast once 20 sends are in flight, without calling the server again", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      type Info = Awaited<ReturnType<SendMail>>;
      const resolvers: Array<(value: Info) => void> = [];
      const info: Info = {
        messageId: "<drained@example.com>",
        accepted: ["learner@example.com"],
      };
      // Only the first 20 calls stay pending, to fill the cap; anything after
      // resolves at once, so the post-drain send is not itself left hanging.
      const { transport, sendMailMock } = setup(() =>
        resolvers.length < 20
          ? new Promise<Info>((resolve) => {
              resolvers.push(resolve);
            })
          : Promise.resolve(info),
      );

      const inFlight = Array.from({ length: 20 }, () =>
        transport.send(BASE_INPUT),
      );
      expect(sendMailMock).toHaveBeenCalledTimes(20);

      expect(await transport.send(BASE_INPUT)).toEqual({
        success: false,
        error: "Failed to send email",
      });
      expect(sendMailMock).toHaveBeenCalledTimes(20);

      resolvers.forEach((resolve) => resolve(info));
      await Promise.all(inFlight);

      expect(await transport.send(BASE_INPUT)).toEqual({
        success: true,
        messageId: "<drained@example.com>",
      });
      expect(sendMailMock).toHaveBeenCalledTimes(21);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("frees a slot when a send fails, not only when it succeeds", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let fail = true;
      const { transport } = setup(async () => {
        if (fail) throw Object.assign(new Error("x"), { code: "ESOCKET" });
        return { messageId: "<ok@example.com>", accepted: ["a@example.com"] };
      });
      for (let i = 0; i < 25; i += 1) await transport.send(BASE_INPUT);
      fail = false;
      expect(await transport.send(BASE_INPUT)).toEqual({
        success: true,
        messageId: "<ok@example.com>",
      });
    } finally {
      logSpy.mockRestore();
    }
  });
});
