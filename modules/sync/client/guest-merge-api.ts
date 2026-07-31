/**
 * Phase 17 §13 — the typed client for `POST /api/sync/guest-merge`.
 *
 * Mirrors `modules/sync/client/api.ts`: validate the request before it leaves,
 * validate the response before it is believed, and reduce HTTP to a small closed
 * set of reasons. It differs in one way that matters — the merge route answers a
 * REFUSAL with an accurate HTTP status AND a `reasonCode` in the body, because
 * "403" alone cannot distinguish "verify your email" from "merging is turned
 * off", and the learner is owed the difference (§13, §21).
 *
 * So a non-2xx response is not discarded here: its body is parsed for the
 * protocol's own reason code, and the caller gets both. When the body carries no
 * usable code the status is mapped to the nearest honest one rather than an
 * invented specific — never a raw message, never a status the server did not
 * send.
 *
 * Imports nothing Dexie/server-only, so it is unit-testable with a mocked
 * `fetch`.
 */
import {
  GUEST_MERGE_REASON_CODES,
  guestMergeRequestSchema,
  guestMergeResponseSchema,
  SYNC_PROTOCOL_VERSION,
  type GuestMergeReasonCode,
  type GuestMergeRequest,
  type GuestMergeResponse,
} from "@/modules/sync/protocol";

export const GUEST_MERGE_URL = "/api/sync/guest-merge";

/** The closed set of transport-level failures a merge call can surface. */
export type GuestMergeApiFailure =
  | "network" // fetch threw / offline
  | "bad_request" // 4xx the client should not have produced
  | "unauthorized" // 401 — session lost mid-merge
  // 403 is ambiguous by design: an unverified email, OR a refused origin
  // (Phase 18.1). What the learner is told comes from `reasonCode`, never from
  // this status — see `guestMergeGuardReason`.
  | "forbidden"
  | "too_large" // 413 — a chunk over the byte cap
  | "rate_limited" // 429
  | "disabled" // 503 — SYNC_ENABLED=false / dependency unavailable
  | "server_error" // 5xx
  | "invalid_response"; // 2xx whose body failed schema validation

export type GuestMergeApiResult =
  | { ok: true; data: GuestMergeResponse }
  | {
      ok: false;
      reason: GuestMergeApiFailure;
      status?: number;
      /** The protocol reason the server named, when it named one. */
      reasonCode?: GuestMergeReasonCode;
    };

function failureForStatus(status: number): GuestMergeApiFailure {
  switch (status) {
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 413:
      return "too_large";
    case 429:
      return "rate_limited";
    case 503:
      return "disabled";
    default:
      return status >= 500 ? "server_error" : "bad_request";
  }
}

/**
 * Transport failures worth another attempt under the SAME import key. Deliberately
 * a small allow-list rather than "anything that is not a 4xx": resuming an import
 * re-sends learner history, so the default for an unrecognised condition is to
 * stop and let the person decide, not to keep trying.
 *
 * `unauthorized` is absent — a lost session is repaired by signing in, not by
 * retrying — and so is `bad_request`, which means this client built something the
 * server rejected and would build again.
 */
const RETRYABLE_FAILURES: ReadonlySet<GuestMergeApiFailure> = new Set([
  "network",
  "rate_limited",
  "server_error",
  "disabled",
]);

/** Whether another attempt under the same key could plausibly succeed. */
export function isRetryableMergeFailure(reason: GuestMergeApiFailure): boolean {
  return RETRYABLE_FAILURES.has(reason);
}

/** Read the protocol reason code out of an error body, if it carries one. */
function reasonCodeOf(body: unknown): GuestMergeReasonCode | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const code = (body as { reasonCode?: unknown }).reasonCode;
  return GUEST_MERGE_REASON_CODES.includes(code as GuestMergeReasonCode)
    ? (code as GuestMergeReasonCode)
    : undefined;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Send one merge stage. The request is validated locally first, so a
 * programming error that built an over-cap chunk fails here rather than after
 * uploading it.
 */
export async function postGuestMerge(
  request: GuestMergeRequest,
  init?: { signal?: AbortSignal },
): Promise<GuestMergeApiResult> {
  const parsedRequest = guestMergeRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    return { ok: false, reason: "bad_request" };
  }

  let response: Response;
  try {
    response = await fetch(GUEST_MERGE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parsedRequest.data),
      signal: init?.signal,
    });
  } catch {
    return { ok: false, reason: "network" };
  }

  const body = await readJson(response);

  if (!response.ok) {
    return {
      ok: false,
      reason: failureForStatus(response.status),
      status: response.status,
      ...(reasonCodeOf(body) ? { reasonCode: reasonCodeOf(body) } : {}),
    };
  }

  const parsed = guestMergeResponseSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid_response",
      status: response.status,
    };
  }
  // The stage is echoed by the server and discriminates the response union, so a
  // reply for a DIFFERENT stage than the one sent would be silently destructured
  // as the wrong shape by the caller. Refuse it as an invalid response instead —
  // a well-behaved server never does this, and a proxy that reorders or replays
  // requests is exactly what this catches.
  if (parsed.data.stage !== parsedRequest.data.stage) {
    return { ok: false, reason: "invalid_response", status: response.status };
  }
  if (parsed.data.protocolVersion !== SYNC_PROTOCOL_VERSION) {
    return { ok: false, reason: "invalid_response", status: response.status };
  }
  return { ok: true, data: parsed.data };
}
