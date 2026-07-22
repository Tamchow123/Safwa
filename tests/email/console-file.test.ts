import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  clearOutbox,
  createConsoleFileTransport,
} from "@/modules/email/transports/console-file";

let outboxDir: string;

beforeEach(async () => {
  outboxDir = await mkdtemp(join(tmpdir(), "safwa-email-outbox-"));
});

afterEach(async () => {
  await rm(outboxDir, { recursive: true, force: true });
});

describe("createConsoleFileTransport", () => {
  it("writes one JSON file per message recording every required field", async () => {
    const fixedDate = new Date("2026-01-15T10:00:00.000Z");
    const transport = createConsoleFileTransport({
      outboxDir,
      now: () => fixedDate,
      generateId: () => "fixed-id-1",
      quiet: true,
    });

    const result = await transport.send({
      template: "verify-email",
      to: "learner@example.com",
      data: { url: "https://safwa.example.com/verify-email?token=abc" },
      idempotencyKey: "key-1",
    });

    expect(result).toEqual({ success: true, messageId: "fixed-id-1" });

    const files = await readdir(outboxDir);
    expect(files).toEqual(["fixed-id-1.json"]);

    const record = JSON.parse(
      await readFile(join(outboxDir, "fixed-id-1.json"), "utf8"),
    );
    expect(record).toEqual({
      id: "fixed-id-1",
      template: "verify-email",
      to: "learner@example.com",
      subject: expect.stringMatching(/verify/i),
      html: expect.stringContaining(
        "https://safwa.example.com/verify-email?token=abc",
      ),
      text: expect.stringContaining(
        "https://safwa.example.com/verify-email?token=abc",
      ),
      createdAt: fixedDate.toISOString(),
    });
  });

  it("leaves no partially-written or temp file behind after a successful send", async () => {
    const transport = createConsoleFileTransport({
      outboxDir,
      generateId: () => "fixed-id-2",
      quiet: true,
    });
    await transport.send({
      template: "reset-password",
      to: "learner@example.com",
      data: { url: "https://safwa.example.com/reset-password?token=abc" },
      idempotencyKey: "key-2",
    });

    const files = await readdir(outboxDir);
    expect(files).toEqual(["fixed-id-2.json"]);
    expect(files.some((f) => f.includes(".tmp"))).toBe(false);
  });

  it("generates a distinct random id per message by default", async () => {
    const transport = createConsoleFileTransport({ outboxDir, quiet: true });
    const a = await transport.send({
      template: "delete-account",
      to: "a@example.com",
      data: { url: "https://safwa.example.com/delete-account?token=a" },
      idempotencyKey: "key-a",
    });
    const b = await transport.send({
      template: "delete-account",
      to: "b@example.com",
      data: { url: "https://safwa.example.com/delete-account?token=b" },
      idempotencyKey: "key-b",
    });
    expect(a.success && b.success && a.messageId).not.toBe(
      a.success && b.success && b.messageId,
    );

    const files = await readdir(outboxDir);
    expect(files).toHaveLength(2);
  });

  it("suppresses the console notice when quiet is set", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const transport = createConsoleFileTransport({
        outboxDir,
        quiet: true,
      });
      await transport.send({
        template: "verify-email",
        to: "learner@example.com",
        data: { url: "https://safwa.example.com/verify-email?token=abc" },
        idempotencyKey: "key-3",
      });
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("prints a concise local-only notice by default", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const transport = createConsoleFileTransport({
        outboxDir,
        generateId: () => "fixed-id-4",
      });
      await transport.send({
        template: "verify-email",
        to: "learner@example.com",
        data: { url: "https://safwa.example.com/verify-email?token=abc" },
        idempotencyKey: "key-4",
      });
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("fixed-id-4"),
      );
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("clearOutbox", () => {
  it("removes every file in the outbox and leaves the directory usable", async () => {
    const transport = createConsoleFileTransport({
      outboxDir,
      generateId: () => "fixed-id-5",
      quiet: true,
    });
    await transport.send({
      template: "verify-email",
      to: "learner@example.com",
      data: { url: "https://safwa.example.com/verify-email?token=abc" },
      idempotencyKey: "key-5",
    });
    expect(await readdir(outboxDir)).toHaveLength(1);

    await clearOutbox(outboxDir);
    expect(await readdir(outboxDir)).toHaveLength(0);

    // The directory must still be usable afterwards.
    await transport.send({
      template: "verify-email",
      to: "learner@example.com",
      data: { url: "https://safwa.example.com/verify-email?token=def" },
      idempotencyKey: "key-6",
    });
    expect(await readdir(outboxDir)).toHaveLength(1);
  });

  it("is safe to call on a directory that does not exist yet", async () => {
    const missingDir = join(outboxDir, "does-not-exist-yet");
    await expect(clearOutbox(missingDir)).resolves.toBeUndefined();
  });
});
