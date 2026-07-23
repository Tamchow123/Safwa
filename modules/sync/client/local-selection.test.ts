import "fake-indexeddb/auto";

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type ReviewEventRecord, SafwaDb } from "@/modules/content/db";
import type { AttemptRecord } from "@/modules/study-engine/attempts";

import {
  countPendingScheduling,
  selectUnsyncedScheduling,
} from "./local-selection";

let db: SafwaDb;
let counter = 0;

beforeEach(async () => {
  db = new SafwaDb(`safwa-selection-test-${counter++}`);
  await db.open();
});

afterEach(() => db.close());

function makeAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: randomUUID(),
    sessionId: randomUUID(),
    userId: "user-1",
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
    isFirstAttempt: true,
    isReinforcement: false,
    hintUsed: false,
    hintType: null,
    responseTimeMs: 3000,
    questionPosition: 0,
    mode: "mc",
    optionCount: 4,
    perQuestionLimitMs: null,
    questionInstanceId: "qi-1",
    questionSeed: "seed-1",
    questionGeneratorVersion: "1",
    releaseId: "rel-1",
    contentVersion: "v1",
    occurredAtUtc: "2026-07-20T10:00:00.000Z",
    timezoneAtEvent: "UTC",
    utcOffsetMinutesAtEvent: 0,
    localDateAtEvent: "2026-07-20",
    timezoneSource: "browser_detected",
    ...overrides,
  };
}

function makeEvent(
  attempt: AttemptRecord,
  overrides: Partial<ReviewEventRecord> = {},
): ReviewEventRecord {
  return {
    eventId: randomUUID(),
    componentKey: attempt.studyComponentId,
    parentEventId: null,
    clientComponentRevision: 1,
    syncStatus: "local",
    createdAt: Date.now(),
    attemptId: attempt.id,
    rating: "good",
    status: "scheduling",
    baseServerRevision: 0,
    clientSequence: 1,
    occurredAtClient: "2026-07-20T10:00:00.000Z",
    deviceId: "device-1",
    sessionId: attempt.sessionId,
    releaseId: "rel-1",
    contentVersion: "v1",
    timezoneAtEvent: "UTC",
    utcOffsetMinutesAtEvent: 0,
    localDateAtEvent: "2026-07-20",
    timezoneSource: "browser_detected",
    ...overrides,
  };
}

async function insert(attempt: AttemptRecord, event: ReviewEventRecord) {
  await db.studyAttempts.add({
    id: attempt.id,
    componentKey: attempt.studyComponentId,
    sessionId: attempt.sessionId,
    attemptedAt: Date.now(),
    attempt,
  });
  await db.reviewEvents.add(event);
}

describe("selectUnsyncedScheduling", () => {
  it("selects local events with their validated attempts", async () => {
    const att = makeAttempt();
    const ev = makeEvent(att);
    await insert(att, ev);

    const selection = await selectUnsyncedScheduling(db, 100, "user-1");
    expect(selection.events).toHaveLength(1);
    expect(selection.events[0]?.eventId).toBe(ev.eventId);
    expect(selection.events[0]?.studyComponentId).toBe(att.studyComponentId);
    expect(selection.attempts).toHaveLength(1);
    expect(selection.attempts[0]?.id).toBe(att.id);
    // The local-only userId is not carried onto the wire attempt.
    expect(selection.attempts[0]).not.toHaveProperty("userId");
  });

  it("excludes events that are already pushed/accepted", async () => {
    const att = makeAttempt();
    const ev = makeEvent(att, { syncStatus: "accepted" });
    await insert(att, ev);
    const selection = await selectUnsyncedScheduling(db, 100, "user-1");
    expect(selection.events).toHaveLength(0);
  });

  it("skips a local event whose attempt is missing (not sendable)", async () => {
    const att = makeAttempt();
    const ev = makeEvent(att);
    // Insert the event but NOT its attempt.
    await db.reviewEvents.add(ev);
    const selection = await selectUnsyncedScheduling(db, 100, "user-1");
    expect(selection.events).toHaveLength(0);
    expect(selection.attempts).toHaveLength(0);
  });

  it("drops a record that fails wire validation instead of throwing", async () => {
    const att = makeAttempt();
    // An invalid rating makes the event fail wireEventSchema.
    const ev = makeEvent(att, { rating: "bogus" as never });
    await insert(att, ev);
    const selection = await selectUnsyncedScheduling(db, 100, "user-1");
    expect(selection.events).toHaveLength(0);
  });

  it("respects the limit", async () => {
    for (let i = 0; i < 5; i++) {
      const att = makeAttempt();
      await insert(att, makeEvent(att));
    }
    const selection = await selectUnsyncedScheduling(db, 3, "user-1");
    expect(selection.events).toHaveLength(3);
  });

  it("de-duplicates a shared attempt across two events", async () => {
    const att = makeAttempt();
    const e1 = makeEvent(att, { clientComponentRevision: 1 });
    const e2 = makeEvent(att, { clientComponentRevision: 2 });
    await insert(att, e1);
    await db.reviewEvents.add(e2);
    const selection = await selectUnsyncedScheduling(db, 100, "user-1");
    expect(selection.events).toHaveLength(2);
    expect(selection.attempts).toHaveLength(1); // shared attempt sent once
  });

  it("does NOT select a guest's events for a signed-in account (no implicit merge, §18/EXT-F1)", async () => {
    // A guest attempt has userId null; the account's own has userId user-1.
    const guest = makeAttempt({ userId: null });
    await insert(guest, makeEvent(guest));
    const mine = makeAttempt({ userId: "user-1" });
    await insert(mine, makeEvent(mine));

    const selection = await selectUnsyncedScheduling(db, 100, "user-1");
    expect(selection.events).toHaveLength(1); // ONLY the account's own event
    expect(selection.attempts).toHaveLength(1);
    expect(selection.attempts[0]?.id).toBe(mine.id);
  });

  it("does NOT select another account's leftover events", async () => {
    const other = makeAttempt({ userId: "user-2" });
    await insert(other, makeEvent(other));
    const selection = await selectUnsyncedScheduling(db, 100, "user-1");
    expect(selection.events).toHaveLength(0);
  });
});

describe("countPendingScheduling", () => {
  it("counts only the local (unsynced) review events", async () => {
    const local = makeAttempt();
    await insert(local, makeEvent(local));
    const accepted = makeAttempt();
    await insert(accepted, makeEvent(accepted, { syncStatus: "accepted" }));

    expect(await countPendingScheduling(db, "user-1")).toBe(1);
  });

  it("is zero when there is no unsynced work", async () => {
    expect(await countPendingScheduling(db, "user-1")).toBe(0);
  });

  it("does not count an orphan event (missing attempt → ownership unattributable)", async () => {
    const att = makeAttempt();
    // Event but no attempt: neither sendable nor attributable to an account, so
    // it is not counted as this account's pending work (EXT-F1 ownership).
    await db.reviewEvents.add(makeEvent(att));
    expect(await countPendingScheduling(db, "user-1")).toBe(0);
    expect(
      (await selectUnsyncedScheduling(db, 100, "user-1")).events,
    ).toHaveLength(0);
  });

  it("counts only the active account's events (guest + other-account excluded, EXT-F1)", async () => {
    const mine = makeAttempt({ userId: "user-1" });
    await insert(mine, makeEvent(mine));
    const guest = makeAttempt({ userId: null });
    await insert(guest, makeEvent(guest));
    const other = makeAttempt({ userId: "user-2" });
    await insert(other, makeEvent(other));
    expect(await countPendingScheduling(db, "user-1")).toBe(1);
  });

  it("is unbounded — counts beyond a single push page", async () => {
    for (let i = 0; i < 7; i++) {
      const att = makeAttempt();
      await insert(att, makeEvent(att));
    }
    // selectUnsyncedScheduling caps at the limit; the count reflects the backlog.
    expect(
      (await selectUnsyncedScheduling(db, 3, "user-1")).events,
    ).toHaveLength(3);
    expect(await countPendingScheduling(db, "user-1")).toBe(7);
  });
});
