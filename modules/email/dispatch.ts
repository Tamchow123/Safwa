/**
 * Background email dispatch (Phase 15 review fix). Better Auth's
 * `sendResetPassword`/`sendVerificationEmail`/`sendDeleteAccountVerification`
 * callbacks must NOT `await` provider delivery directly — doing so gates
 * the HTTP response on the email round-trip, and an existing account (a
 * real send, taking measurably longer) becomes observably slower than a
 * nonexistent one (an immediate no-op), defeating enumeration safety
 * through response TIMING even when every response BODY is identical.
 * Better Auth's own guidance for exactly this class of callback is not to
 * await it; schedule delivery instead through a supported background-task
 * primitive.
 *
 * Uses Next.js's `after()` (the App Router's supported background-task
 * primitive, equivalent to Vercel's `waitUntil`) so a serverless runtime
 * stays alive long enough for delivery to finish after the response is
 * sent — never to delay the response itself.
 */
import "server-only";
import { after } from "next/server";
import type { SendEmailResult } from "@/modules/email/types";

// Tracked regardless of whether after() succeeds, so flushPendingEmails()
// is reliable both in a real request (after() schedules it, this array
// also awaits it) and in a test/script calling a callback directly with no
// active Next.js request scope (after() throws; this array is the only
// tracking mechanism left).
let pending: Promise<void>[] = [];

/**
 * Fire off `send` without waiting for it. Never throws and never rejects
 * the caller — a provider failure is swallowed here (logged, without
 * token/body content) rather than surfacing to Better Auth, since by the
 * time this runs the HTTP response this email was triggered by has
 * already been decided.
 */
export function dispatchEmail(send: () => Promise<SendEmailResult>): void {
  const settled = send()
    .then(() => undefined)
    .catch((error: unknown) => {
      console.error("[email:dispatch] delivery failed", error);
    });
  pending.push(settled);
  // Self-prune once settled: a warm serverless container can reuse this
  // module across many invocations, so leaving every settled promise in
  // `pending` forever (production never calls flushPendingEmails()) would
  // be unbounded per-container growth. Only genuinely in-flight sends stay
  // referenced.
  void settled.then(() => {
    pending = pending.filter((p) => p !== settled);
  });
  try {
    after(() => settled);
  } catch {
    // Called outside a request scope — nothing to schedule against; the
    // promise is still tracked in `pending` above.
  }
}

/** Test-only: await every email dispatched so far, then clear the queue. */
export async function flushPendingEmails(): Promise<void> {
  await Promise.allSettled(pending);
  pending = [];
}

/** Test-only: the number of promises still retained (proves self-pruning). */
export function pendingCountForTests(): number {
  return pending.length;
}
