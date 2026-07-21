import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://safwa:pw@localhost:5432/safwa_test",
  BETTER_AUTH_SECRET: "test-secret-value",
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

describe("modules/auth/server", () => {
  it("importing the module does not validate env or construct anything (lazy)", async () => {
    // Deliberately invalid env — if construction happened at import time,
    // this import would throw.
    process.env = { NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv;
    await expect(import("@/modules/auth/server")).resolves.toBeDefined();
  });

  it("getAuth() constructs a Better Auth instance exposing the expected handler/api surface", async () => {
    const { getAuth } = await import("@/modules/auth/server");
    const auth = getAuth();
    expect(auth.handler).toBeTypeOf("function");
    expect(auth.api).toBeDefined();
    expect(auth.api.getSession).toBeTypeOf("function");
    expect(auth.api.signInEmail).toBeTypeOf("function");
    expect(auth.api.signUpEmail).toBeTypeOf("function");
  });

  it("getAuth() is memoised across calls", async () => {
    const { getAuth } = await import("@/modules/auth/server");
    const first = getAuth();
    const second = getAuth();
    expect(second).toBe(first);
  });

  it("getAuth() surfaces a clear error when the environment is invalid, only when actually called", async () => {
    process.env = { NODE_ENV: "test" } as unknown as NodeJS.ProcessEnv;
    const { getAuth } = await import("@/modules/auth/server");
    expect(() => getAuth()).toThrow(/DATABASE_URL/);
  });
});
