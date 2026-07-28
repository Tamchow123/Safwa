import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SYNC_PROTOCOL_VERSION,
  emptyGuestMergeSummary,
  type GuestMergeRequest,
} from "@/modules/sync/protocol";

import {
  GUEST_MERGE_URL,
  isRetryableMergeFailure,
  postGuestMerge,
} from "./guest-merge-api";

const IMPORT_KEY = "0192f9a0-1111-7abc-8def-0123456789ab";
const SNAPSHOT_HASH = "a".repeat(64);

function beginRequest(): GuestMergeRequest {
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    stage: "begin",
    importKey: IMPORT_KEY,
    snapshotHash: SNAPSHOT_HASH,
    deviceId: "device-1",
    declared: { attempts: 1, events: 1, bookmarks: 0, lists: 0, settings: 0 },
  };
}

function beginResponse(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    stage: "begin",
    importStatus: "open",
    reasonCode: "accepted",
    resumeFromChunk: 0,
    acceptedItems: 0,
    ...overrides,
  };
}

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("postGuestMerge", () => {
  it("posts the validated request and returns the parsed response", async () => {
    mockFetch(200, beginResponse());
    const result = await postGuestMerge(beginRequest());
    expect(result).toMatchObject({ ok: true, data: { stage: "begin" } });
    expect(fetch).toHaveBeenCalledWith(
      GUEST_MERGE_URL,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("refuses to send a request that fails its own schema", async () => {
    // A programming error that built an over-cap or malformed body must fail
    // here, not after the learner's history has crossed the network.
    mockFetch(200, beginResponse());
    const result = await postGuestMerge({
      ...beginRequest(),
      importKey: "NOT-A-UUID",
    } as GuestMergeRequest);
    expect(result).toEqual({ ok: false, reason: "bad_request" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("carries the server's reason code off a refusal, not just the status", async () => {
    // 403 alone cannot distinguish "verify your email" from "merging is off",
    // and the learner is owed the difference (§13, §21).
    mockFetch(403, {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      error: "Email not verified.",
      reasonCode: "email_unverified",
    });
    expect(await postGuestMerge(beginRequest())).toEqual({
      ok: false,
      reason: "forbidden",
      status: 403,
      reasonCode: "email_unverified",
    });
  });

  it("ignores an unenumerated reason code rather than passing it through", async () => {
    mockFetch(400, {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      error: "no",
      reasonCode: "something_invented",
    });
    const result = await postGuestMerge(beginRequest());
    expect(result).toMatchObject({ ok: false, reason: "bad_request" });
    expect(result).not.toHaveProperty("reasonCode");
  });

  it("maps each refusal status to its own failure", async () => {
    for (const [status, reason] of [
      [401, "unauthorized"],
      [403, "forbidden"],
      [413, "too_large"],
      [429, "rate_limited"],
      [503, "disabled"],
      [500, "server_error"],
      [404, "bad_request"],
    ] as const) {
      mockFetch(status, { error: "x" });
      expect(await postGuestMerge(beginRequest())).toMatchObject({
        ok: false,
        reason,
        status,
      });
    }
  });

  it("maps a thrown fetch to network", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    expect(await postGuestMerge(beginRequest())).toEqual({
      ok: false,
      reason: "network",
    });
  });

  it("rejects a 200 whose body does not match the response schema", async () => {
    mockFetch(200, beginResponse({ resumeFromChunk: -1 }));
    expect(await postGuestMerge(beginRequest())).toMatchObject({
      ok: false,
      reason: "invalid_response",
    });
  });

  it("rejects a well-formed response for a DIFFERENT stage than was sent", async () => {
    // The stage discriminates the response union, so a reply for another stage
    // would be destructured as the wrong shape by the caller — a finalize
    // summary read as a begin resume point, say. A proxy that replays or
    // reorders requests is exactly what this catches.
    mockFetch(200, {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      stage: "finalize",
      result: "applied",
      reasonCode: "accepted",
      summary: emptyGuestMergeSummary(),
      serverCursor: 5,
      activeReleaseId: "rel-1",
      listIdMappings: [],
    });
    expect(await postGuestMerge(beginRequest())).toMatchObject({
      ok: false,
      reason: "invalid_response",
    });
  });

  it("treats a non-JSON body on a refusal as simply carrying no reason code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(new Response("<html>gateway</html>", { status: 502 })),
      ),
    );
    expect(await postGuestMerge(beginRequest())).toEqual({
      ok: false,
      reason: "server_error",
      status: 502,
    });
  });
});

describe("isRetryableMergeFailure", () => {
  it("allows another attempt only for transport conditions that can pass", () => {
    expect(isRetryableMergeFailure("network")).toBe(true);
    expect(isRetryableMergeFailure("rate_limited")).toBe(true);
    expect(isRetryableMergeFailure("server_error")).toBe(true);
    expect(isRetryableMergeFailure("disabled")).toBe(true);
  });

  it("does not retry a lost session or a request the server would reject again", () => {
    // Resuming re-sends learner history, so the default for anything the client
    // cannot change by waiting is to stop and let the person decide.
    expect(isRetryableMergeFailure("unauthorized")).toBe(false);
    expect(isRetryableMergeFailure("forbidden")).toBe(false);
    expect(isRetryableMergeFailure("bad_request")).toBe(false);
    expect(isRetryableMergeFailure("too_large")).toBe(false);
    expect(isRetryableMergeFailure("invalid_response")).toBe(false);
  });
});
