import "fake-indexeddb/auto";

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createList,
  deleteList,
  setBookmarked,
  toggleBookmark,
} from "@/modules/collections/persistence";
import { SafwaDb } from "@/modules/content/db";
import { writeGuestSetting } from "@/modules/profile/settings";
import type { AttemptRecord } from "@/modules/study-engine/attempts";
import {
  recordGradedAttempt,
  undoGradedAttempt,
  UndoNotYetSyncedError,
} from "@/modules/study-session/persistence";

import { countPendingMutations, selectQueuedMutations } from "./mutation-queue";

/**
 * End-to-end wiring: a signed-in account's local mutations land in the sync
 * outbox (§9.1, EXT-F2); a guest's never do (they sync on the Phase-17 merge).
 */
let db: SafwaDb;
let counter = 0;
const USER = "user-1";

beforeEach(async () => {
  db = new SafwaDb(`safwa-mutator-enqueue-${counter++}`);
  await db.open();
});
afterEach(() => db.close());

async function signIn(userId = USER): Promise<void> {
  await db.syncState.put({
    key: "account",
    userId,
    serverCursor: 0,
    lastSyncAt: null,
  });
}

function reinforcementAttempt(userId: string | null): AttemptRecord {
  return {
    id: randomUUID(),
    sessionId: randomUUID(),
    userId,
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
    questionPosition: 1,
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

describe("bookmark enqueue", () => {
  it("enqueues an upsert then coalesces to the latest state (delete) when signed in", async () => {
    await signIn();
    await setBookmarked(db, 1, true, new Set([1]), 100);
    expect((await selectQueuedMutations(db, USER)).bookmarks).toEqual([
      { entryId: 1, createdAt: 100, deleted: false },
    ]);
    await setBookmarked(db, 1, false, new Set([1]), 200);
    const sel = await selectQueuedMutations(db, USER);
    expect(sel.bookmarks).toEqual([
      { entryId: 1, createdAt: 100, deleted: true },
    ]);
    expect(await db.mutationQueue.count()).toBe(1); // coalesced, not appended
  });

  it("enqueues a toggle in both directions", async () => {
    await signIn();
    expect(await toggleBookmark(db, 2, new Set([2]), 10)).toBe(true);
    expect((await selectQueuedMutations(db, USER)).bookmarks[0]?.deleted).toBe(
      false,
    );
    expect(await toggleBookmark(db, 2, new Set([2]), 20)).toBe(false);
    expect((await selectQueuedMutations(db, USER)).bookmarks[0]?.deleted).toBe(
      true,
    );
  });

  it("does NOT enqueue for a guest (signed out)", async () => {
    await setBookmarked(db, 1, true, new Set([1]), 100);
    expect(await db.mutationQueue.count()).toBe(0);
  });

  it("does NOT enqueue an idempotent no-op (already in the target state)", async () => {
    await signIn();
    await setBookmarked(db, 1, true, new Set([1]), 100);
    await setBookmarked(db, 1, true, new Set([1]), 150); // no-op re-set
    expect(await db.mutationQueue.count()).toBe(1);
  });
});

describe("list enqueue", () => {
  it("enqueues a snapshot on create and a delete carrying the snapshot on remove", async () => {
    await signIn();
    const list = await createList(db, { name: "Fav", now: 10 });
    let sel = await selectQueuedMutations(db, USER);
    expect(sel.lists).toHaveLength(1);
    expect(sel.lists[0]).toMatchObject({
      id: list.id,
      name: "Fav",
      deleted: false,
    });
    await deleteList(db, list.id, 20);
    sel = await selectQueuedMutations(db, USER);
    expect(sel.lists).toHaveLength(1);
    expect(sel.lists[0]).toMatchObject({ id: list.id, deleted: true });
  });

  it("does NOT enqueue for a guest", async () => {
    await createList(db, { name: "Fav", now: 10 });
    expect(await db.mutationQueue.count()).toBe(0);
  });
});

describe("setting enqueue", () => {
  it("enqueues a mapped syncable setting when signed in", async () => {
    await signIn();
    await writeGuestSetting(db, "theme", "dark", undefined, { now: () => 5 });
    expect((await selectQueuedMutations(db, USER)).settings).toEqual([
      { key: "theme", value: "dark", updatedAt: 5 },
    ]);
  });

  it("does not enqueue a non-syncable setting key", async () => {
    await signIn();
    await writeGuestSetting(db, "register-prompt-dismissed", true, undefined, {
      now: () => 5,
    });
    expect((await selectQueuedMutations(db, USER)).settings).toHaveLength(0);
  });

  it("does not enqueue for a guest", async () => {
    await writeGuestSetting(db, "theme", "dark", undefined, { now: () => 5 });
    expect(await db.mutationQueue.count()).toBe(0);
  });
});

function schedulingAttempt(userId: string | null): AttemptRecord {
  return {
    ...reinforcementAttempt(userId),
    isFirstAttempt: true,
    isReinforcement: false,
  };
}

describe("durable post-sync undo (EXT-F3)", () => {
  it("physically deletes an UNSYNCED (local) scheduling event, no revocation", async () => {
    const persisted = await recordGradedAttempt(db, schedulingAttempt(USER), {
      now: 1,
      eventId: randomUUID(),
    });
    expect(persisted.eventId).not.toBeNull();
    await undoGradedAttempt(db, persisted, 2);
    expect(await db.reviewEvents.get(persisted.eventId!)).toBeUndefined();
    expect(await db.studyAttempts.get(persisted.attemptId)).toBeUndefined();
    // A never-sent event needs no revocation.
    expect(await db.mutationQueue.count()).toBe(0);
  });

  it("queues a revocation and KEEPS history for a SERVER-KNOWN (accepted) event", async () => {
    const persisted = await recordGradedAttempt(db, schedulingAttempt(USER), {
      now: 1,
      eventId: randomUUID(),
    });
    // Simulate the server having accepted the event.
    await db.reviewEvents.update(persisted.eventId!, {
      syncStatus: "accepted",
    });
    await undoGradedAttempt(db, persisted, 2);
    // The event is KEPT but revoked; the attempt is KEPT (history, §16).
    expect((await db.reviewEvents.get(persisted.eventId!))?.status).toBe(
      "revoked",
    );
    expect(await db.studyAttempts.get(persisted.attemptId)).toBeDefined();
    // The component's FSRS reverts optimistically (its only event is revoked, so
    // it becomes never-reviewed) — the undo shows immediately, before sync.
    expect(
      await db.studyComponents.get(persisted.componentKey),
    ).toBeUndefined();
    // A revocation targeting the event is durably queued for the account.
    const sel = await selectQueuedMutations(db, USER);
    expect(sel.revocations).toHaveLength(1);
    expect(sel.revocations[0]?.eventId).toBe(persisted.eventId);
    expect(sel.revocations[0]?.studyComponentId).toBe(persisted.componentKey);
  });

  it("DEFERS undo of a still-syncing (pushed) event rather than losing it (REL-001)", async () => {
    const persisted = await recordGradedAttempt(db, schedulingAttempt(USER), {
      now: 1,
      eventId: randomUUID(),
    });
    // The server is holding this event as pending (not yet authoritative).
    await db.reviewEvents.update(persisted.eventId!, { syncStatus: "pushed" });
    await expect(undoGradedAttempt(db, persisted, 2)).rejects.toBeInstanceOf(
      UndoNotYetSyncedError,
    );
    // Nothing was revoked, deleted, or queued — the undo is retryable later.
    expect((await db.reviewEvents.get(persisted.eventId!))?.status).toBe(
      "scheduling",
    );
    expect(await db.mutationQueue.count()).toBe(0);
  });

  it("is idempotent on an already-undone event — never a second revocation (REL-002)", async () => {
    const persisted = await recordGradedAttempt(db, schedulingAttempt(USER), {
      now: 1,
      eventId: randomUUID(),
    });
    await db.reviewEvents.update(persisted.eventId!, {
      syncStatus: "accepted",
    });
    await undoGradedAttempt(db, persisted, 2);
    await undoGradedAttempt(db, persisted, 3); // second undo — no-op
    expect((await selectQueuedMutations(db, USER)).revocations).toHaveLength(1);
  });

  it("REFUSES to revoke a server-known event with no resolvable owner (ARCH-001)", async () => {
    // A guest (null-owner) event can never legitimately be server-known; if it
    // somehow is, the undo must refuse rather than silently diverge.
    const persisted = await recordGradedAttempt(db, schedulingAttempt(null), {
      now: 1,
      eventId: randomUUID(),
    });
    await db.reviewEvents.update(persisted.eventId!, {
      syncStatus: "accepted",
    });
    await expect(undoGradedAttempt(db, persisted, 2)).rejects.toThrow(
      /no resolvable owner/,
    );
    // The refusal rolled back — nothing was marked revoked or queued.
    expect((await db.reviewEvents.get(persisted.eventId!))?.status).toBe(
      "scheduling",
    );
    expect(await db.mutationQueue.count()).toBe(0);
  });
});

describe("reinforcement enqueue", () => {
  it("enqueues a signed-in account's reinforcement attempt (no scheduling event)", async () => {
    const attempt = reinforcementAttempt(USER);
    const persisted = await recordGradedAttempt(db, attempt, {
      now: 1,
      eventId: randomUUID(),
    });
    expect(persisted.eventId).toBeNull();
    const sel = await selectQueuedMutations(db, USER);
    expect(sel.reinforcementAttempts).toHaveLength(1);
    expect(sel.reinforcementAttempts[0]?.id).toBe(attempt.id);
    expect(await countPendingMutations(db, USER)).toBe(1);
  });

  it("does NOT enqueue a guest's reinforcement attempt", async () => {
    await recordGradedAttempt(db, reinforcementAttempt(null), {
      now: 1,
      eventId: randomUUID(),
    });
    expect(await db.mutationQueue.count()).toBe(0);
  });

  it("dequeues an undone reinforcement attempt's queued mutation (REL-001)", async () => {
    const attempt = reinforcementAttempt(USER);
    const persisted = await recordGradedAttempt(db, attempt, {
      now: 1,
      eventId: randomUUID(),
    });
    expect(await db.mutationQueue.count()).toBe(1); // queued
    await undoGradedAttempt(db, persisted, 2);
    // The undo retracted the queued mutation — the server is never told about
    // an attempt the user reversed.
    expect(await db.mutationQueue.count()).toBe(0);
    expect(await countPendingMutations(db, USER)).toBe(0);
  });
});
