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
 * centralises is the part that must not drift: the status, and the
 * `Retry-After` header a client needs in order to back off by the right amount
 * instead of guessing.
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
