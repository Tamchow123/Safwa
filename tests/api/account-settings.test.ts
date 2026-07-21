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

import { DELETE, GET, PUT } from "@/app/api/account/settings/route";

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
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/api/account/settings", () => {
  describe("GET", () => {
    it("returns 401 without a session, never reading settings", async () => {
      getServerSessionMock.mockResolvedValue(null);

      const response = await GET();

      expect(response.status).toBe(401);
      expect(getAccountSettingsMock).not.toHaveBeenCalled();
    });

    it("returns the caller's own settings, looked up by the session's user id", async () => {
      getServerSessionMock.mockResolvedValue({ user: { id: "user-1" } });
      getAccountSettingsMock.mockResolvedValue(SETTINGS);

      const response = await GET();

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

    it("strips unknown fields before forwarding to upsertAccountSettings (explicit allowlist)", async () => {
      getServerSessionMock.mockResolvedValue({ user: { id: "user-1" } });
      upsertAccountSettingsMock.mockResolvedValue(SETTINGS);
      const request = new Request("http://localhost/api/account/settings", {
        method: "PUT",
        body: JSON.stringify({
          theme: "dark",
          role: "admin",
          userId: "someone-elses-id",
        }),
      });

      const response = await PUT(request);

      expect(response.status).toBe(200);
      expect(upsertAccountSettingsMock).toHaveBeenCalledWith("user-1", {
        theme: "dark",
      });
    });

    it("never allows a caller-supplied user id to redirect the write to another user", async () => {
      getServerSessionMock.mockResolvedValue({ user: { id: "user-1" } });
      upsertAccountSettingsMock.mockResolvedValue(SETTINGS);
      const request = new Request("http://localhost/api/account/settings", {
        method: "PUT",
        body: JSON.stringify({ theme: "dark", userId: "victim-user-id" }),
      });

      await PUT(request);

      expect(upsertAccountSettingsMock).toHaveBeenCalledWith(
        "user-1",
        expect.not.objectContaining({ userId: expect.anything() }),
      );
    });
  });

  describe("DELETE", () => {
    it("returns 401 without a session, never resetting settings", async () => {
      getServerSessionMock.mockResolvedValue(null);

      const response = await DELETE();

      expect(response.status).toBe(401);
      expect(resetAccountSettingsMock).not.toHaveBeenCalled();
    });

    it("resets the caller's own settings and returns the documented defaults", async () => {
      getServerSessionMock.mockResolvedValue({ user: { id: "user-1" } });
      resetAccountSettingsMock.mockResolvedValue(SETTINGS);

      const response = await DELETE();

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ settings: SETTINGS });
      expect(resetAccountSettingsMock).toHaveBeenCalledWith("user-1");
    });
  });
});
