/**
 * Production email transport (Phase 18.2, ADR-011) — SMTP submission through
 * nodemailer, behind the provider-neutral `EmailTransport` interface
 * (modules/email/types.ts). Any submission server works; docs/DEPLOYMENT.md
 * documents Gmail with an app password, because that needs no domain of one's
 * own. Never imported from browser code (server-only), and never handed a real
 * mailer by tests — they inject `createMailer`, so no test opens a socket.
 *
 * TLS is not configurable. The port decides WHEN encryption starts (465: from
 * the first byte; 587: at STARTTLS, which `requireTLS` makes mandatory rather
 * than opportunistic), never WHETHER — and the server certificate is always
 * verified. There is no plaintext path, in any environment.
 *
 * Retry policy: exactly one attempt, bounded by `SMTP_SEND_TIMEOUT_MS` — the
 * same policy as the Resend transport it replaced. A caller that wants a
 * retry makes that its own explicit decision.
 *
 * The timeout bounds how long the CALLER waits. nodemailer has no per-send
 * abort, so a send that outlives it keeps its socket until nodemailer's own
 * per-phase timeouts close it. Those bound a stalled connection, not a server
 * that keeps trickling bytes, so `send()` also caps concurrently in-flight
 * sends at `MAX_IN_FLIGHT_SENDS`: past that, calls fail fast with the same
 * generic result instead of opening another straggler.
 *
 * No connection pool. A serverless instance is frozen between invocations, so
 * a pooled socket would be dead by the next request; without `pool`, nodemailer
 * opens one connection per message and closes it, and the cached mailer holds
 * configuration only.
 */
import "server-only";
import { createTransport, type SMTPTransportOptions } from "nodemailer";
import { renderEmail } from "@/modules/email/templates";
import type {
  EmailTransport,
  SendEmailInput,
  SendEmailResult,
} from "@/modules/email/types";
import type { SmtpSubmissionPort } from "@/modules/env/rules";

/**
 * Exported because the auth route's `maxDuration` must outlast it: delivery
 * runs inside `after()`, so it shares that function's lifetime
 * (tests/unit/route-time-budget.test.ts ties the two together).
 */
export const SMTP_SEND_TIMEOUT_MS = 10_000;
const CONNECTION_TIMEOUT_MS = 5_000;
const GREETING_TIMEOUT_MS = 5_000;
const SOCKET_TIMEOUT_MS = 10_000;
const MAX_IN_FLIGHT_SENDS = 20;

const FAILURE: SendEmailResult = {
  success: false,
  error: "Failed to send email",
};

type SmtpMessage = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  messageId?: string;
};

/** The one nodemailer surface this transport uses — what tests fake. */
export type SmtpMailer = {
  sendMail(
    message: SmtpMessage,
  ): Promise<{ messageId: string; accepted: readonly unknown[] }>;
};

export type SmtpTransportOptions = {
  host: string;
  port: SmtpSubmissionPort;
  user: string;
  password: string;
  from: string;
  /** Injectable for tests — the only sanctioned way to avoid a real mailer. */
  createMailer?: (config: SMTPTransportOptions) => SmtpMailer;
};

function buildSmtpConfig(
  options: Pick<SmtpTransportOptions, "host" | "port" | "user" | "password">,
): SMTPTransportOptions {
  return {
    host: options.host,
    port: options.port,
    ...(options.port === 465
      ? { secure: true }
      : { secure: false, requireTLS: true }),
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    auth: { user: options.user, pass: options.password },
    pool: false,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    // nodemailer's logger and debug output include addresses and, with debug,
    // the message body — which carries a live verification/reset token.
    logger: false,
    debug: false,
  };
}

/**
 * A deterministic Message-ID from the idempotency key, so a duplicate of the
 * same send is recognisable as one by the receiving mailbox. The key is a hash,
 * never the raw token. `undefined` (nodemailer then generates one) when the
 * sender has no domain to put on the right of the `@`.
 */
function messageIdFor(
  idempotencyKey: string,
  from: string,
): string | undefined {
  const domain = /@([A-Za-z0-9.-]+)>?\s*$/.exec(from)?.[1];
  return domain ? `<${idempotencyKey}@${domain}>` : undefined;
}

/**
 * Only machine-readable codes, never `error.message`: nodemailer folds the raw
 * server reply into the message, and a rejection reply can quote the recipient.
 */
function describeFailure(error: unknown): string {
  if (typeof error !== "object" || error === null) return "code=unknown";
  const { code, responseCode } = error as {
    code?: unknown;
    responseCode?: unknown;
  };
  const codePart = typeof code === "string" ? code : "unknown";
  const smtpPart =
    typeof responseCode === "number" ? ` smtp=${responseCode}` : "";
  return `code=${codePart}${smtpPart}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Object.assign(new Error("timed out"), { code: "TIMEOUT" })),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function createSmtpTransport(
  options: SmtpTransportOptions,
): EmailTransport {
  const createMailer =
    options.createMailer ?? ((config) => createTransport(config));
  const mailer = createMailer(buildSmtpConfig(options));

  let inFlightCount = 0;

  return {
    async send(input: SendEmailInput): Promise<SendEmailResult> {
      if (inFlightCount >= MAX_IN_FLIGHT_SENDS) {
        console.error(
          `[email:smtp] ${MAX_IN_FLIGHT_SENDS} sends already in flight; rejecting template ${input.template} to avoid unbounded resource use during a server slowdown`,
        );
        return FAILURE;
      }

      // Inside the same redacted failure path as the send: a throw escaping
      // here would reach dispatch.ts's catch-all, which logs the raw error.
      let rendered;
      try {
        rendered = renderEmail(input.template, input.data);
      } catch (error) {
        console.error(
          `[email:smtp] could not render template ${input.template}: ${describeFailure(error)}`,
        );
        return FAILURE;
      }

      // Tracked against the REAL send's own settlement, not the timeout race
      // below — so a straggler still counts toward the cap while it runs.
      inFlightCount += 1;
      const trackedSend = mailer
        .sendMail({
          from: options.from,
          to: input.to,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          messageId: messageIdFor(input.idempotencyKey, options.from),
        })
        .finally(() => {
          inFlightCount -= 1;
        });

      let info;
      try {
        info = await withTimeout(trackedSend, SMTP_SEND_TIMEOUT_MS);
      } catch (error) {
        console.error(
          `[email:smtp] send failed for template ${input.template}: ${describeFailure(error)}`,
        );
        return FAILURE;
      }

      if (info.accepted.length === 0) {
        console.error(
          `[email:smtp] server accepted no recipient for template ${input.template}`,
        );
        return FAILURE;
      }

      return { success: true, messageId: info.messageId };
    },
  };
}
