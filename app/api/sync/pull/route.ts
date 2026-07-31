/**
 * Phase 16 — GET /api/sync/pull?since=<cursor>&limit=<n> (§9.3). Returns the
 * account's authoritative changes since a client-known cursor so a second
 * browser context can bootstrap (since=0) or reconcile. Guarded exactly like
 * push (SYNC_ENABLED → authenticated → email-verified; user id from the session
 * only). The response is bounded + gap-free-paginated (`hasMore`). Errors are
 * fixed generic strings.
 */
import { NextResponse } from "next/server";

import { getActiveRelease } from "@/modules/content/server-release-registry";
import {
  pullQuerySchema,
  SYNC_PROTOCOL_VERSION,
  type PullResponse,
} from "@/modules/sync/protocol";
import { guardSyncRequest } from "@/modules/sync/server/auth-guard";
import { consumeRateLimit } from "@/modules/http/rate-limit";
import { rateLimitedResponse } from "@/modules/http/rate-limited-response";
import { pullChanges } from "@/modules/sync/server/pull";

export const runtime = "nodejs";

/**
 * See the long note in `app/api/sync/push/route.ts` for why this exists and
 * why 60 (Phase 18.1). Pull's worst case is lighter than push's — it holds no
 * advisory lock — but it replays every component a page touches, so it is
 * bounded by the same per-component history cost and gets the same budget.
 *
 * Spelled out rather than imported: Next reads route segment config by static
 * analysis, so an imported constant would be silently ignored.
 */
export const maxDuration = 60;

function error(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: Request): Promise<NextResponse> {
  const guard = await guardSyncRequest(request);
  if (!guard.ok) return error(guard.status, guard.error);
  const { userId } = guard;

  // Keyed by the session-derived account id, after the guard (Phase 18.1).
  const limit = await consumeRateLimit("sync-pull", userId);
  if (!limit.allowed) return rateLimitedResponse(limit.retryAfterSeconds);

  const url = new URL(request.url);
  const rawQuery = {
    since: url.searchParams.has("since")
      ? Number(url.searchParams.get("since"))
      : undefined,
    limit: url.searchParams.has("limit")
      ? Number(url.searchParams.get("limit"))
      : undefined,
  };
  const parsed = pullQuerySchema.safeParse(rawQuery);
  if (!parsed.success) {
    return error(400, "Invalid pull request.");
  }

  let activeReleaseId: string;
  try {
    activeReleaseId = (await getActiveRelease()).releaseId;
  } catch (cause) {
    console.error("[sync] pull: active release unavailable", cause);
    return error(503, "Online sync is currently unavailable.");
  }

  let changes;
  try {
    changes = await pullChanges(userId, parsed.data, { nowMs: Date.now() });
  } catch (cause) {
    console.error("[sync] pull failed", cause);
    return error(500, "Sync failed. Please retry.");
  }

  const response: PullResponse = {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    serverCursor: changes.serverCursor,
    activeReleaseId,
    hasMore: changes.hasMore,
    components: changes.components,
    events: changes.events,
    bookmarks: changes.bookmarks,
    lists: changes.lists,
    settings: changes.settings,
    tombstones: changes.tombstones,
    notices: [],
    // REL-006: components the page examined but could not project. Named, not
    // silently omitted — the cursor advances past them either way.
    withheldComponents: changes.withheldComponents,
  };
  return NextResponse.json(response);
}
