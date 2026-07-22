/**
 * Production/preview email transport (Phase 15, phases-15.md §41) — the
 * real Resend transport behind the provider-neutral `EmailTransport`
 * interface (modules/email/types.ts). Never imported from browser code
 * (server-only), and never constructed directly by tests — they inject a
 * fake `client` instead, so no unit/integration test ever makes a real
 * network call.
 *
 * Retry policy: exactly one attempt, bounded by `SEND_TIMEOUT_MS`. No
 * indefinite retry loop inside a request — a caller (e.g. a Better Auth
 * callback, T11) that wants a retry does so as its own explicit decision,
 * never silently inside this transport.
 *
 * Timeout is a bound on how long the CALLER waits, not on the underlying
 * request's lifetime: the installed `resend` SDK (6.17.2) exposes no
 * cancellation/AbortSignal hook (`ResendOptions` only accepts
 * `baseUrl`/`userAgent`), so a straggler HTTP request keeps running in the
 * background after this function has already reported failure. To bound
 * the resource impact of that during a sustained provider slowdown (many
 * abandoned requests piling up in the shared HTTP agent), `send()` caps
 * the number of concurrently in-flight real requests at
 * `MAX_IN_FLIGHT_REQUESTS` — once that cap is hit, further calls fail fast
 * with the same generic result instead of adding another straggler.
 */
import "server-only";
import { Resend } from "resend";
import { renderEmail } from "@/modules/email/templates";
import type {
  EmailTransport,
  SendEmailInput,
  SendEmailResult,
} from "@/modules/email/types";

const SEND_TIMEOUT_MS = 10_000;
const MAX_IN_FLIGHT_REQUESTS = 20;

type ResendEmailsClient = {
  send: InstanceType<typeof Resend>["emails"]["send"];
};

export type ResendTransportOptions = {
  apiKey: string;
  from: string;
  /** Injectable for tests — the only sanctioned way to avoid a real Resend client. */
  client?: ResendEmailsClient;
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Resend request timed out after ${ms}ms`)),
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

export function createResendTransport(
  options: ResendTransportOptions,
): EmailTransport {
  const client: ResendEmailsClient =
    options.client ?? new Resend(options.apiKey).emails;

  let inFlightCount = 0;

  return {
    async send(input: SendEmailInput): Promise<SendEmailResult> {
      if (inFlightCount >= MAX_IN_FLIGHT_REQUESTS) {
        console.error(
          `[email:resend] ${MAX_IN_FLIGHT_REQUESTS} requests already in flight; rejecting template ${input.template} to avoid unbounded resource use during a provider slowdown`,
        );
        return { success: false, error: "Failed to send email" };
      }

      const rendered = renderEmail(input.template, input.data);

      // Tracked against the REAL request's own settlement, not the
      // timeout race below — so a straggler still counts toward the
      // in-flight cap for as long as it actually runs.
      inFlightCount += 1;
      const trackedSend = client
        .send(
          {
            from: options.from,
            to: input.to,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
          },
          { idempotencyKey: input.idempotencyKey },
        )
        .finally(() => {
          inFlightCount -= 1;
        });

      let response;
      try {
        response = await withTimeout(trackedSend, SEND_TIMEOUT_MS);
      } catch (error) {
        // Never log the rendered body, recipient, or idempotency key —
        // only the template name and a generic failure reason.
        console.error(
          `[email:resend] send failed for template ${input.template}:`,
          error instanceof Error ? error.message : "unknown error",
        );
        return { success: false, error: "Failed to send email" };
      }

      if (response.error) {
        // Log only the provider's structured error code/status — never
        // `.message`, which could restate request details.
        console.error(
          `[email:resend] provider error for template ${input.template}: ${response.error.name} (status ${response.error.statusCode ?? "unknown"})`,
        );
        return { success: false, error: "Failed to send email" };
      }

      return { success: true, messageId: response.data.id };
    },
  };
}
