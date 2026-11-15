/**
 * The E2E outbox reader decides which of several emails to one address is the
 * newest. Phase 18.3's auth specs ask for a second and a third verification
 * email to the same learner and must prove each one arrived, so "newest" has
 * to mean write order. File mtime cannot promise that — two writes can share
 * a tick, and a tie then falls back to directory order — so the reader orders
 * by the `createdAt` the sending server stamps, and these tests pin that with
 * the mtimes deliberately made identical.
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const outbox = vi.hoisted(() => ({ dir: "" }));

vi.mock("@/e2e/helpers/e2e-server-env", () => ({
  get E2E_EMAIL_OUTBOX_DIR() {
    return outbox.dir;
  },
}));

import {
  latestOutboxMessage,
  type OutboxRecord,
  waitForNewOutboxMessage,
} from "@/e2e/helpers/email-outbox";

const TO = "learner@example.test";
const SAME_MTIME = new Date("2026-11-15T12:00:00Z");

function record(id: string, createdAt: string): OutboxRecord {
  return {
    id,
    template: "verify-email",
    to: TO,
    subject: "Verify your email",
    html: "",
    text: "",
    createdAt,
  };
}

/** Writes a message under `fileName`, with every file's mtime identical. */
function write(fileName: string, message: OutboxRecord): void {
  const filePath = path.join(outbox.dir, fileName);
  writeFileSync(filePath, JSON.stringify(message));
  utimesSync(filePath, SAME_MTIME, SAME_MTIME);
}

beforeEach(() => {
  outbox.dir = mkdtempSync(path.join(tmpdir(), "safwa-outbox-test-"));
});

afterEach(() => {
  rmSync(outbox.dir, { recursive: true, force: true });
});

// Named so that directory order lists the OLDER message first: with equal
// mtimes, an mtime sort would keep that order and report the older one.
const FIRST = record("first", "2026-11-15T12:00:01.000Z");
const SECOND = record("second", "2026-11-15T12:00:03.000Z");
const THIRD = record("third", "2026-11-15T12:00:05.000Z");

describe("latestOutboxMessage", () => {
  it("returns the newest message by createdAt when mtimes tie", async () => {
    write("a-first.json", FIRST);
    write("b-second.json", SECOND);
    expect((await latestOutboxMessage(TO, "verify-email"))?.id).toBe("second");
  });

  it("does not depend on which file directory order lists first", async () => {
    write("a-second.json", SECOND);
    write("b-first.json", FIRST);
    expect((await latestOutboxMessage(TO, "verify-email"))?.id).toBe("second");
  });
});

describe("waitForNewOutboxMessage", () => {
  it("returns a message written after the previous one, despite tied mtimes", async () => {
    write("a-first.json", FIRST);
    write("b-second.json", SECOND);
    const next = await waitForNewOutboxMessage(TO, "verify-email", FIRST, 500);
    expect(next.id).toBe("second");
  });

  it("never mistakes an OLDER message for the new one", async () => {
    // The 60.4 shape: sign-up email, then two resends. Waiting for the one
    // after SECOND must yield THIRD, never FIRST, which also differs from it.
    write("a-first.json", FIRST);
    write("b-second.json", SECOND);
    await expect(
      waitForNewOutboxMessage(TO, "verify-email", SECOND, 400),
    ).rejects.toThrow(/timed out/);

    write("c-third.json", THIRD);
    const next = await waitForNewOutboxMessage(TO, "verify-email", SECOND, 500);
    expect(next.id).toBe("third");
  });
});
