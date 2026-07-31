import { describe, expect, it } from "vitest";

import {
  evaluateSyncGuard,
  SYNC_UNAUTHORIZED_ERROR,
  SYNC_UNAVAILABLE_ERROR,
  SYNC_UNVERIFIED_ERROR,
  type SyncGuardRefusal,
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
      reason: "disabled",
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
      reason: "unauthenticated",
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
    ).toEqual({
      ok: false,
      status: 403,
      error: SYNC_UNVERIFIED_ERROR,
      reason: "unverified",
    });
  });

  it("authorises a verified user and returns the session user id", () => {
    expect(
      evaluateSyncGuard(true, {
        user: { id: "user-123", emailVerified: true },
      }),
    ).toEqual({ ok: true, userId: "user-123" });
  });

  it("names its reason, because the status alone is ambiguous", () => {
    // Phase 18.1. Two different refusals are both 403 — an unverified email
    // and a cross-origin request (added in auth-guard.ts, which cannot be
    // reached from this pure module). Only one of them is something a learner
    // can act on. Callers that translate a refusal into learner-facing
    // language must branch on `reason`; a caller reading the number would tell
    // someone arriving from another site to verify an email that is already
    // verified. This asserts the field a translator depends on is present and
    // distinct.
    const unverified = evaluateSyncGuard(true, {
      user: { id: "u1", emailVerified: false },
    });
    expect(unverified.ok).toBe(false);
    if (unverified.ok) return;
    expect(unverified.reason).toBe("unverified");
    expect(unverified.status).toBe(403);
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

  it("has a reason vocabulary every translator must handle exhaustively", () => {
    // Phase 18.1 / council TEST-004. The risk this guards is not a wrong
    // mapping — it is a SILENT one: `guestMergeGuardReason` switches over
    // SyncGuardRefusal with no `default`, so adding a member without adding a
    // case makes it return undefined at runtime while still compiling if the
    // return type is ever widened. Naming the full set here means adding a
    // member forces a decision about what the learner is told.
    const every: Record<SyncGuardRefusal, true> = {
      disabled: true,
      unauthenticated: true,
      unverified: true,
      "cross-origin": true,
    };
    expect(Object.keys(every).sort()).toEqual([
      "cross-origin",
      "disabled",
      "unauthenticated",
      "unverified",
    ]);
  });
});
