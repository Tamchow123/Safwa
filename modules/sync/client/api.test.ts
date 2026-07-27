import { afterEach, describe, expect, it, vi } from "vitest";

import type { PushRequest } from "@/modules/sync/protocol";

import { pullSync, pushSync } from "./api";

const VALID_PUSH: PushRequest = {
  protocolVersion: 1,
  deviceId: "device-1",
  attempts: [],
  events: [],
  revocations: [],
  bookmarks: [],
  lists: [],
  settings: [],
};

const PUSH_RESPONSE = {
  protocolVersion: 1,
  serverCursor: 5,
  activeReleaseId: "rel-1",
  results: [],
};

const PULL_RESPONSE = {
  protocolVersion: 1,
  serverCursor: 5,
  activeReleaseId: "rel-1",
  hasMore: false,
  components: [],
  events: [],
  bookmarks: [],
  lists: [],
  settings: [],
  tombstones: [],
  notices: [],
};

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(body === undefined ? "" : JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("pushSync", () => {
  it("posts to /api/sync/push and returns the validated response on 200", async () => {
    mockFetch(200, PUSH_RESPONSE);
    const result = await pushSync(VALID_PUSH);
    expect(result).toEqual({ ok: true, data: PUSH_RESPONSE });
    expect(fetch).toHaveBeenCalledWith(
      "/api/sync/push",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects an invalid request locally without hitting the network", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const result = await pushSync({
      ...VALID_PUSH,
      protocolVersion: 99,
    } as never);
    expect(result).toEqual({ ok: false, reason: "bad_request" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("maps a network error to reason network", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    expect(await pushSync(VALID_PUSH)).toEqual({
      ok: false,
      reason: "network",
    });
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [413, "too_large"],
    [429, "rate_limited"],
    [503, "disabled"],
    [500, "server_error"],
  ] as const)("maps HTTP %i to reason %s", async (status, reason) => {
    mockFetch(status, { error: "x" });
    expect(await pushSync(VALID_PUSH)).toEqual({ ok: false, reason, status });
  });

  it("maps a 2xx body that fails schema validation to invalid_response", async () => {
    mockFetch(200, { protocolVersion: 1, serverCursor: "not-a-number" });
    expect(await pushSync(VALID_PUSH)).toEqual({
      ok: false,
      reason: "invalid_response",
      status: 200,
    });
  });
});

describe("pullSync", () => {
  it("gets /api/sync/pull with clamped since/limit and validates the response", async () => {
    mockFetch(200, PULL_RESPONSE);
    const result = await pullSync({ since: -5, limit: 9999 });
    expect(result).toEqual({ ok: true, data: PULL_RESPONSE });
    // since clamped to >= 0, limit clamped to maxPullPageSize (200).
    expect(fetch).toHaveBeenCalledWith(
      "/api/sync/pull?since=0&limit=200",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("maps a network error to reason network", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    expect(await pullSync({ since: 0, limit: 100 })).toEqual({
      ok: false,
      reason: "network",
    });
  });

  it("maps a 503 to disabled", async () => {
    mockFetch(503, { error: "x" });
    expect(await pullSync({ since: 0, limit: 100 })).toMatchObject({
      ok: false,
      reason: "disabled",
    });
  });
});
