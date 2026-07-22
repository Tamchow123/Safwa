import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://safwa:pw@localhost:5432/safwa_test",
  BETTER_AUTH_SECRET: "test-secret",
  BETTER_AUTH_URL: "http://localhost:3000",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
} as const;

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  process.env = { ...BASE_ENV } as unknown as NodeJS.ProcessEnv;
  vi.resetModules();
});

afterEach(() => {
  process.env = originalEnv;
});

describe("db/client", () => {
  it("importing the module never connects (no thrown error, no network attempt)", async () => {
    await expect(import("@/db/client")).resolves.toBeDefined();
  });

  it("getDb() is memoised across calls", async () => {
    const { getDb } = await import("@/db/client");
    const first = getDb();
    const second = getDb();
    expect(second).toBe(first);
  });

  it("closeDb() is a safe no-op when no pool was ever created", async () => {
    const { closeDb } = await import("@/db/client");
    await expect(closeDb()).resolves.toBeUndefined();
  });

  it("closeDb() after getDb() ends the pool and clears the memoised instance", async () => {
    const { getDb, closeDb } = await import("@/db/client");
    const first = getDb();
    await closeDb();
    const second = getDb();
    expect(second).not.toBe(first);
    await closeDb();
  });

  it("a getDb() call racing a not-yet-resolved closeDb() always gets a usable pool, never a half-closed one", async () => {
    const { getDb, closeDb } = await import("@/db/client");
    getDb();
    const closing = closeDb();
    const duringTeardown = getDb();
    expect(duringTeardown).toBeDefined();
    await closing;
    await closeDb();
  });
});

describe("requiresSsl", () => {
  it("always requires SSL in production", async () => {
    const { requiresSsl } = await import("@/db/client");
    expect(requiresSsl("postgres://localhost:5432/db", true)).toBe(true);
  });

  it("requires SSL when the connection string declares sslmode=require", async () => {
    const { requiresSsl } = await import("@/db/client");
    expect(requiresSsl("postgres://host:5432/db?sslmode=require", false)).toBe(
      true,
    );
  });

  it("does not require SSL for a loopback host outside production with no sslmode", async () => {
    const { requiresSsl } = await import("@/db/client");
    expect(requiresSsl("postgres://localhost:5432/safwa_dev", false)).toBe(
      false,
    );
  });

  it("requires SSL for a non-loopback host outside production even with no sslmode (fail-safe default)", async () => {
    const { requiresSsl } = await import("@/db/client");
    expect(requiresSsl("postgres://my-branch.neon.tech:5432/db", false)).toBe(
      true,
    );
  });

  it("fails safe (requires SSL) when the connection string cannot be parsed as a URL", async () => {
    const { requiresSsl } = await import("@/db/client");
    expect(requiresSsl("not-a-valid-url", false)).toBe(true);
  });
});
