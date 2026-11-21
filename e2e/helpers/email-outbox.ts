/**
 * Playwright-safe email-outbox reader for the Phase 15 auth E2E suite
 * (phases-15.md §60). Mirrors tests/integration/helpers/email-outbox.ts's
 * logic exactly, but is a from-scratch reimplementation: that file's
 * dependency chain (`modules/env/server.ts`) carries a `server-only`
 * marker Playwright's Node process cannot resolve (no
 * `--conditions=react-server`, no Vitest-style mock) — see
 * e2e/global-setup.ts's docblock for the same constraint.
 *
 * Reads `EMAIL_OUTBOX_DIR` directly from `process.env`, which
 * `e2e/helpers/e2e-server-env.ts` guarantees is set for this process
 * (imported once, as a side effect, via playwright.config.ts).
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { E2E_EMAIL_OUTBOX_DIR } from "./e2e-server-env";

export type OutboxRecord = {
  id: string;
  template: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  createdAt: string;
};

/**
 * Newest first by `createdAt` — the sending server's own clock, stamped as the
 * message was written — with file mtime only as a last tie-break (Phase 18.3).
 * mtime alone can tie on a coarse filesystem, and a tie then falls back to
 * directory order, which is not write order: harmless while callers wanted any
 * message, wrong for one that must tell the second message from the first.
 */
function newestFirst(
  a: { record: OutboxRecord; mtimeMs: number },
  b: { record: OutboxRecord; mtimeMs: number },
): number {
  return (
    Date.parse(b.record.createdAt) - Date.parse(a.record.createdAt) ||
    b.mtimeMs - a.mtimeMs
  );
}

/** Reads the most recently written outbox message for a recipient (and optionally template). */
export async function latestOutboxMessage(
  to: string,
  template?: string,
): Promise<OutboxRecord | null> {
  let files: string[];
  try {
    files = await readdir(E2E_EMAIL_OUTBOX_DIR);
  } catch {
    return null;
  }

  const candidates: { record: OutboxRecord; mtimeMs: number }[] = [];
  for (const file of files) {
    if (!file.endsWith(".json") || file.startsWith(".")) continue;
    const filePath = path.join(E2E_EMAIL_OUTBOX_DIR, file);
    const [content, stats] = await Promise.all([
      readFile(filePath, "utf8"),
      stat(filePath),
    ]);
    const record = JSON.parse(content) as OutboxRecord;
    if (record.to !== to) continue;
    if (template && record.template !== template) continue;
    candidates.push({ record, mtimeMs: stats.mtimeMs });
  }

  if (candidates.length === 0) return null;
  candidates.sort(newestFirst);
  return candidates[0]!.record;
}

/**
 * Polls the outbox until the latest matching message satisfies `accept`. The
 * E2E outbox is filesystem-backed, so there is no equivalent of Vitest's
 * synchronous in-process await — the webServer's write may land a beat after
 * the triggering HTTP response resolves in the browser.
 */
async function pollOutbox(
  to: string,
  template: string,
  accept: (message: OutboxRecord) => boolean,
  timeoutMs: number,
  waitingFor: string,
): Promise<OutboxRecord> {
  const start = Date.now();
  for (;;) {
    const message = await latestOutboxMessage(to, template);
    if (message && accept(message)) return message;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `timed out waiting for ${waitingFor} "${template}" message to ${to}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Polls for a message to appear. */
export function waitForOutboxMessage(
  to: string,
  template: string,
  timeoutMs = 10_000,
): Promise<OutboxRecord> {
  return pollOutbox(to, template, () => true, timeoutMs, "a");
}

/**
 * Polls for a message written AFTER `previous` (Phase 18.3) — for a test that
 * asks for a further email to the same recipient and has to prove it arrived.
 * {@link waitForOutboxMessage} would return the earlier one at once. "After"
 * is by `createdAt`, so an older message is never mistaken for the new one;
 * the sends a test makes are seconds apart, far beyond its millisecond grain.
 */
export function waitForNewOutboxMessage(
  to: string,
  template: string,
  previous: OutboxRecord,
  timeoutMs = 10_000,
): Promise<OutboxRecord> {
  return pollOutbox(
    to,
    template,
    (message) => Date.parse(message.createdAt) > Date.parse(previous.createdAt),
    timeoutMs,
    "a further",
  );
}

/**
 * Extracts the exact absolute URL Better Auth generated for this message
 * (the same link a learner's email client would show) — navigating this
 * URL directly, rather than reconstructing one from the token, exercises
 * the real GET redirect/error-mapping chain (verify-email and
 * reset-password are both server-side redirects, not client-rendered
 * pages that read a `token` param directly).
 *
 * SAFETY: the returned URL carries a live, single-use token. Any spec
 * file that navigates to it (`page.goto(extractUrlFromMessage(...))`)
 * must disable Playwright tracing for that file
 * (`test.use({ trace: "off" })` at file scope) — otherwise a CI retry
 * captures a trace embedding the token URL, and Playwright's HTML
 * reporter bundles trace attachments directly inside the report folder
 * CI uploads on failure (phases-15.md §61 — "never upload verification
 * tokens / reset tokens"). See e2e/auth.spec.ts for the reference
 * implementation.
 */
export function extractUrlFromMessage(message: OutboxRecord): string {
  const match = message.text.match(/https?:\/\/\S+/);
  if (!match) {
    throw new Error(
      `extractUrlFromMessage: no URL found in message to ${message.to}`,
    );
  }
  return match[0];
}
