import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const guardMock = vi.fn();
vi.mock("@/modules/sync/server/auth-guard", () => ({
  guardSyncRequest: () => guardMock(),
}));

const activeReleaseMock = vi.fn();
vi.mock("@/modules/content/server-release-registry", () => ({
  getActiveRelease: () => activeReleaseMock(),
}));

const pullChangesMock = vi.fn();
vi.mock("@/modules/sync/server/pull", () => ({
  pullChanges: (...args: unknown[]) => pullChangesMock(...args),
}));

import { GET } from "@/app/api/sync/pull/route";

function pullRequest(query = ""): Request {
  return new Request(`http://localhost/api/sync/pull${query}`, {
    method: "GET",
  });
}

const EMPTY_CHANGES = {
  serverCursor: 7,
  hasMore: false,
  components: [],
  events: [],
  bookmarks: [],
  lists: [],
  settings: [],
  tombstones: [],
};

beforeEach(() => {
  guardMock.mockReset();
  activeReleaseMock.mockReset();
  pullChangesMock.mockReset();
  guardMock.mockResolvedValue({ ok: true, userId: "user-1" });
  activeReleaseMock.mockResolvedValue({ releaseId: "rel-1" });
  pullChangesMock.mockResolvedValue(EMPTY_CHANGES);
});

afterEach(() => vi.restoreAllMocks());

describe("GET /api/sync/pull", () => {
  it("returns 503 when sync is disabled, never querying", async () => {
    guardMock.mockResolvedValue({ ok: false, status: 503, error: "x" });
    const response = await GET(pullRequest("?since=0"));
    expect(response.status).toBe(503);
    expect(pullChangesMock).not.toHaveBeenCalled();
  });

  it("returns 401 for an unauthenticated request", async () => {
    guardMock.mockResolvedValue({
      ok: false,
      status: 401,
      error: "Unauthorized",
    });
    const response = await GET(pullRequest("?since=0"));
    expect(response.status).toBe(401);
    expect(pullChangesMock).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric since with a generic 400", async () => {
    const response = await GET(pullRequest("?since=abc"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid pull request." });
    expect(pullChangesMock).not.toHaveBeenCalled();
  });

  it("rejects a limit above the max with a generic 400", async () => {
    const response = await GET(pullRequest("?since=0&limit=9999"));
    expect(response.status).toBe(400);
    expect(pullChangesMock).not.toHaveBeenCalled();
  });

  it("defaults since=0 and a bounded limit when omitted", async () => {
    const response = await GET(pullRequest());
    expect(response.status).toBe(200);
    expect(pullChangesMock).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ since: 0 }),
      expect.objectContaining({ nowMs: expect.any(Number) }),
    );
  });

  it("returns the changes with cursor + active release + protocol version", async () => {
    pullChangesMock.mockResolvedValue({
      ...EMPTY_CHANGES,
      serverCursor: 42,
      hasMore: true,
      bookmarks: [{ entryId: 5, createdAt: 1 }],
    });
    const response = await GET(pullRequest("?since=3&limit=50"));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.protocolVersion).toBe(1);
    expect(json.activeReleaseId).toBe("rel-1");
    expect(json.serverCursor).toBe(42);
    expect(json.hasMore).toBe(true);
    expect(json.bookmarks).toEqual([{ entryId: 5, createdAt: 1 }]);
    expect(json.notices).toEqual([]);
    // Passes the SESSION user id and the parsed query through.
    expect(pullChangesMock).toHaveBeenCalledWith(
      "user-1",
      { since: 3, limit: 50 },
      expect.objectContaining({ nowMs: expect.any(Number) }),
    );
  });

  it("returns a generic 500 (no internals) if pull throws", async () => {
    pullChangesMock.mockRejectedValue(
      new Error("db exploded with secret detail"),
    );
    const response = await GET(pullRequest("?since=0"));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain(
      "secret detail",
    );
  });

  it("returns 503 when the active release is unavailable", async () => {
    activeReleaseMock.mockRejectedValue(new Error("registry down"));
    const response = await GET(pullRequest("?since=0"));
    expect(response.status).toBe(503);
    expect(pullChangesMock).not.toHaveBeenCalled();
  });
});
