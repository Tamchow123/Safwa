/**
 * Deterministic dev/test email transport (Phase 15, phases-15.md §40).
 * Never calls a real provider — writes each message atomically to a
 * configured outbox directory instead, so local development and
 * integration tests can inspect what would have been sent programmatically
 * rather than parsing terminal output.
 *
 * Production use is blocked exactly once, at the single source of truth
 * for that policy — `modules/env/server.ts`'s `assertProductionInvariants`
 * (which also honours the `ALLOW_DEV_EMAIL_TRANSPORT_IN_PRODUCTION`
 * escape hatch) — not duplicated here, so the policy can never drift out
 * of sync between two places.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderEmail } from "@/modules/email/templates";
import type {
  EmailTransport,
  SendEmailInput,
  SendEmailResult,
} from "@/modules/email/types";

export type ConsoleFileTransportOptions = {
  outboxDir: string;
  /** Injectable for deterministic tests. */
  now?: () => Date;
  /** Injectable for deterministic tests. */
  generateId?: () => string;
  /** Suppress the local-only console notice — for quiet test output. */
  quiet?: boolean;
};

type OutboxRecord = {
  id: string;
  template: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  createdAt: string;
};

export function createConsoleFileTransport(
  options: ConsoleFileTransportOptions,
): EmailTransport {
  const now = options.now ?? (() => new Date());
  const generateId = options.generateId ?? randomUUID;

  return {
    async send(input: SendEmailInput): Promise<SendEmailResult> {
      const rendered = renderEmail(input.template, input.data);
      const id = generateId();
      const record: OutboxRecord = {
        id,
        template: input.template,
        to: input.to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        createdAt: now().toISOString(),
      };

      await mkdir(options.outboxDir, { recursive: true });
      const finalPath = path.join(options.outboxDir, `${id}.json`);
      // Write-to-temp-then-rename is atomic on the same filesystem — a
      // reader never observes a partially-written outbox file.
      const tmpPath = path.join(options.outboxDir, `.${id}.json.tmp`);
      await writeFile(tmpPath, JSON.stringify(record, null, 2), "utf8");
      await rename(tmpPath, finalPath);

      if (!options.quiet) {
        console.log(
          `[email:console-file] ${input.template} -> ${input.to} (${id})`,
        );
      }

      return { success: true, messageId: id };
    },
  };
}

/** Safe helper to clear a local outbox directory (dev/test only). */
export async function clearOutbox(outboxDir: string): Promise<void> {
  await rm(outboxDir, { recursive: true, force: true });
  await mkdir(outboxDir, { recursive: true });
}
