import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { clearLocalOutbox } from "@/modules/email/clear-outbox";
import { resetServerEnvCacheForTests } from "@/modules/env/server";

const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://user:pass@localhost:5432/db",
  BETTER_AUTH_SECRET: "test-secret-not-real-but-long-enough-for-tests",
  BETTER_AUTH_URL: "https://safwa.example.com",
  NEXT_PUBLIC_APP_URL: "https://safwa.example.com",
  EMAIL_TRANSPORT: "console-file",
};

let outboxDir: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(async () => {
  originalEnv = { ...process.env };
  outboxDir = await mkdtemp(join(tmpdir(), "safwa-clear-outbox-"));
  Object.assign(process.env, BASE_ENV, { EMAIL_OUTBOX_DIR: outboxDir });
  resetServerEnvCacheForTests();
});

afterEach(async () => {
  process.env = originalEnv;
  resetServerEnvCacheForTests();
  await rm(outboxDir, { recursive: true, force: true });
});

describe("clearLocalOutbox", () => {
  it("removes every file from the configured outbox directory", async () => {
    await writeFile(join(outboxDir, "message-1.json"), "{}", "utf8");
    await writeFile(join(outboxDir, "message-2.json"), "{}", "utf8");
    expect(await readdir(outboxDir)).toHaveLength(2);

    await clearLocalOutbox();

    expect(await readdir(outboxDir)).toHaveLength(0);
  });

  it("refuses to run when NODE_ENV=production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.BETTER_AUTH_URL = "https://safwa.example.com";
    process.env.NEXT_PUBLIC_APP_URL = "https://safwa.example.com";
    process.env.BETTER_AUTH_SECRET = "a".repeat(32);
    process.env.ALLOW_DEV_EMAIL_TRANSPORT_IN_PRODUCTION = "true";
    resetServerEnvCacheForTests();

    try {
      await writeFile(join(outboxDir, "message-1.json"), "{}", "utf8");
      await expect(clearLocalOutbox()).rejects.toThrow(/production/i);
      expect(await readdir(outboxDir)).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
