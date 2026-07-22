/**
 * Phase 16 — client sync API wrapper (§18). Thin, typed fetch client for the two
 * authenticated endpoints. It validates the request it sends AND the response it
 * receives against the pure wire schemas, so a malformed server payload becomes
 * a typed `invalid_response` rather than silently corrupting local state. HTTP
 * statuses map to a small closed set of reasons the orchestrator/status layer
 * understands; no raw error text is ever surfaced.
 *
 * Browser-only in practice (it calls the app's own API), but it imports nothing
 * server-only/Dexie — just the isomorphic protocol — so it is unit-testable with
 * a mocked `fetch`.
 */
import {
  pullResponseSchema,
  pushRequestSchema,
  pushResponseSchema,
  SYNC_BOUNDS,
  type PullQuery,
  type PullResponse,
  type PushRequest,
  type PushResponse,
} from "@/modules/sync/protocol";

const PUSH_URL = "/api/sync/push";
const PULL_URL = "/api/sync/pull";

/** The closed set of failure reasons a sync call can surface. */
export type SyncApiFailure =
  | "network" // fetch threw / offline / DNS
  | "bad_request" // 400 — our payload was rejected (should not happen)
  | "unauthorized" // 401 — session lost
  | "forbidden" // 403 — email not verified
  | "too_large" // 413 — batch too big (should be pre-bounded)
  | "rate_limited" // 429
  | "disabled" // 503 — SYNC_ENABLED=false / dependency unavailable
  | "server_error" // 5xx
  | "invalid_response"; // 2xx but the body failed schema validation

export type SyncApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: SyncApiFailure; status?: number };

function failureForStatus(status: number): SyncApiFailure {
  switch (status) {
    case 400:
      return "bad_request";
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

/** Parse a JSON response body, returning `undefined` on any parse failure. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Push a batch. The request is validated client-side first (a programming error
 * that produced an invalid batch fails as `bad_request` locally rather than
 * hitting the network). The response is validated against `pushResponseSchema`.
 */
export async function pushSync(
  request: PushRequest,
  init?: { signal?: AbortSignal },
): Promise<SyncApiResult<PushResponse>> {
  const parsedRequest = pushRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    return { ok: false, reason: "bad_request" };
  }

  let response: Response;
  try {
    response = await fetch(PUSH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parsedRequest.data),
      signal: init?.signal,
    });
  } catch {
    return { ok: false, reason: "network" };
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: failureForStatus(response.status),
      status: response.status,
    };
  }
  const parsed = pushResponseSchema.safeParse(await readJson(response));
  if (!parsed.success) {
    return { ok: false, reason: "invalid_response", status: response.status };
  }
  return { ok: true, data: parsed.data };
}

/** Pull changes since a cursor. The response is validated against `pullResponseSchema`. */
export async function pullSync(
  query: PullQuery,
  init?: { signal?: AbortSignal },
): Promise<SyncApiResult<PullResponse>> {
  const since = Math.max(0, Math.floor(query.since));
  const limit = Math.min(
    SYNC_BOUNDS.maxPullPageSize,
    Math.max(1, Math.floor(query.limit)),
  );
  const url = `${PULL_URL}?since=${since}&limit=${limit}`;

  let response: Response;
  try {
    response = await fetch(url, { method: "GET", signal: init?.signal });
  } catch {
    return { ok: false, reason: "network" };
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: failureForStatus(response.status),
      status: response.status,
    };
  }
  const parsed = pullResponseSchema.safeParse(await readJson(response));
  if (!parsed.success) {
    return { ok: false, reason: "invalid_response", status: response.status };
  }
  return { ok: true, data: parsed.data };
}
