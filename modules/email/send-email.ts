/**
 * Provider-neutral send-email entry point (Phase 15, phases-15.md §39).
 * The only module Better Auth callbacks (T11) should import — never a
 * specific transport. Dispatches to the transport configured by
 * `EMAIL_TRANSPORT` (validated once, fail-closed, by
 * `modules/env/server.ts`).
 */
import "server-only";
import { createHash } from "node:crypto";
import { assertSameOrigin } from "@/modules/email/link-safety";
import { createConsoleFileTransport } from "@/modules/email/transports/console-file";
import { createResendTransport } from "@/modules/email/transports/resend";
import type {
  EmailTemplate,
  EmailTransport,
  SendEmailResult,
} from "@/modules/email/types";
import { getServerEnv } from "@/modules/env/server";

export type SendEmailParams = {
  template: EmailTemplate;
  to: string;
  /** The link embedded in the email — must be same-origin as the app. */
  url: string;
  /**
   * The verification/reset/deletion token this email is for — combined
   * with `template`+`to` to derive a stable, distinct idempotency key per
   * (template, recipient, token) triple, so a retried send for the exact
   * same request reuses one key while a fresh request always gets a new
   * one. Never logged or forwarded to the transport directly (the
   * transport only receives the derived hash).
   */
  token: string;
};

let cachedTransport: EmailTransport | undefined;

function getTransport(): EmailTransport {
  if (cachedTransport) return cachedTransport;
  const env = getServerEnv();
  switch (env.emailTransport) {
    case "console-file":
      cachedTransport = createConsoleFileTransport({
        outboxDir: env.emailOutboxDir,
      });
      return cachedTransport;
    case "resend": {
      // modules/env/server.ts only REQUIRES these in production (its
      // assertProductionInvariants check) — a non-production environment
      // that sets EMAIL_TRANSPORT=resend without them must still fail
      // closed here with a clear config error, not a confusing downstream
      // Resend client error.
      if (!env.resendApiKey) {
        throw new Error(
          "RESEND_API_KEY is required when EMAIL_TRANSPORT=resend",
        );
      }
      if (!env.emailFrom) {
        throw new Error("EMAIL_FROM is required when EMAIL_TRANSPORT=resend");
      }
      cachedTransport = createResendTransport({
        apiKey: env.resendApiKey,
        from: env.emailFrom,
      });
      return cachedTransport;
    }
    default: {
      const exhaustive: never = env.emailTransport;
      throw new Error(`Unsupported EMAIL_TRANSPORT: ${String(exhaustive)}`);
    }
  }
}

function buildIdempotencyKey(
  template: EmailTemplate,
  to: string,
  token: string,
): string {
  return createHash("sha256")
    .update(`${template}:${to.toLowerCase()}:${token}`)
    .digest("hex");
}

export async function sendEmail(
  params: SendEmailParams,
): Promise<SendEmailResult> {
  const env = getServerEnv();
  assertSameOrigin(params.url, env.appUrl);

  const idempotencyKey = buildIdempotencyKey(
    params.template,
    params.to,
    params.token,
  );
  const transport = getTransport();
  return transport.send({
    template: params.template,
    to: params.to,
    data: { url: params.url },
    idempotencyKey,
  });
}

/** Test-only: force a fresh transport lookup on the next `sendEmail()` call. */
export function resetEmailTransportCacheForTests(): void {
  cachedTransport = undefined;
}
