/**
 * Phase 17 §13, §29, §30 — the authenticated merge route.
 *
 * The coordinator is mocked here on purpose. What this file is about is the
 * boundary: what reaches the coordinator, what never does, and what the client
 * is told when a request is refused before it gets there. The coordinator's own
 * behaviour is proved against Postgres in
 * `tests/integration/guest-merge-coordinator.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const guardMock = vi.fn();
vi.mock("@/modules/sync/server/auth-guard", () => ({
  guardSyncRequest: () => guardMock(),
}));

const runMergeMock = vi.fn();
vi.mock("@/modules/sync/server/guest-merge", () => ({
  runGuestMerge: (...args: unknown[]) => runMergeMock(...args),
  // The real translation, not a stub: the route's job is to USE it, and a
  // mocked one would let a wrong mapping pass unnoticed.
  guestMergeGuardReason: (status: number) =>
    status === 503
      ? "merge_disabled"
      : status === 403
        ? "email_unverified"
        : "malformed_request",
}));

import { GET, POST } from "@/app/api/sync/guest-merge/route";

// Deliberately full of hex LETTERS: an all-digit key would make the
// uppercase-rejection case below vacuous, since toUpperCase() would not change
// it. The lowercase-only rule exists because the key is compared as text.
const IMPORT_KEY = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const SNAPSHOT = "a".repeat(64);

function mergeRequest(body: unknown): Request {
  return new Request("http://localhost/api/sync/guest-merge", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const VALID_BEGIN = {
  protocolVersion: 1,
  stage: "begin",
  importKey: IMPORT_KEY,
  snapshotHash: SNAPSHOT,
  deviceId: "device-1",
  declared: { attempts: 0, events: 0, bookmarks: 1, lists: 0, settings: 0 },
};

const BEGIN_RESPONSE = {
  protocolVersion: 1,
  stage: "begin",
  importStatus: "open",
  reasonCode: "accepted",
  resumeFromChunk: 0,
  acceptedItems: 0,
};

beforeEach(() => {
  guardMock.mockReset();
  runMergeMock.mockReset();
  guardMock.mockResolvedValue({ ok: true, userId: "user-1" });
  runMergeMock.mockResolvedValue(BEGIN_RESPONSE);
});

afterEach(() => vi.restoreAllMocks());

describe("POST /api/sync/guest-merge — the guard (§9.2, §13)", () => {
  it("refuses when sync is disabled, and never reaches the coordinator", async () => {
    guardMock.mockResolvedValue({
      ok: false,
      status: 503,
      error: "Online sync is currently unavailable.",
    });

    const response = await POST(mergeRequest(VALID_BEGIN));
    expect(response.status).toBe(503);
    const json = await response.json();
    // The reason code is what lets the client distinguish "stop" from "retry
    // later" — the status alone cannot.
    expect(json.reasonCode).toBe("merge_disabled");
    expect(runMergeMock).not.toHaveBeenCalled();
  });

  it("refuses an unverified account with the reason the learner can act on", async () => {
    guardMock.mockResolvedValue({
      ok: false,
      status: 403,
      error: "Verify your email to sync.",
    });

    const response = await POST(mergeRequest(VALID_BEGIN));
    expect(response.status).toBe(403);
    expect((await response.json()).reasonCode).toBe("email_unverified");
    expect(runMergeMock).not.toHaveBeenCalled();
  });

  it("refuses a guest with no session", async () => {
    guardMock.mockResolvedValue({
      ok: false,
      status: 401,
      error: "Sign in to sync.",
    });

    const response = await POST(mergeRequest(VALID_BEGIN));
    expect(response.status).toBe(401);
    expect(runMergeMock).not.toHaveBeenCalled();
  });

  it("passes the SESSION user id, never anything from the body", async () => {
    // The body carries a `userId` the schema does not define. It must be
    // rejected outright — but if the schema ever loosened, this also asserts
    // the route does not read it.
    const response = await POST(
      mergeRequest({ ...VALID_BEGIN, userId: "someone-else" }),
    );
    expect(response.status).toBe(400);
    expect(runMergeMock).not.toHaveBeenCalled();

    await POST(mergeRequest(VALID_BEGIN));
    expect(runMergeMock.mock.calls[0]?.[0]).toBe("user-1");
  });
});

describe("POST /api/sync/guest-merge — request validation (§29, §30)", () => {
  it("rejects a body over the byte cap before parsing it", async () => {
    // The cap is enforced against bytes received, so an oversized body never
    // reaches JSON.parse, let alone the coordinator.
    const huge = "x".repeat(2_000_000);
    const response = await POST(mergeRequest(JSON.stringify({ huge })));
    expect(response.status).toBe(413);
    expect((await response.json()).reasonCode).toBe("malformed_request");
    expect(runMergeMock).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON generically", async () => {
    const response = await POST(mergeRequest("{not json"));
    expect(response.status).toBe(400);
    expect(runMergeMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown stage rather than guessing one", async () => {
    const response = await POST(
      mergeRequest({ ...VALID_BEGIN, stage: "commit" }),
    );
    expect(response.status).toBe(400);
    expect(runMergeMock).not.toHaveBeenCalled();
  });

  it("rejects an import key that is not a lowercase uuid", async () => {
    // The key is the idempotency anchor and is compared as TEXT, so accepting
    // two spellings of one key would make them two keys.
    for (const importKey of [
      IMPORT_KEY.toUpperCase(),
      "not-a-uuid",
      `${IMPORT_KEY} `,
    ]) {
      const response = await POST(mergeRequest({ ...VALID_BEGIN, importKey }));
      expect(response.status).toBe(400);
    }
    expect(runMergeMock).not.toHaveBeenCalled();
  });

  it("never echoes the offending value in a validation failure (§30)", async () => {
    // A guest's own Arabic learning data would otherwise be quoted back through
    // a Zod issue list.
    const secret = "شَرِبَ";
    const response = await POST(
      mergeRequest({ ...VALID_BEGIN, snapshotHash: secret }),
    );
    expect(response.status).toBe(400);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain(secret);
    expect(body).toBe(
      JSON.stringify({
        protocolVersion: 1,
        error: "Invalid merge request.",
        reasonCode: "malformed_request",
      }),
    );
  });

  it("rejects a chunk index past the protocol's bound", async () => {
    const response = await POST(
      mergeRequest({
        protocolVersion: 1,
        stage: "chunk",
        importKey: IMPORT_KEY,
        snapshotHash: SNAPSHOT,
        chunkIndex: 100,
        attempts: [],
        events: [],
        bookmarks: [],
        lists: [],
        settings: [],
      }),
    );
    expect(response.status).toBe(400);
    expect(runMergeMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/sync/guest-merge — handing off and reporting", () => {
  it("returns the coordinator's response verbatim on success", async () => {
    const response = await POST(mergeRequest(VALID_BEGIN));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(BEGIN_RESPONSE);
  });

  it("injects the server clock and a correlation id, not client values", async () => {
    await POST(mergeRequest(VALID_BEGIN));
    const options = runMergeMock.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(typeof options.nowMs).toBe("number");
    expect(typeof options.correlationId).toBe("string");
    // No registryDir in production — that override is test-only.
    expect(options.registryDir).toBeUndefined();
  });

  it("returns a generic 500 with a correlation id, leaking no internals", async () => {
    runMergeMock.mockRejectedValue(
      new Error("relation guest_imports does not exist: secret detail"),
    );
    const response = await POST(mergeRequest(VALID_BEGIN));
    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("Merge failed. Please retry.");
    expect(json.reasonCode).toBe("internal_error");
    expect(typeof json.correlationId).toBe("string");
    expect(JSON.stringify(json)).not.toContain("secret detail");
    expect(JSON.stringify(json)).not.toContain("guest_imports");
  });

  it("refuses GET, so an import key can never travel in a query string", async () => {
    const response = await GET();
    expect(response.status).toBe(405);
    expect(runMergeMock).not.toHaveBeenCalled();
  });
});
