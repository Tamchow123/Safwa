/**
 * Phase 17 §13 — POST /api/sync/guest-merge. The single authenticated entry
 * point to the guest→account merge, and the ONLY way the server-internal merge
 * ingestion mode can be reached (§13, §30 "no client-accessible merge-mode
 * bypass").
 *
 * ONE ROUTE, THREE STAGES. `begin`, `chunk` and `finalize` arrive here
 * discriminated on `stage`, because three sibling routes would be three places
 * to remember the guard, the body cap and the schema — and a stage added later
 * could skip one by omission. The union means a request cannot be parsed at all
 * without having decided which stage it is.
 *
 * It:
 *   1. Guards the request through the SAME shared guard every sync endpoint
 *      uses (SYNC_ENABLED → authenticated → email-verified). The user id comes
 *      only from the session; no field of the body names an account (§9.2).
 *   2. Bounds the raw body by STREAMING it against a hard byte cap, never
 *      trusting `Content-Length`, so an oversized body is refused before it is
 *      buffered or parsed (§29, §30).
 *   3. Strictly validates the wire shape. Unknown fields are rejected by the
 *      schema, and a failure is a fixed generic message — never a Zod issue
 *      list, which can echo payload contents (§30).
 *   4. Hands off to the coordinator, which owns every durable decision.
 *
 * WHY THE GUARD'S REFUSALS ARE ALSO IN THE BODY. A merge is a staged
 * conversation, and the client has to decide between "stop and tell the learner
 * why" and "retry later". An HTTP status alone cannot carry that: 403 covers
 * both an unverified email (actionable by the learner) and a great many other
 * things. So a refused request keeps its accurate status AND carries the
 * protocol's own reason code, spelled by `guestMergeGuardReason` so this route
 * cannot invent its own vocabulary.
 */
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import {
  guestMergeRequestSchema,
  SYNC_BOUNDS,
  SYNC_PROTOCOL_VERSION,
  type GuestMergeReasonCode,
} from "@/modules/sync/protocol";
import { guardSyncRequest } from "@/modules/sync/server/auth-guard";
import {
  guestMergeGuardReason,
  runGuestMerge,
} from "@/modules/sync/server/guest-merge";
import {
  BODY_TOO_LARGE,
  readBoundedBody,
} from "@/modules/sync/server/request-body";
import { consumeRateLimit } from "@/modules/http/rate-limit";
import { rateLimitedResponse } from "@/modules/http/rate-limited-response";

export const runtime = "nodejs";

/**
 * See the long note in `app/api/sync/push/route.ts` for why this exists and
 * why 60 (Phase 18.1). This route carries the LARGEST accepted batch of the
 * three — `maxItemsPerChunk` is `SYNC_BOUNDS.maxItemsPerBatch`, above push's
 * own `maxEvents` — so if any of them needed the headroom, it is this one.
 *
 * Spelled out rather than imported: Next reads route segment config by static
 * analysis, so an imported constant would be silently ignored.
 */
export const maxDuration = 60;

/**
 * A refusal, in the shape the client can act on: the accurate HTTP status, a
 * fixed generic message, and the protocol's own reason code.
 *
 * `stage` is deliberately absent — a request refused before it was parsed has
 * no stage the server can honestly name, and guessing one would let a client
 * infer that its malformed body was read further than it was.
 */
function refuse(
  status: number,
  message: string,
  reasonCode: GuestMergeReasonCode,
): NextResponse {
  return NextResponse.json(
    { protocolVersion: SYNC_PROTOCOL_VERSION, error: message, reasonCode },
    { status },
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  // 1. The SHARED guard — the same flag, session and verification checks every
  //    other sync endpoint applies, so the merge cannot be reachable under
  //    conditions ordinary sync is not.
  const guard = await guardSyncRequest(request);
  if (!guard.ok) {
    return refuse(
      guard.status,
      guard.error,
      guestMergeGuardReason(guard.reason),
    );
  }
  const { userId } = guard;

  // 1b. Rate limit, keyed by the session-derived account id (Phase 18.1).
  //     No `reasonCode`: the merge vocabulary describes merge outcomes, and
  //     being limited is not one — borrowing the nearest code would tell the
  //     client something untrue about its own import. It does not need one
  //     either, because `guest-merge-api.ts` already maps a 429 to
  //     `rate_limited` from the status alone and treats `reasonCode` as
  //     optional. The ceiling clears a whole legitimate chunked merge with
  //     room to spare; see RATE_LIMIT_RULES.
  const limit = await consumeRateLimit("guest-merge", userId);
  if (!limit.allowed) {
    return rateLimitedResponse(limit.retryAfterSeconds, {
      protocolVersion: SYNC_PROTOCOL_VERSION,
    });
  }

  // 2. Bound the raw body BEFORE parsing. A merge chunk is exactly as large as
  //    an ordinary push batch (GUEST_MERGE_BOUNDS.maxItemsPerChunk is
  //    SYNC_BOUNDS.maxItemsPerBatch), so it takes the same byte cap — one limit
  //    governing both, rather than a second number to keep in step.
  const text = await readBoundedBody(request, SYNC_BOUNDS.maxRequestBytes);
  if (text === BODY_TOO_LARGE) {
    return refuse(413, "Request too large.", "malformed_request");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return refuse(400, "Invalid request body.", "malformed_request");
  }

  const parsed = guestMergeRequestSchema.safeParse(raw);
  if (!parsed.success) {
    // Never surface the raw Zod issue list — it quotes the offending values,
    // which for this endpoint means guest learning data (§30).
    return refuse(400, "Invalid merge request.", "malformed_request");
  }

  const correlationId = randomUUID();
  try {
    const response = await runGuestMerge(userId, parsed.data, {
      // The server's own receipt clock, injected once per request so every
      // durable timestamp this request writes agrees (§13).
      nowMs: Date.now(),
      correlationId,
    });
    return NextResponse.json(response, { status: 200 });
  } catch (cause) {
    // The correlation id is logged with the error and returned to the client so
    // a support conversation can join the two WITHOUT the response carrying any
    // detail of what failed (§30 "safe generic errors").
    console.error(
      `[sync] guest-merge failed (correlation ${correlationId})`,
      cause,
    );
    return NextResponse.json(
      {
        protocolVersion: SYNC_PROTOCOL_VERSION,
        error: "Merge failed. Please retry.",
        reasonCode: "internal_error" satisfies GuestMergeReasonCode,
        correlationId,
      },
      { status: 500 },
    );
  }
}

/**
 * The merge accepts POST and nothing else. Declared explicitly rather than left
 * to Next's default 405, so a GET carrying an import key in the query string —
 * where it would be logged by every proxy in the path — is refused by this
 * file's own rules (§30).
 */
export async function GET(): Promise<NextResponse> {
  return refuse(405, "Method not allowed.", "malformed_request");
}
