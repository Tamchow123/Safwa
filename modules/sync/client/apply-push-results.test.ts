import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SafwaDb } from "@/modules/content/db";
import type { SyncItemResult } from "@/modules/sync/protocol";

import { applyPushResults } from "./apply-push-results";

let db: SafwaDb;
let counter = 0;

beforeEach(async () => {
  db = new SafwaDb(`safwa-pushresults-test-${counter++}`);
  await db.open();
});

afterEach(() => db.close());

async function addEvent(eventId: string): Promise<void> {
  await db.reviewEvents.add({
    eventId,
    componentKey: "c",
    parentEventId: null,
    clientComponentRevision: 1,
    syncStatus: "local",
    createdAt: 1,
  });
}

function result(overrides: Partial<SyncItemResult>): SyncItemResult {
  return {
    itemId: "ev-1",
    itemKind: "event",
    status: "accepted",
    reasonCode: "accepted",
    duplicate: false,
    recoverable: false,
    ...overrides,
  };
}

describe("applyPushResults", () => {
  it("marks accepted/corrected/duplicate events as accepted", async () => {
    await addEvent("a");
    await addEvent("b");
    await addEvent("c");
    const changed = await applyPushResults(db, [
      result({ itemId: "a", status: "accepted" }),
      result({
        itemId: "b",
        status: "corrected",
        reasonCode: "correctness_corrected",
      }),
      result({
        itemId: "c",
        status: "duplicate",
        duplicate: true,
        reasonCode: "duplicate",
      }),
    ]);
    expect(changed).toBe(3);
    for (const id of ["a", "b", "c"]) {
      expect((await db.reviewEvents.get(id))?.syncStatus).toBe("accepted");
    }
  });

  it("marks a pending event as pushed", async () => {
    await addEvent("p");
    await applyPushResults(db, [
      result({
        itemId: "p",
        status: "pending",
        reasonCode: "pending_parent",
        recoverable: true,
      }),
    ]);
    expect((await db.reviewEvents.get("p"))?.syncStatus).toBe("pushed");
  });

  it("leaves a recoverable rejection local (retryable)", async () => {
    await addEvent("r");
    await applyPushResults(db, [
      result({
        itemId: "r",
        status: "rejected",
        reasonCode: "stale_branch_conflict",
        recoverable: true,
      }),
    ]);
    expect((await db.reviewEvents.get("r"))?.syncStatus).toBe("local");
  });

  it("marks a non-recoverable rejection as rejected (terminal)", async () => {
    await addEvent("x");
    await applyPushResults(db, [
      result({
        itemId: "x",
        status: "rejected",
        reasonCode: "payload_conflict",
        recoverable: false,
      }),
    ]);
    expect((await db.reviewEvents.get("x"))?.syncStatus).toBe("rejected");
  });

  it("ignores non-event results and unknown event ids", async () => {
    await addEvent("known");
    const changed = await applyPushResults(db, [
      result({ itemId: "5", itemKind: "bookmark", status: "accepted" }),
      result({ itemId: "unknown-event", status: "accepted" }),
    ]);
    expect(changed).toBe(0);
    expect((await db.reviewEvents.get("known"))?.syncStatus).toBe("local");
  });

  it("is a no-op when nothing changes (idempotent re-apply)", async () => {
    await addEvent("a");
    await applyPushResults(db, [result({ itemId: "a", status: "accepted" })]);
    const secondChange = await applyPushResults(db, [
      result({ itemId: "a", status: "accepted" }),
    ]);
    expect(secondChange).toBe(0);
  });
});
