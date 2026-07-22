import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { FakeAuthDisabledError, getAuthMock } = vi.hoisted(() => {
  class FakeAuthDisabledError extends Error {
    constructor() {
      super("Authentication is disabled (AUTH_ENABLED=false)");
      this.name = "AuthDisabledError";
    }
  }
  return { FakeAuthDisabledError, getAuthMock: vi.fn() };
});
vi.mock("@/modules/auth/server", () => ({
  getAuth: () => getAuthMock(),
  AuthDisabledError: FakeAuthDisabledError,
}));

const headersMock = vi.fn().mockResolvedValue(new Headers());
vi.mock("next/headers", () => ({
  headers: () => headersMock(),
}));

import { getServerSession } from "@/modules/auth/session";

beforeEach(() => {
  getAuthMock.mockReset();
  headersMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getServerSession", () => {
  it("calls auth.api.getSession with the awaited request headers", async () => {
    const getSessionMock = vi.fn().mockResolvedValue({
      session: { id: "session-1" },
      user: { id: "user-1" },
    });
    getAuthMock.mockReturnValue({ api: { getSession: getSessionMock } });

    const result = await getServerSession();

    expect(headersMock).toHaveBeenCalledTimes(1);
    expect(getSessionMock).toHaveBeenCalledWith({
      headers: expect.any(Headers),
    });
    expect(result).toEqual({
      session: { id: "session-1" },
      user: { id: "user-1" },
    });
  });

  it("returns null (never throws) when auth is disabled", async () => {
    getAuthMock.mockImplementation(() => {
      throw new FakeAuthDisabledError();
    });

    await expect(getServerSession()).resolves.toBeNull();
  });

  it("re-throws any other error from getAuth()", async () => {
    getAuthMock.mockImplementation(() => {
      throw new Error("Invalid server environment configuration");
    });

    await expect(getServerSession()).rejects.toThrow(
      "Invalid server environment configuration",
    );
  });
});
