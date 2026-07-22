/**
 * Centralised email copy (Phase 15, phases-15.md §39). Pure and
 * server-agnostic — no `server-only` marker, no env access — so it stays
 * trivially unit-testable and reusable by both the console/file transport
 * (T9) and the Resend transport (T10). Every template interpolates only
 * the caller-supplied `url`, HTML-escaped, into the HTML variant. Rendering
 * only — outbound link safety validation lives in
 * modules/email/link-safety.ts, a separate concern from template copy.
 */
import type { EmailTemplate } from "@/modules/email/types";

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
};

const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const HTML_ESCAPE_PATTERN = /[&<>"']/g;

export function escapeHtml(value: string): string {
  return value.replace(HTML_ESCAPE_PATTERN, (char) => HTML_ESCAPE_MAP[char]);
}

type TemplateRenderer = (data: Record<string, string>) => RenderedEmail;

/**
 * Every current template shares one shape: an intro paragraph, a single
 * link, and a closing disclaimer — so one factory builds both the HTML and
 * plain-text variants from four strings instead of repeating that
 * structure per template.
 */
function createLinkEmailTemplate(spec: {
  subject: string;
  linkText: string;
  intro: string;
  closing: string;
}): TemplateRenderer {
  return (data) => {
    const url = data.url;
    return {
      subject: spec.subject,
      html:
        `<p>${spec.intro}</p>` +
        `<p><a href="${escapeHtml(url)}">${spec.linkText}</a></p>` +
        `<p>${spec.closing}</p>`,
      text: `${spec.intro}\n${url}\n\n${spec.closing}`,
    };
  };
}

const TEMPLATES: Record<EmailTemplate, TemplateRenderer> = {
  "verify-email": createLinkEmailTemplate({
    subject: "Verify your Safwa email address",
    linkText: "Verify email address",
    intro:
      "Welcome to Safwa. Confirm your email address to finish creating your account:",
    closing: "If you did not request this, you can ignore this message.",
  }),
  "reset-password": createLinkEmailTemplate({
    subject: "Reset your Safwa password",
    linkText: "Reset password",
    intro:
      "Use the link below to reset your Safwa password. This link will expire soon:",
    closing:
      "If you did not request this, you can ignore this message and your password will not change.",
  }),
  "delete-account": createLinkEmailTemplate({
    subject: "Confirm Safwa account deletion",
    linkText: "Confirm account deletion",
    intro:
      "Use the link below to confirm permanent deletion of your Safwa account and all associated data:",
    closing: "If you did not request this, you can ignore this message.",
  }),
};

export function renderEmail(
  template: EmailTemplate,
  data: Record<string, string>,
): RenderedEmail {
  return TEMPLATES[template](data);
}
