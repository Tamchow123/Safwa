import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getServerSessionMock = vi.fn();
vi.mock("@/modules/auth/session", () => ({
  getServerSession: () => getServerSessionMock(),
}));

const getServerEnvMock = vi.fn();
vi.mock("@/modules/env/server", () => ({
  getServerEnv: () => getServerEnvMock(),
}));

import { guardSyncRequest } from "@/modules/sync/server/auth-guard";
import { SYNC_CROSS_ORIGIN_ERROR } from "@/modules/sync/server/guard-decision";

/**
 * The shared sync guard's same-origin check (Phase 18.1).
 *
 * `modules/http/request-origin.test.ts` proves the DECISION. This proves the
 * guard actually applies it, in the right order, on the real code path every
 * sync route takes — which is the part a pure test cannot reach, and the part
 * that silently disappears if someone stops threading the request through.
 */
const APP_URL = "https://safwa.example";

function request(headers: Record<string, string>): Request {
  return new Request(`${APP_URL}/api/sync/pull`, { headers });
}

beforeEach(() => {
  getServerSessionMock.mockReset();
  getServerEnvMock.mockReset();
  getServerEnvMock.mockReturnValue({ syncEnabled: true, appUrl: APP_URL });
  getServerSessionMock.mockResolvedValue({
    user: { id: "user-1", emailVerified: true },
  });
});

describe("guardSyncRequest — cross-origin", () => {
  it("authorises a request the app made of itself", async () => {
    const result = await guardSyncRequest(
      request({ origin: APP_URL, "sec-fetch-site": "same-origin" }),
    );
    expect(result).toEqual({ ok: true, userId: "user-1" });
  });

  it("refuses a foreign Origin with 403 and a distinguishable reason", async () => {
    const result = await guardSyncRequest(
      request({ origin: "https://evil.example" }),
    );

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: SYNC_CROSS_ORIGIN_ERROR,
      // The field that stops this being reported to a learner as an
      // unverified email — both refusals are 403.
      reason: "cross-origin",
    });
  });

  it("refuses a cross-site navigation, the case SameSite=Lax still cookies", async () => {
    const result = await guardSyncRequest(
      request({ "sec-fetch-site": "cross-site" }),
    );
    expect(result).toMatchObject({ ok: false, reason: "cross-origin" });
  });

  it("refuses BEFORE reading the session, so the refusal reveals nothing", async () => {
    // If the origin check ran after the session read, the difference between
    // a 401 and a 403 would tell a foreign page whether this browser is
    // signed in to Safwa — a cross-site login-state oracle.
    await guardSyncRequest(request({ origin: "https://evil.example" }));
    expect(getServerSessionMock).not.toHaveBeenCalled();
  });

  it("refuses a disabled sync before the origin check, keeping 503 first", async () => {
    // Order matters the other way here: the kill switch is the outermost
    // statement about the whole feature, and it must not be maskable by a
    // request-shaped refusal.
    getServerEnvMock.mockReturnValue({ syncEnabled: false, appUrl: APP_URL });
    const result = await guardSyncRequest(
      request({ origin: "https://evil.example" }),
    );
    expect(result).toMatchObject({ ok: false, status: 503 });
  });

  it("still authorises when neither header is present", async () => {
    // Fail-safe, asserted on the real path: browsers omit Origin on ordinary
    // same-origin GETs, and neither header can be forged by an attacker —
    // both are forbidden header names.
    const result = await guardSyncRequest(request({}));
    expect(result).toEqual({ ok: true, userId: "user-1" });
  });

  it("keeps working for a caller that passes no request at all", async () => {
    // The parameter is optional so the check cannot be lost silently by a
    // signature mismatch. Every route passes one; this pins the fallback.
    const result = await guardSyncRequest();
    expect(result).toEqual({ ok: true, userId: "user-1" });
  });
});
