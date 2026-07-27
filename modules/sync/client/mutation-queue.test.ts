import "fake-indexeddb/auto";

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SafwaDb } from "@/modules/content/db";
import type {
  SyncItemResult,
  WireAttempt,
  WireRevocation,
} from "@/modules/sync/protocol";

import {
  applyQueueResults,
  countDeadLetterMutations,
  countPendingMutations,
  enqueueBookmarkMutation,
  enqueueListMutation,
  enqueueReinforcementMutation,
  enqueueRevocationMutation,
  enqueueSettingMutation,
  selectQueuedMutations,
} from "./mutation-queue";

let db: SafwaDb;
let counter = 0;

beforeEach(async () => {
  db = new SafwaDb(`safwa-mutation-queue-test-${counter++}`);
  await db.open();
});

afterEach(() => db.close());

const USER = "user-1";

function result(over: Partial<SyncItemResult>): SyncItemResult {
  return {
    itemId: "x",
    itemKind: "bookmark",
    status: "accepted",
    reasonCode: "accepted",
    duplicate: false,
    recoverable: false,
    ...over,
  } as SyncItemResult;
}

function makeRevocation(over: Partial<WireRevocation> = {}): WireRevocation {
  return {
    revocationId: randomUUID(),
    eventId: randomUUID(),
    studyComponentId:
      "entry:1:skill:meaning_recognition:field:madi:direction:arabic_to_english",
    deviceId: "device-1",
    occurredAtClient: "2026-07-20T10:00:00.000Z",
    ...over,
  };
}

function makeReinforcementAttempt(id = randomUUID()): WireAttempt {
  return {
    id,
    sessionId: randomUUID(),
    deviceId: "device-1",
    studyComponentId:
      "entry:1:skill:meaning_recognition:field:madi:direction:arabic_to_english",
    entryId: 1,
    skillTypeId: "meaning_recognition",
    sourceField: "madi",
    direction: "arabic_to_english",
    promptField: "madi",
    promptRef: { entryId: 1, field: "madi" },
    selectedAnswerRef: { entryId: 1, field: "meaning" },
    correctAnswerRef: { entryId: 1, field: "meaning" },
    isCorrect: true,
    isFirstAttempt: false,
    isReinforcement: true,
    hintUsed: false,
    hintType: null,
    responseTimeMs: 3000,
    questionPosition: 0,
    mode: "mc",
    optionCount: 4,
    perQuestionLimitMs: null,
    questionInstanceId: "qi",
    questionSeed: "seed",
    questionGeneratorVersion: "1",
    releaseId: "rel-1",
    contentVersion: "v1",
    occurredAtUtc: "2026-07-20T10:00:00.000Z",
    timezoneAtEvent: "UTC",
    utcOffsetMinutesAtEvent: 0,
    localDateAtEvent: "2026-07-20",
    timezoneSource: "browser_detected",
  };
}

describe("enqueue + select", () => {
  it("selects an account's queued mutations bucketed per category", async () => {
    await enqueueBookmarkMutation(db, {
      userId: USER,
      entryId: 5,
      createdAt: 100,
      deleted: false,
      now: 1,
    });
    await enqueueSettingMutation(db, {
      userId: USER,
      key: "arabicFontScale",
      value: 1.2,
      updatedAt: 100,
      now: 2,
    });
    await enqueueRevocationMutation(db, {
      userId: USER,
      revocation: makeRevocation(),
      now: 3,
    });
    await enqueueReinforcementMutation(db, {
      userId: USER,
      attempt: makeReinforcementAttempt(),
      now: 4,
    });

    const sel = await selectQueuedMutations(db, USER);
    expect(sel.bookmarks).toHaveLength(1);
    expect(sel.bookmarks[0]).toMatchObject({ entryId: 5, deleted: false });
    expect(sel.settings).toHaveLength(1);
    expect(sel.settings[0]?.key).toBe("arabicFontScale");
    expect(sel.revocations).toHaveLength(1);
    expect(sel.reinforcementAttempts).toHaveLength(1);
  });

  it("does NOT select another account's or a guest's queued rows (EXT-F1)", async () => {
    await enqueueBookmarkMutation(db, {
      userId: "user-2",
      entryId: 5,
      createdAt: 1,
      deleted: false,
      now: 1,
    });
    // A guest row (owner recorded as the literal, non-matching account) is a
    // stand-in for null-owner rows the selector must never send for USER.
    const sel = await selectQueuedMutations(db, USER);
    expect(sel.bookmarks).toHaveLength(0);
    expect(await countPendingMutations(db, USER)).toBe(0);
  });

  it("coalesces repeated bookmark mutations for the same entry (latest wins)", async () => {
    await enqueueBookmarkMutation(db, {
      userId: USER,
      entryId: 5,
      createdAt: 1,
      deleted: false,
      now: 1,
    });
    await enqueueBookmarkMutation(db, {
      userId: USER,
      entryId: 5,
      createdAt: 1,
      deleted: true,
      now: 2,
    });
    const sel = await selectQueuedMutations(db, USER);
    expect(sel.bookmarks).toHaveLength(1);
    expect(sel.bookmarks[0]?.deleted).toBe(true); // the newer state
    expect(await db.mutationQueue.count()).toBe(1); // old row superseded
  });

  it("coalesces list mutations per id but keeps different ids distinct", async () => {
    const listA = {
      id: randomUUID(),
      name: "A",
      entryIds: [1],
      createdAt: 1,
      updatedAt: 1,
    };
    const listB = {
      id: randomUUID(),
      name: "B",
      entryIds: [2],
      createdAt: 1,
      updatedAt: 1,
    };
    await enqueueListMutation(db, {
      userId: USER,
      list: listA,
      deleted: false,
      now: 1,
    });
    await enqueueListMutation(db, {
      userId: USER,
      list: { ...listA, name: "A2", updatedAt: 2 },
      deleted: false,
      now: 2,
    });
    await enqueueListMutation(db, {
      userId: USER,
      list: listB,
      deleted: false,
      now: 3,
    });
    const sel = await selectQueuedMutations(db, USER);
    expect(sel.lists).toHaveLength(2);
    expect(sel.lists.find((l) => l.id === listA.id)?.name).toBe("A2");
  });

  it("de-duplicates an append-only revocation by revocationId", async () => {
    const rev = makeRevocation();
    await enqueueRevocationMutation(db, {
      userId: USER,
      revocation: rev,
      now: 1,
    });
    await enqueueRevocationMutation(db, {
      userId: USER,
      revocation: rev,
      now: 2,
    });
    expect(await db.mutationQueue.count()).toBe(1);
  });

  it("de-duplicates an append-only reinforcement attempt by id", async () => {
    const att = makeReinforcementAttempt();
    await enqueueReinforcementMutation(db, {
      userId: USER,
      attempt: att,
      now: 1,
    });
    await enqueueReinforcementMutation(db, {
      userId: USER,
      attempt: att,
      now: 2,
    });
    expect(await db.mutationQueue.count()).toBe(1);
  });

  it("drops a payload that fails wire validation instead of sending it", async () => {
    // Seed a structurally-broken row directly (bypassing the typed enqueuer).
    await db.mutationQueue.add({
      idempotencyKey: randomUUID(),
      type: "bookmark",
      target: "9",
      userId: USER,
      status: "local",
      attempts: 0,
      payload: { entryId: -1, createdAt: 1, deleted: false }, // entryId < 1
      createdAt: 1,
    });
    const sel = await selectQueuedMutations(db, USER);
    expect(sel.bookmarks).toHaveLength(0);
  });
});

describe("applyQueueResults", () => {
  it("deletes a row on accepted/duplicate and keeps a recoverable rejection local", async () => {
    await enqueueBookmarkMutation(db, {
      userId: USER,
      entryId: 5,
      createdAt: 1,
      deleted: false,
      now: 1,
    });
    await enqueueSettingMutation(db, {
      userId: USER,
      key: "theme",
      value: "dark",
      updatedAt: 1,
      now: 2,
    });
    await applyQueueResults(db, USER, [
      result({ itemKind: "bookmark", itemId: "5", status: "accepted" }),
      // internal_error is recoverable — the setting must stay queued for retry.
      result({
        itemKind: "setting",
        itemId: "theme",
        status: "rejected",
        reasonCode: "internal_error",
        recoverable: true,
      }),
    ]);
    const sel = await selectQueuedMutations(db, USER);
    expect(sel.bookmarks).toHaveLength(0); // accepted → removed
    expect(sel.settings).toHaveLength(1); // recoverable reject → still sendable
    expect(await countPendingMutations(db, USER)).toBe(1);
  });

  it("dead-letters a non-recoverable rejection (retained, excluded from pending)", async () => {
    await enqueueSettingMutation(db, {
      userId: USER,
      key: "arabicFontScale",
      value: 999,
      updatedAt: 1,
      now: 1,
    });
    await applyQueueResults(db, USER, [
      result({
        itemKind: "setting",
        itemId: "arabicFontScale",
        status: "rejected",
        reasonCode: "invalid_setting_key",
        recoverable: false,
      }),
    ]);
    // Retained, not dropped — but no longer sent or counted as pending.
    expect(await db.mutationQueue.count()).toBe(1);
    expect(await countDeadLetterMutations(db, USER)).toBe(1);
    expect(await countPendingMutations(db, USER)).toBe(0);
    expect((await selectQueuedMutations(db, USER)).settings).toHaveLength(0);
  });

  it("maps a reinforcement (attempt) result to its queued row by id", async () => {
    const att = makeReinforcementAttempt();
    await enqueueReinforcementMutation(db, {
      userId: USER,
      attempt: att,
      now: 1,
    });
    await applyQueueResults(db, USER, [
      result({ itemKind: "attempt", itemId: att.id, status: "accepted" }),
    ]);
    expect(await db.mutationQueue.count()).toBe(0);
  });

  it("ignores event results (handled by the scheduling path)", async () => {
    await enqueueBookmarkMutation(db, {
      userId: USER,
      entryId: 5,
      createdAt: 1,
      deleted: false,
      now: 1,
    });
    const changed = await applyQueueResults(db, USER, [
      result({ itemKind: "event", itemId: randomUUID(), status: "accepted" }),
    ]);
    expect(changed).toBe(0);
    expect(await db.mutationQueue.count()).toBe(1);
  });
});

describe("countPendingMutations", () => {
  it("counts only the active account's non-dead rows", async () => {
    await enqueueBookmarkMutation(db, {
      userId: USER,
      entryId: 5,
      createdAt: 1,
      deleted: false,
      now: 1,
    });
    await enqueueBookmarkMutation(db, {
      userId: "user-2",
      entryId: 6,
      createdAt: 1,
      deleted: false,
      now: 2,
    });
    expect(await countPendingMutations(db, USER)).toBe(1);
  });

  it("does not count another account's or a dead-lettered row", async () => {
    // Many unrelated-account rows: the indexed count must ignore them all.
    for (let i = 0; i < 10; i++) {
      await enqueueBookmarkMutation(db, {
        userId: `other-${i}`,
        entryId: 100 + i,
        createdAt: 1,
        deleted: false,
        now: i,
      });
    }
    await enqueueSettingMutation(db, {
      userId: USER,
      key: "arabicFontScale",
      value: 999,
      updatedAt: 1,
      now: 20,
    });
    await applyQueueResults(db, USER, [
      result({
        itemKind: "setting",
        itemId: "arabicFontScale",
        status: "rejected",
        reasonCode: "invalid_setting_key",
        recoverable: false,
      }),
    ]);
    expect(await countPendingMutations(db, USER)).toBe(0); // dead, not counted
    expect(await countDeadLetterMutations(db, USER)).toBe(1);
  });
});

describe("transaction nesting contract (REL-002)", () => {
  it("commits the enqueue atomically inside a caller's transaction whose scope includes mutation_queue", async () => {
    await db.transaction("rw", [db.bookmarks, db.mutationQueue], async () => {
      await db.bookmarks.put({ entryId: 7, createdAt: 1 });
      await enqueueBookmarkMutation(db, {
        userId: USER,
        entryId: 7,
        createdAt: 1,
        deleted: false,
        now: 1,
      });
    });
    expect(await db.bookmarks.get(7)).toBeDefined();
    expect((await selectQueuedMutations(db, USER)).bookmarks).toHaveLength(1);
  });

  it("throws when the caller's transaction scope omits mutation_queue (loud, not silent)", async () => {
    await expect(
      db.transaction("rw", [db.bookmarks], async () => {
        await db.bookmarks.put({ entryId: 8, createdAt: 1 });
        await enqueueBookmarkMutation(db, {
          userId: USER,
          entryId: 8,
          createdAt: 1,
          deleted: false,
          now: 1,
        });
      }),
    ).rejects.toThrow();
    // The whole transaction rolled back — the bookmark write did not land either.
    expect(await db.bookmarks.get(8)).toBeUndefined();
  });
});
