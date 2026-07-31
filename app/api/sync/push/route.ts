/**
 * Phase 16 — POST /api/sync/push (§9). The single authenticated write endpoint
 * for online sync. It:
 *   1. Guards the request (SYNC_ENABLED → authenticated → email-verified);
 *      the user id is taken ONLY from the session, never the body.
 *   2. Bounds the raw body size, then strictly validates the wire shape
 *      (unknown fields rejected; per-kind + total item caps enforced by the
 *      schema) — a malformed body is a generic 400, never a raw Zod error.
 *   3. Orchestrates the committed server pipelines (ingest → revoke →
 *      collections → settings), each of which derives correctness/rating/
 *      ownership server-side and returns one result per submitted item.
 *      EXCEPTION: a standalone reinforcement-only attempt (in `attempts` with
 *      no accompanying scheduling event) is not yet reflected in `results`
 *      (ledger T9b — matching ingest.ts's own docstring caveat).
 *   4. Returns the account cursor, the active release id, and the per-item
 *      results. Errors are fixed generic strings (no internals leaked).
 *
 * The raw body is bounded by STREAMING it with a hard byte cap (never trusting
 * the client `Content-Length` header, which can be absent, chunked, or a lie),
 * so an oversized body is rejected (413) before it is buffered/parsed (§9.1,
 * §30).
 *
 * The server NEVER trusts client `is_correct`/`rating`/lineage/ownership — that
 * is all derived inside the pipelines this route calls (§8.1).
 */
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { getActiveRelease } from "@/modules/content/server-release-registry";
import {
  pushRequestSchema,
  SYNC_BOUNDS,
  SYNC_PROTOCOL_VERSION,
  type PushResponse,
  type SyncItemResult,
} from "@/modules/sync/protocol";
import { guardSyncRequest } from "@/modules/sync/server/auth-guard";
import { consumeRateLimit } from "@/modules/http/rate-limit";
import { rateLimitedResponse } from "@/modules/http/rate-limited-response";
import {
  BODY_TOO_LARGE,
  readBoundedBody,
} from "@/modules/sync/server/request-body";
import { syncCollectionsBatch } from "@/modules/sync/server/collections";
import { ingestSchedulingBatch } from "@/modules/sync/server/ingest";
import { revokeEventsBatch } from "@/modules/sync/server/revoke";
import { syncSettingsBatch } from "@/modules/sync/server/settings";

export const runtime = "nodejs";

/**
 * The function's own time budget, in seconds (Phase 18.1).
 *
 * Vercel's default for a Node.js function is 10s. That is not enough for the
 * worst case this route ACCEPTS: `SYNC_BOUNDS.maxEvents` events in one batch,
 * concentrated on a single component, each costing a sequential round trip
 * inside one advisory-locked transaction (ingest.ts's payload-conflict and
 * cross-parent lookups), plus the replay itself.
 *
 * The failure mode of getting this wrong is not a slow request. Postgres rolls
 * the transaction back cleanly, so nothing corrupts — but the client's
 * orchestrator treats a killed function as a retryable network fault and
 * resends the IDENTICAL batch, which takes just as long and dies the same way.
 * That is a poison batch: sync stops permanently, and it looks like bad
 * connectivity rather than a server limit.
 *
 * 60s is the ceiling on every Vercel plan including Hobby, so this value does
 * not silently become invalid if the deployment target's plan changes. It buys
 * headroom; it is not a substitute for bounding the per-item query cost, which
 * `docs/DEPLOYMENT.md` §6 records as the standing follow-up.
 *
 * Must be a literal: Next reads route segment config by static analysis, so an
 * imported constant would be ignored rather than applied. The same value is
 * spelled out in pull/ and guest-merge/ for that reason.
 */
export const maxDuration = 60;

function error(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request): Promise<NextResponse> {
  // 1. Auth + kill-switch. userId comes only from the session.
  const guard = await guardSyncRequest(request);
  if (!guard.ok) return error(guard.status, guard.error);
  const { userId } = guard;

  // 1b. Rate limit, keyed by the SESSION-derived account id (Phase 18.1).
  //     Placed after the guard on purpose: an unauthenticated caller is
  //     already refused above, so counting it here would let anyone fill the
  //     counter table, and the account id does not exist until the guard has
  //     produced it. Before the body is read, so an oversized payload from a
  //     limited caller is never buffered.
  const limit = await consumeRateLimit("sync-push", userId);
  if (!limit.allowed) return rateLimitedResponse(limit.retryAfterSeconds);

  // 2. Bound the raw body BEFORE parsing (§9.1, §30) — streamed with a hard
  //    byte cap, never trusting the client Content-Length header.
  const text = await readBoundedBody(request, SYNC_BOUNDS.maxRequestBytes);
  if (text === BODY_TOO_LARGE) {
    return error(413, "Request too large.");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return error(400, "Invalid request body.");
  }
  const parsed = pushRequestSchema.safeParse(raw);
  if (!parsed.success) {
    // Never surface the raw Zod issue list (could echo payload contents).
    return error(400, "Invalid sync request.");
  }
  const body = parsed.data;

  // The active release id the client should reconcile against. Resolved before
  // any write so a broken/unavailable registry fails fast (and consistently
  // with the pipelines, which also require it).
  let activeReleaseId: string;
  try {
    activeReleaseId = (await getActiveRelease()).releaseId;
  } catch (cause) {
    console.error("[sync] push: active release unavailable", cause);
    return error(503, "Online sync is currently unavailable.");
  }

  const correlationId = randomUUID();
  const nowMs = Date.now();

  const results: SyncItemResult[] = [];
  let serverCursor = 0;
  const track = (batch: {
    results: SyncItemResult[];
    serverCursor: number;
  }): void => {
    results.push(...batch.results);
    // The account cursor is monotonic; the final value is the max across the
    // pipelines (each returns the cursor as of its own completion).
    if (batch.serverCursor > serverCursor) serverCursor = batch.serverCursor;
  };

  try {
    track(
      await ingestSchedulingBatch(userId, body.events, body.attempts, {
        nowMs,
        correlationId,
      }),
    );
    track(
      await revokeEventsBatch(userId, body.revocations, {
        nowMs,
        correlationId,
      }),
    );
    track(
      await syncCollectionsBatch(userId, body.bookmarks, body.lists, {
        correlationId,
      }),
    );
    track(await syncSettingsBatch(userId, body.settings, { correlationId }));
  } catch (cause) {
    // A pipeline throwing (rather than isolating per item) is unexpected; log
    // with the correlation id and return a fixed generic 500.
    console.error(`[sync] push failed (correlation ${correlationId})`, cause);
    return error(500, "Sync failed. Please retry.");
  }

  const response: PushResponse = {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    serverCursor,
    activeReleaseId,
    results,
  };
  return NextResponse.json(response);
}
