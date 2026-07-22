/**
 * Provider-neutral email contract (Phase 15, phases-15.md §39). Better
 * Auth callbacks (T11) depend on this interface, never on a specific
 * provider — auth configuration never directly instantiates Resend.
 * Deliberately has no `server-only` marker: it is pure types, safe to
 * import from anywhere (though only server code ever will in practice).
 */

export type EmailTemplate =
  "verify-email" | "reset-password" | "delete-account";

export type SendEmailInput = {
  template: EmailTemplate;
  to: string;
  data: Record<string, string>;
  idempotencyKey: string;
};

export type SendEmailResult =
  { success: true; messageId: string } | { success: false; error: string };

export interface EmailTransport {
  send(input: SendEmailInput): Promise<SendEmailResult>;
}
