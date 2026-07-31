/**
 * The one 429 shape (Phase 18.1).
 *
 * Four routes refuse a rate-limited caller, and the first version of this
 * branch built the response in four places — two identical local helpers plus
 * two inline objects. The council flagged the obvious risk: a fix to one (the
 * header name, the status, the message) silently not reaching the others.
 *
 * The bodies genuinely differ — `/api/sync/guest-merge` speaks a protocol that
 * carries `protocolVersion` on every response, and the others do not — so this
 * takes the extra fields rather than pretending one body fits all. What it
 * centralises is the part that must not drift: the status and the
 * `Retry-After` header.
 *
 * STATED PLAINLY, because the first version of this comment did not: NO CLIENT
 * IN THIS REPOSITORY READS `Retry-After` TODAY. `modules/sync/client/api.ts`
 * and `guest-merge-api.ts` both map a 429 to a retryable outcome from the
 * status alone, and the orchestrator picks it up again on its next ordinary
 * trigger. That is not harmful — nothing busy-loops — but the header is
 * currently a promise to a client that does not exist yet, and a comment
 * implying otherwise would let the next person assume backoff is handled.
 * Wiring it through is tracked as follow-up (council FUNC-002), deliberately
 * not done here: it changes sync retry TIMING, which deserves its own tests
 * rather than a ride on a hardening branch.
 */
import { NextResponse } from "next/server";

import { RATE_LIMITED_ERROR } from "@/modules/http/rate-limit";

/**
 * A 429 carrying `Retry-After`, in seconds.
 *
 * `extra` is merged into the body for routes whose protocol requires more than
 * an `error` field. It cannot override `error`, so every rate-limit refusal
 * says the same thing no matter which route produced it.
 */
export function rateLimitedResponse(
  retryAfterSeconds: number,
  extra?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json(
    { ...extra, error: RATE_LIMITED_ERROR },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfterSeconds) },
    },
  );
}
