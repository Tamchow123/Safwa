import { describe, expect, it } from "vitest";

import {
  evaluateSyncGuard,
  SYNC_UNAUTHORIZED_ERROR,
  SYNC_UNAVAILABLE_ERROR,
  SYNC_UNVERIFIED_ERROR,
} from "./guard-decision";

describe("evaluateSyncGuard", () => {
  it("rejects with 503 when sync is disabled (before any session check)", () => {
    const r = evaluateSyncGuard(false, {
      user: { id: "u1", emailVerified: true },
    });
    expect(r).toEqual({
      ok: false,
      status: 503,
      error: SYNC_UNAVAILABLE_ERROR,
    });
  });

  it("rejects a disabled request even with no session", () => {
    expect(evaluateSyncGuard(false, null)).toMatchObject({ status: 503 });
  });

  it("rejects with 401 when there is no session", () => {
    expect(evaluateSyncGuard(true, null)).toEqual({
      ok: false,
      status: 401,
      error: SYNC_UNAUTHORIZED_ERROR,
    });
  });

  it("rejects with 401 when the session has no user", () => {
    expect(evaluateSyncGuard(true, { user: null })).toMatchObject({
      status: 401,
    });
  });

  it("rejects with 403 when the account is unverified", () => {
    expect(
      evaluateSyncGuard(true, { user: { id: "u1", emailVerified: false } }),
    ).toEqual({ ok: false, status: 403, error: SYNC_UNVERIFIED_ERROR });
  });

  it("authorises a verified user and returns the session user id", () => {
    expect(
      evaluateSyncGuard(true, {
        user: { id: "user-123", emailVerified: true },
      }),
    ).toEqual({ ok: true, userId: "user-123" });
  });

  it("never surfaces an enumeration signal (all rejections are fixed strings)", () => {
    const messages = new Set([
      SYNC_UNAVAILABLE_ERROR,
      SYNC_UNAUTHORIZED_ERROR,
      SYNC_UNVERIFIED_ERROR,
    ]);
    // The unauthorized message must not vary by whether a user exists.
    expect(messages.size).toBe(3);
    expect(SYNC_UNAUTHORIZED_ERROR).not.toContain("exist");
  });
});
