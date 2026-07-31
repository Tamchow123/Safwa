import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getServerSessionMock = vi.fn();
vi.mock("@/modules/auth/session", () => ({
  getServerSession: () => getServerSessionMock(),
}));

const getAccountSettingsMock = vi.fn();
const upsertAccountSettingsMock = vi.fn();
const resetAccountSettingsMock = vi.fn();
vi.mock("@/modules/auth/account-settings", () => ({
  getAccountSettings: (...args: unknown[]) => getAccountSettingsMock(...args),
  upsertAccountSettings: (...args: unknown[]) =>
    upsertAccountSettingsMock(...args),
  resetAccountSettings: (...args: unknown[]) =>
    resetAccountSettingsMock(...args),
}));

// Phase 18.1: the route now asserts same-origin and consumes a rate limit
// before doing any work. Both need stubbing here — this is a unit test of the
// handler's own logic, and neither the app URL nor a Postgres counter is part
// of what it is asserting. Their own behaviour is covered by
// modules/auth/request-origin.test.ts and tests/integration/rate-limit.test.ts.
vi.mock("@/modules/env/server", () => ({
  getServerEnv: () => ({ appUrl: "http://localhost" }),
}));

const consumeRateLimitMock = vi.fn();
vi.mock("@/modules/sync/server/rate-limit", () => ({
  consumeRateLimit: (...args: unknown[]) => consumeRateLimitMock(...args),
  RATE_LIMITED_ERROR: "Too many requests. Please retry shortly.",
}));

import { DELETE, GET, PUT } from "@/app/api/account/settings/route";

/** A request as the app's own pages make it: same origin, same site. */
function sameOriginRequest(init?: RequestInit): Request {
  return new Request("http://localhost/api/account/settings", {
    ...init,
    headers: {
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
      ...(init?.headers ?? {}),
    },
  });
}

const SETTINGS = {
  theme: "system",
  arabicFontScale: "default",
  timezone: { mode: "browser" },
  sessionDefaults: {
    questionCount: 20,
    optionCount: 4,
    newPerDay: 10,
    reviewsPerDay: 20,
  },
};

beforeEach(() => {
  getServerSessionMock.mockReset();
  getAccountSettingsMock.mockReset();
  upsertAccountSettingsMock.mockReset();
  resetAccountSettingsMock.mockReset();
  consumeRateLimitMock.mockReset();
  consumeRateLimitMock.mockResolvedValue({ allowed: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/api/account/settings", () => {
  describe("GET", () => {
    it("returns 401 without a session, never reading settings", async () => {
      getServerSessionMock.mockResolvedValue(null);

      const response = await GET(sameOriginRequest());

      expect(response.status).toBe(401);
      expect(getAccountSettingsMock).not.toHaveBeenCalled();
    });

    it("returns the caller's own settings, looked up by the session's user id", async () => {
      getServerSessionMock.mockResolvedValue({ user: { id: "user-1" } });
      getAccountSettingsMock.mockResolvedValue(SETTINGS);

      const response = await GET(sameOriginRequest());

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ settings: SETTINGS });
      expect(getAccountSettingsMock).toHaveBeenCalledWith("user-1");
    });
  });

  describe("PUT", () => {
    it("returns 401 without a session, never writing settings", async () => {
      getServerSessionMock.mockResolvedValue(null);
      const request = new Request("http://localhost/api/account/settings", {
        method: "PUT",
        body: JSON.stringify({ theme: "dark" }),
      });

      const response = await PUT(request);

      expect(response.status).toBe(401);
      expect(upsertAccountSettingsMock).not.toHaveBeenCalled();
    });

    it("rejects an invalid body with a generic 400, never a raw Zod error", async () => {
      getServerSessionMock.mockResolvedValue({ user: { id: "user-1" } });
      const request = new Request("http://localhost/api/account/settings", {
        method: "PUT",
        body: JSON.stringify({ theme: "not-a-real-theme" }),
      });

      const response = await PUT(request);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid settings" });
      expect(upsertAccountSettingsMock).not.toHaveBeenCalled();
    });

    it("rejects an unrecognised top-level field (explicit allowlist, strict schema)", async () => {
      getServerSessionMock.mockResolvedValue({ user: { id: "user-1" } });
      const request = new Request("http://localhost/api/account/settings", {
        method: "PUT",
        body: JSON.stringify({
          theme: "dark",
          role: "admin",
          userId: "someone-elses-id",
        }),
      });

      const response = await PUT(request);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid settings" });
      expect(upsertAccountSettingsMock).not.toHaveBeenCalled();
    });

    it("never allows a caller-supplied user id to redirect the write to another user (rejected outright, not silently stripped)", async () => {
      getServerSessionMock.mockResolvedValue({ user: { id: "user-1" } });
      const request = new Request("http://localhost/api/account/settings", {
        method: "PUT",
        body: JSON.stringify({ theme: "dark", userId: "victim-user-id" }),
      });

      const response = await PUT(request);

      expect(response.status).toBe(400);
      expect(upsertAccountSettingsMock).not.toHaveBeenCalled();
    });

    it("rejects an unrecognised IANA timezone string instead of silently falling back", async () => {
      getServerSessionMock.mockResolvedValue({ user: { id: "user-1" } });
      const request = new Request("http://localhost/api/account/settings", {
        method: "PUT",
        body: JSON.stringify({
          timezone: { mode: "iana", timezone: "Not/A/Real/Zone" },
        }),
      });

      const response = await PUT(request);

      expect(response.status).toBe(400);
      expect(upsertAccountSettingsMock).not.toHaveBeenCalled();
    });

    it("rejects a fractional option count instead of silently rounding/clamping it", async () => {
      getServerSessionMock.mockResolvedValue({ user: { id: "user-1" } });
      const request = new Request("http://localhost/api/account/settings", {
        method: "PUT",
        body: JSON.stringify({
          sessionDefaults: {
            questionCount: 20,
            optionCount: 4.5,
            newPerDay: 10,
            reviewsPerDay: 20,
          },
        }),
      });

      const response = await PUT(request);

      expect(response.status).toBe(400);
      expect(upsertAccountSettingsMock).not.toHaveBeenCalled();
    });

    it("rejects an out-of-bounds session default instead of silently clamping it", async () => {
      getServerSessionMock.mockResolvedValue({ user: { id: "user-1" } });
      const request = new Request("http://localhost/api/account/settings", {
        method: "PUT",
        body: JSON.stringify({
          sessionDefaults: {
            questionCount: 20,
            optionCount: 9,
            newPerDay: 10,
            reviewsPerDay: 20,
          },
        }),
      });

      const response = await PUT(request);

      expect(response.status).toBe(400);
      expect(upsertAccountSettingsMock).not.toHaveBeenCalled();
    });

    it("rejects an unrecognised field nested inside sessionDefaults", async () => {
      getServerSessionMock.mockResolvedValue({ user: { id: "user-1" } });
      const request = new Request("http://localhost/api/account/settings", {
        method: "PUT",
        body: JSON.stringify({
          sessionDefaults: {
            questionCount: 20,
            optionCount: 4,
            newPerDay: 10,
            reviewsPerDay: 20,
            extraField: "sneaky",
          },
        }),
      });

      const response = await PUT(request);

      expect(response.status).toBe(400);
      expect(upsertAccountSettingsMock).not.toHaveBeenCalled();
    });

    it("accepts a valid IANA timezone", async () => {
      getServerSessionMock.mockResolvedValue({ user: { id: "user-1" } });
      upsertAccountSettingsMock.mockResolvedValue(SETTINGS);
      const request = new Request("http://localhost/api/account/settings", {
        method: "PUT",
        body: JSON.stringify({
          timezone: { mode: "iana", timezone: "Asia/Dubai" },
        }),
      });

      const response = await PUT(request);

      expect(response.status).toBe(200);
      expect(upsertAccountSettingsMock).toHaveBeenCalledWith("user-1", {
        timezone: { mode: "iana", timezone: "Asia/Dubai" },
      });
    });
  });

  describe("DELETE", () => {
    it("returns 401 without a session, never resetting settings", async () => {
      getServerSessionMock.mockResolvedValue(null);

      const response = await DELETE(sameOriginRequest({ method: "DELETE" }));

      expect(response.status).toBe(401);
      expect(resetAccountSettingsMock).not.toHaveBeenCalled();
    });

    it("resets the caller's own settings and returns the documented defaults", async () => {
      getServerSessionMock.mockResolvedValue({ user: { id: "user-1" } });
      resetAccountSettingsMock.mockResolvedValue(SETTINGS);

      const response = await DELETE(sameOriginRequest({ method: "DELETE" }));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ settings: SETTINGS });
      expect(resetAccountSettingsMock).toHaveBeenCalledWith("user-1");
    });
  });

  describe("cross-origin requests (Phase 18.1)", () => {
    it("refuses a foreign Origin before reading the session", async () => {
      // Before the session, deliberately: the refusal must not depend on
      // whether the caller happened to be signed in, or its presence would
      // itself answer that question for an attacker.
      const response = await GET(
        sameOriginRequest({ headers: { origin: "https://evil.example" } }),
      );

      expect(response.status).toBe(403);
      expect(getServerSessionMock).not.toHaveBeenCalled();
      expect(getAccountSettingsMock).not.toHaveBeenCalled();
    });

    it("refuses a cross-site navigation, which SameSite=Lax would still cookie", async () => {
      // The specific gap this check closes. A top-level GET navigation from
      // another origin sends no Origin header AND carries the session cookie,
      // so nothing else in the stack would have stopped it.
      const request = new Request("http://localhost/api/account/settings", {
        headers: { "sec-fetch-site": "cross-site" },
      });

      const response = await GET(request);

      expect(response.status).toBe(403);
      expect(getServerSessionMock).not.toHaveBeenCalled();
    });

    it("still serves a request carrying neither header", async () => {
      // The fail-safe direction. Older browsers send no Sec-Fetch-* and omit
      // Origin on same-origin GETs; refusing those would break real clients.
      getServerSessionMock.mockResolvedValue({ user: { id: "user-1" } });
      getAccountSettingsMock.mockResolvedValue(SETTINGS);

      const response = await GET(
        new Request("http://localhost/api/account/settings"),
      );

      expect(response.status).toBe(200);
    });
  });

  describe("rate limiting (Phase 18.1)", () => {
    it("refuses a limited caller with 429 and a Retry-After, doing no work", async () => {
      getServerSessionMock.mockResolvedValue({ user: { id: "user-1" } });
      consumeRateLimitMock.mockResolvedValue({
        allowed: false,
        retryAfterSeconds: 42,
      });

      const response = await GET(sameOriginRequest());

      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("42");
      expect(getAccountSettingsMock).not.toHaveBeenCalled();
    });

    it("counts against the session's account id, never a client-supplied one", async () => {
      getServerSessionMock.mockResolvedValue({ user: { id: "user-1" } });
      resetAccountSettingsMock.mockResolvedValue(SETTINGS);

      await DELETE(sameOriginRequest({ method: "DELETE" }));

      expect(consumeRateLimitMock).toHaveBeenCalledWith(
        "account-settings",
        "user-1",
      );
    });
  });
});
