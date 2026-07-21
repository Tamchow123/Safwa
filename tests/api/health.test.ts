import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const executeMock = vi.fn();
const transactionMock = vi.fn(
  async (callback: (tx: { execute: typeof executeMock }) => Promise<void>) =>
    callback({ execute: executeMock }),
);
vi.mock("@/db/client", () => ({
  getDb: () => ({ transaction: transactionMock }),
}));

const getActiveReleaseMock = vi.fn();
vi.mock("@/modules/content/server-release-registry", () => ({
  getActiveRelease: () => getActiveReleaseMock(),
}));

const getServerEnvMock = vi.fn();
vi.mock("@/modules/env/server", () => ({
  getServerEnv: () => getServerEnvMock(),
}));

import { GET } from "@/app/api/health/route";

beforeEach(() => {
  executeMock.mockReset();
  executeMock.mockResolvedValue(undefined);
  transactionMock.mockClear();
  getActiveReleaseMock.mockReset();
  getServerEnvMock.mockReset();
  getServerEnvMock.mockReturnValue({ authEnabled: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/api/health", () => {
  it("returns 200 and status ok when the database and content release are both healthy", async () => {
    getActiveReleaseMock.mockResolvedValue({ releaseId: "release-2026-01" });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      database: "ok",
      activeReleaseId: "release-2026-01",
      authEnabled: true,
    });
  });

  it("returns 503 and status unhealthy when the database is unreachable, without leaking the raw error", async () => {
    executeMock.mockRejectedValue(
      new Error(
        "connection refused to postgres://user:secret@10.0.0.5:5432/db",
      ),
    );
    getActiveReleaseMock.mockResolvedValue({ releaseId: "release-2026-01" });

    const response = await GET();

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.status).toBe("unhealthy");
    expect(body.database).toBe("unreachable");
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(JSON.stringify(body)).not.toContain("postgres://");
  });

  it("returns 503 when the active content release cannot be resolved, without leaking manifest error details", async () => {
    getActiveReleaseMock.mockRejectedValue(
      new Error(
        "checksum mismatch for release-2026-01 at /var/content-server/releases",
      ),
    );

    const response = await GET();

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.status).toBe("unhealthy");
    expect(body.activeReleaseId).toBeNull();
    expect(JSON.stringify(body)).not.toContain("checksum mismatch");
    expect(JSON.stringify(body)).not.toContain("/var/content-server");
  });

  it("returns 503 when the server environment is invalid, without leaking the raw validation error", async () => {
    getActiveReleaseMock.mockResolvedValue({ releaseId: "release-2026-01" });
    getServerEnvMock.mockImplementation(() => {
      throw new Error(
        "Invalid server environment configuration:\n- BETTER_AUTH_URL must be a valid URL",
      );
    });

    const response = await GET();

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.status).toBe("unhealthy");
    expect(body.authEnabled).toBeNull();
    expect(Object.keys(body).sort()).toEqual([
      "activeReleaseId",
      "authEnabled",
      "database",
      "status",
    ]);
    expect(JSON.stringify(body)).not.toContain("BETTER_AUTH_URL");
  });

  it("never returns a raw DATABASE_URL, env dump, or stack trace in the response body", async () => {
    executeMock.mockRejectedValue(new Error("boom"));
    getActiveReleaseMock.mockRejectedValue(new Error("boom"));

    const response = await GET();
    const body = await response.json();

    expect(Object.keys(body).sort()).toEqual([
      "activeReleaseId",
      "authEnabled",
      "database",
      "status",
    ]);
  });

  it("reports authEnabled: false without treating that as unhealthy on its own", async () => {
    getServerEnvMock.mockReturnValue({ authEnabled: false });
    getActiveReleaseMock.mockResolvedValue({ releaseId: "release-2026-01" });

    const response = await GET();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.authEnabled).toBe(false);
    expect(body.status).toBe("ok");
  });

  it("treats a hung database check as unhealthy rather than hanging the request", async () => {
    vi.useFakeTimers();
    executeMock.mockReturnValue(new Promise(() => {}));
    getActiveReleaseMock.mockResolvedValue({ releaseId: "release-2026-01" });

    const responsePromise = GET();
    await vi.advanceTimersByTimeAsync(5_000);
    const response = await responsePromise;

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.database).toBe("unreachable");
    vi.useRealTimers();
  });
});
