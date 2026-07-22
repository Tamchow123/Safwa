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
import { pullChanges } from "@/modules/sync/server/pull";

export const runtime = "nodejs";

function error(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: Request): Promise<NextResponse> {
  const guard = await guardSyncRequest();
  if (!guard.ok) return error(guard.status, guard.error);
  const { userId } = guard;

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
  };
  return NextResponse.json(response);
}
