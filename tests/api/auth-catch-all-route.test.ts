import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getAuthMock = vi.fn();
vi.mock("@/modules/auth/server", () => ({
  getAuth: () => getAuthMock(),
}));

const getServerEnvMock = vi.fn();
vi.mock("@/modules/env/server", () => ({
  getServerEnv: () => getServerEnvMock(),
}));

import { GET, POST } from "@/app/api/auth/[...all]/route";

beforeEach(() => {
  getAuthMock.mockReset();
  getServerEnvMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/api/auth/[...all] route", () => {
  it("returns a safe 503 and never calls getAuth() (never constructs Better Auth) when AUTH_ENABLED is false", async () => {
    getServerEnvMock.mockReturnValue({ authEnabled: false });
    const request = new Request("http://localhost:3000/api/auth/session");

    const response = await GET(request);

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({
      error: "Authentication is currently unavailable.",
    });
    expect(getAuthMock).not.toHaveBeenCalled();
  });

  it("returns the same safe unavailable response for POST when AUTH_ENABLED is false", async () => {
    getServerEnvMock.mockReturnValue({ authEnabled: false });
    const request = new Request(
      "http://localhost:3000/api/auth/sign-up/email",
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );

    const response = await POST(request);

    expect(response.status).toBe(503);
    expect(getAuthMock).not.toHaveBeenCalled();
  });

  it("delegates GET to the Better Auth handler when AUTH_ENABLED is true", async () => {
    getServerEnvMock.mockReturnValue({ authEnabled: true });
    const handlerMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    getAuthMock.mockReturnValue({ handler: handlerMock });
    const request = new Request("http://localhost:3000/api/auth/get-session");

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(handlerMock).toHaveBeenCalledWith(request);
  });

  it("delegates POST to the Better Auth handler when AUTH_ENABLED is true", async () => {
    getServerEnvMock.mockReturnValue({ authEnabled: true });
    const handlerMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    getAuthMock.mockReturnValue({ handler: handlerMock });
    const request = new Request(
      "http://localhost:3000/api/auth/sign-in/email",
      { method: "POST", body: JSON.stringify({}) },
    );

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(handlerMock).toHaveBeenCalledWith(request);
  });
});
