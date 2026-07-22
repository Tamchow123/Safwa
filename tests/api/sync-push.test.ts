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

const ingestMock = vi.fn();
vi.mock("@/modules/sync/server/ingest", () => ({
  ingestSchedulingBatch: (...args: unknown[]) => ingestMock(...args),
}));
const revokeMock = vi.fn();
vi.mock("@/modules/sync/server/revoke", () => ({
  revokeEventsBatch: (...args: unknown[]) => revokeMock(...args),
}));
const collectionsMock = vi.fn();
vi.mock("@/modules/sync/server/collections", () => ({
  syncCollectionsBatch: (...args: unknown[]) => collectionsMock(...args),
}));
const settingsMock = vi.fn();
vi.mock("@/modules/sync/server/settings", () => ({
  syncSettingsBatch: (...args: unknown[]) => settingsMock(...args),
}));

import { POST } from "@/app/api/sync/push/route";

function pushRequest(body: unknown, headers?: Record<string, string>): Request {
  return new Request("http://localhost/api/sync/push", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers,
  });
}

const VALID_BODY = { protocolVersion: 1, deviceId: "device-1" };

function result(itemId: string, itemKind: string) {
  return {
    itemId,
    itemKind,
    status: "accepted",
    reasonCode: "accepted",
    duplicate: false,
    recoverable: false,
  };
}

beforeEach(() => {
  guardMock.mockReset();
  activeReleaseMock.mockReset();
  ingestMock.mockReset();
  revokeMock.mockReset();
  collectionsMock.mockReset();
  settingsMock.mockReset();
  guardMock.mockResolvedValue({ ok: true, userId: "user-1" });
  activeReleaseMock.mockResolvedValue({ releaseId: "rel-1" });
  ingestMock.mockResolvedValue({ results: [], serverCursor: 0 });
  revokeMock.mockResolvedValue({ results: [], serverCursor: 0 });
  collectionsMock.mockResolvedValue({ results: [], serverCursor: 0 });
  settingsMock.mockResolvedValue({ results: [], serverCursor: 0 });
});

afterEach(() => vi.restoreAllMocks());

describe("POST /api/sync/push", () => {
  it("returns 503 and processes nothing when sync is disabled", async () => {
    guardMock.mockResolvedValue({
      ok: false,
      status: 503,
      error: "Online sync is currently unavailable.",
    });
    const response = await POST(pushRequest(VALID_BODY));
    expect(response.status).toBe(503);
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it("returns 401 for an unauthenticated request (independent of body)", async () => {
    guardMock.mockResolvedValue({
      ok: false,
      status: 401,
      error: "Unauthorized",
    });
    const response = await POST(pushRequest(VALID_BODY));
    expect(response.status).toBe(401);
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it("returns 403 for an unverified account", async () => {
    guardMock.mockResolvedValue({
      ok: false,
      status: 403,
      error: "Email verification is required to sync.",
    });
    const response = await POST(pushRequest(VALID_BODY));
    expect(response.status).toBe(403);
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed JSON body with a generic 400", async () => {
    const response = await POST(pushRequest("{ not json"));
    expect(response.status).toBe(400);
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid wire shape (wrong protocol version) with a generic 400", async () => {
    const response = await POST(
      pushRequest({ protocolVersion: 99, deviceId: "d" }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid sync request." });
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it("rejects a body carrying an unknown field (strict schema — no client user id)", async () => {
    const response = await POST(
      pushRequest({ ...VALID_BODY, userId: "victim-user-id" }),
    );
    expect(response.status).toBe(400);
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it("rejects an oversized STREAMED body with 413 even with no content-length header", async () => {
    // A chunked request (ReadableStream body) carries NO content-length header,
    // so the bound must be enforced against the actual bytes read, not a header.
    const huge = "x".repeat(1_000_050); // > SYNC_BOUNDS.maxRequestBytes (1_000_000)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(huge));
        controller.close();
      },
    });
    const request = new Request("http://localhost/api/sync/push", {
      method: "POST",
      body: stream,
      // @ts-expect-error duplex is required by undici for a stream body
      duplex: "half",
    });
    expect(request.headers.get("content-length")).toBeNull(); // truly unbounded by header
    const response = await POST(request);
    expect(response.status).toBe(413);
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it("returns 503 when the active release is unavailable", async () => {
    activeReleaseMock.mockRejectedValue(new Error("registry down"));
    const response = await POST(pushRequest(VALID_BODY));
    expect(response.status).toBe(503);
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it("orchestrates all pipelines with the SESSION user id and aggregates results", async () => {
    ingestMock.mockResolvedValue({
      results: [result("e1", "event")],
      serverCursor: 3,
    });
    collectionsMock.mockResolvedValue({
      results: [result("5", "bookmark"), result("list-1", "list")],
      serverCursor: 5,
    });
    settingsMock.mockResolvedValue({
      results: [result("theme", "setting")],
      serverCursor: 4,
    });

    const response = await POST(pushRequest(VALID_BODY));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.protocolVersion).toBe(1);
    expect(json.activeReleaseId).toBe("rel-1");
    expect(json.serverCursor).toBe(5); // max across pipelines
    expect(json.results).toHaveLength(4); // one per processed item
    // Every pipeline is called with the session user id, never a client value.
    for (const mock of [
      ingestMock,
      revokeMock,
      collectionsMock,
      settingsMock,
    ]) {
      expect(mock.mock.calls[0]?.[0]).toBe("user-1");
    }
  });

  it("returns a generic 500 (no internals) if a pipeline throws", async () => {
    ingestMock.mockRejectedValue(new Error("db exploded with secret detail"));
    const response = await POST(pushRequest(VALID_BODY));
    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("Sync failed. Please retry.");
    expect(JSON.stringify(json)).not.toContain("secret detail");
  });
});
