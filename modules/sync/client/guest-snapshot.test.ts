import "fake-indexeddb/auto";

import { randomUUID } from "node:crypto";

import type { Table } from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type ReviewEventRecord, SafwaDb } from "@/modules/content/db";
import { accountOwnerKey, toOwnerKey } from "@/modules/content/owner-key";
import { SETTING_KEYS } from "@/modules/profile/setting-keys";
import type { AttemptRecord } from "@/modules/study-engine/attempts";

import {
  collectGuestSnapshot,
  guestSnapshotHash,
  GUEST_SNAPSHOT_BOUNDS,
  guestSnapshotItemCount,
  GuestSnapshotTooLargeError,
  isMeaningfulGuestData,
  summarizeGuestData,
} from "./guest-snapshot";

let db: SafwaDb;
let counter = 0;

beforeEach(async () => {
  db = new SafwaDb(`safwa-guest-snapshot-test-${counter++}`);
  await db.open();
});

afterEach(() => db.close());

const ACCOUNT = "11111111-1111-4111-8111-111111111111";

function makeAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: randomUUID(),
    sessionId: randomUUID(),
    userId: null,
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
  } as AttemptRecord;
}

function makeEvent(
  attempt: AttemptRecord,
  overrides: Partial<ReviewEventRecord> = {},
): ReviewEventRecord {
  return {
    eventId: randomUUID(),
    componentKey: attempt.studyComponentId,
    ownerKey: toOwnerKey(attempt.userId),
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
  } as ReviewEventRecord;
}

async function insertPair(
  attempt: AttemptRecord,
  event: ReviewEventRecord | null = makeEvent(attempt),
): Promise<void> {
  await db.studyAttempts.add({
    id: attempt.id,
    ownerKey: toOwnerKey(attempt.userId),
    componentKey: attempt.studyComponentId,
    sessionId: attempt.sessionId,
    attemptedAt: Date.now(),
    attempt,
  });
  if (event) await db.reviewEvents.add(event);
}

describe("summarizeGuestData / isMeaningfulGuestData", () => {
  it("counts only GUEST-owned rows, never a signed-in account's", async () => {
    await insertPair(makeAttempt());
    await insertPair(makeAttempt({ userId: ACCOUNT }));
    await db.bookmarks.put({
      ownerKey: accountOwnerKey(ACCOUNT),
      entryId: 9,
      createdAt: 1,
    });

    expect(await summarizeGuestData(db)).toEqual({
      components: 0,
      events: 1,
      attempts: 1,
      bookmarks: 0,
      lists: 0,
    });
  });

  it("treats an empty guest as not worth prompting about", () => {
    expect(
      isMeaningfulGuestData({
        components: 0,
        events: 0,
        attempts: 0,
        bookmarks: 0,
        lists: 0,
      }),
    ).toBe(false);
  });

  it("does not prompt for a settings-only guest (the account's settings win anyway)", async () => {
    await db.settings.put({
      ownerKey: toOwnerKey(null),
      key: SETTING_KEYS.theme,
      value: "dark",
      updatedAt: 1,
    });
    const summary = await summarizeGuestData(db);
    expect(isMeaningfulGuestData(summary)).toBe(false);
  });

  it("prompts when the guest has only bookmarks (no study history)", async () => {
    await db.bookmarks.put({ ownerKey: toOwnerKey(null), entryId: 4, createdAt: 1 }); // prettier-ignore
    expect(isMeaningfulGuestData(await summarizeGuestData(db))).toBe(true);
  });
});

describe("collectGuestSnapshot", () => {
  it("selects the guest's history and leaves an account's rows entirely alone", async () => {
    const guest = makeAttempt();
    await insertPair(guest);
    const mine = makeAttempt({ userId: ACCOUNT });
    await insertPair(mine);
    await db.bookmarks.put({
      ownerKey: toOwnerKey(null),
      entryId: 3,
      createdAt: 10,
    });
    await db.bookmarks.put({
      ownerKey: accountOwnerKey(ACCOUNT),
      entryId: 99,
      createdAt: 10,
    });

    const snapshot = await collectGuestSnapshot(db);
    expect(snapshot.attempts.map((a) => a.id)).toEqual([guest.id]);
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.bookmarks).toEqual([
      { entryId: 3, createdAt: 10, deleted: false },
    ]);
  });

  it("never uploads derived projections, the mutation queue or the content cache", async () => {
    await db.studyComponents.put({
      ownerKey: toOwnerKey(null),
      componentKey: "entry:1:skill:meaning_recognition:field:madi:direction:arabic_to_english", // prettier-ignore
      entryId: 1,
      revision: 4,
    });
    await db.dailyActivity.put({
      ownerKey: toOwnerKey(null),
      localDate: "2026-07-20",
      attempts: 3,
      reviews: 2,
      newItems: 1,
      studyMs: 900,
      derivedAt: 1,
    });

    const snapshot = await collectGuestSnapshot(db);
    // The snapshot's shape IS the allow-list: there is nowhere for a derived
    // projection, a queued mutation or a cached release to travel.
    expect(Object.keys(snapshot).sort()).toEqual([
      "attempts",
      "bookmarks",
      "deviceId",
      "events",
      "lists",
      "settings",
      "skipped",
      "version",
    ]);
    expect(guestSnapshotItemCount(snapshot)).toBe(0);
  });

  it("carries a reinforcement attempt that has no scheduling event", async () => {
    const reinforcement = makeAttempt({ isReinforcement: true });
    await insertPair(reinforcement, null);

    const snapshot = await collectGuestSnapshot(db);
    expect(snapshot.attempts.map((a) => a.id)).toEqual([reinforcement.id]);
    expect(snapshot.events).toEqual([]);
    expect(snapshot.skipped.events).toBe(0);
  });

  it("skips — and COUNTS — an event whose attempt is missing, since the server regrades from it", async () => {
    const orphan = makeAttempt();
    await db.reviewEvents.add(makeEvent(orphan)); // attempt deliberately not stored

    const snapshot = await collectGuestSnapshot(db);
    expect(snapshot.events).toEqual([]);
    expect(snapshot.skipped.events).toBe(1);
  });

  it("skips a malformed record instead of letting it break the whole snapshot", async () => {
    const good = makeAttempt();
    await insertPair(good);
    const bad = makeAttempt({ responseTimeMs: -1 as unknown as number });
    await insertPair(bad);

    const snapshot = await collectGuestSnapshot(db);
    expect(snapshot.attempts.map((a) => a.id)).toEqual([good.id]);
    expect(snapshot.skipped.attempts).toBe(1);
    // Its event is unsendable too — the attempt it would be regraded from is gone.
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.skipped.events).toBe(1);
  });

  it("passes only allow-listed settings and expands the session-defaults blob", async () => {
    const owner = toOwnerKey(null);
    await db.settings.bulkPut([
      { ownerKey: owner, key: SETTING_KEYS.theme, value: "dark", updatedAt: 5 },
      {
        ownerKey: owner,
        key: SETTING_KEYS.registerPromptDismissed,
        value: true,
        updatedAt: 5,
      },
      {
        ownerKey: owner,
        key: SETTING_KEYS.sessionDefaults,
        value: {
          questionCount: 15,
          optionCount: 4,
          newPerDay: 8,
          reviewsPerDay: 60,
        },
        updatedAt: 6,
      },
    ]);

    const snapshot = await collectGuestSnapshot(db);
    expect(snapshot.settings.map((s) => s.key)).toEqual([
      "dailyNewTarget",
      "dailyReviewTarget",
      "optionCount",
      "questionCount",
      "theme",
    ]);
    // The dismissed-prompt key is device UI state and maps to nothing.
    expect(snapshot.skipped.settings).toBe(1);
  });

  it("refuses an oversized history loudly rather than merging a silent subset", async () => {
    // Truncating would present a PARTIAL merge as a complete one — the failure
    // this ceiling exists to prevent. The refusal is decided from the indexed
    // COUNT, before a single row is materialised (§29), so an oversized history
    // never reaches browser memory in the first place.
    const owner = toOwnerKey(null);
    const overLimit = GUEST_SNAPSHOT_BOUNDS.maxLists + 1;
    await db.lists.bulkPut(
      Array.from({ length: overLimit }, (_, index) => ({
        ownerKey: owner,
        id: `list-${String(index).padStart(4, "0")}`,
        name: `List ${index}`,
        entryIds: [1],
        createdAt: 1,
        updatedAt: 1,
      })),
    );

    await expect(collectGuestSnapshot(db)).rejects.toThrow(
      GuestSnapshotTooLargeError,
    );
    await expect(collectGuestSnapshot(db)).rejects.toMatchObject({
      kind: "lists",
      count: overLimit,
      limit: GUEST_SNAPSHOT_BOUNDS.maxLists,
    });
  });
});

describe("collection consistency (REL-002)", () => {
  it("reads every store it touches inside ONE read transaction", async () => {
    // Without this, the bounds check and the materialisation see different
    // databases: a guest studying in another tab can push a store past the limit
    // that was just checked from the counts, and an event can be read whose
    // attempt was not yet there when attempts were read.
    const opened = vi.spyOn(db, "transaction");
    await collectGuestSnapshot(db);

    const call = opened.mock.calls.find(([mode]) => mode === "r");
    expect(call).toBeDefined();
    const scope = (call?.[1] as unknown as Table[])
      .map((table) => table.name)
      .sort();
    // Every store the collection reads must be in scope, or that read escapes
    // the transaction and silently reintroduces the inconsistency.
    expect(scope).toEqual([
      "bookmarks_owned",
      "lists",
      "profile",
      "review_events",
      "settings_owned",
      "study_attempts",
      "study_components_owned",
    ]);
    opened.mockRestore();
  });

  it("never emits an event orphaned by a write racing the collection", async () => {
    // Attempts are read before events, so outside a transaction a write landing
    // between the two yields an event whose attempt is absent. That does not
    // fail loudly — it is silently counted as ungradeable and dropped, quietly
    // losing history from the merge. Inside one transaction the racing write
    // falls entirely on one side of the read.
    const collecting = collectGuestSnapshot(db);
    const writing = insertPair(makeAttempt());
    const [snapshot] = await Promise.all([collecting, writing]);

    expect(snapshot.skipped.events).toBe(0);
    const attemptIds = new Set(snapshot.attempts.map((a) => a.id));
    for (const event of snapshot.events) {
      expect(attemptIds.has(event.attemptId)).toBe(true);
    }
  });
});

describe("guestSnapshotHash", () => {
  it("is stable across repeated collections of unchanged data", async () => {
    await insertPair(makeAttempt());
    await db.bookmarks.put({
      ownerKey: toOwnerKey(null),
      entryId: 2,
      createdAt: 1,
    });

    const first = await guestSnapshotHash(await collectGuestSnapshot(db));
    const second = await guestSnapshotHash(await collectGuestSnapshot(db));
    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the guest studies more", async () => {
    await insertPair(makeAttempt());
    const before = await guestSnapshotHash(await collectGuestSnapshot(db));
    await insertPair(makeAttempt());
    const after = await guestSnapshotHash(await collectGuestSnapshot(db));
    expect(after).not.toBe(before);
  });

  it("ignores the skipped counts — they describe what is NOT being sent", async () => {
    const good = makeAttempt();
    await insertPair(good);
    const baseline = await collectGuestSnapshot(db);
    const withSkips = { ...baseline, skipped: { ...baseline.skipped, events: 3 } }; // prettier-ignore
    expect(await guestSnapshotHash(withSkips)).toBe(
      await guestSnapshotHash(baseline),
    );
  });

  it("does not depend on the order rows happen to come back from IndexedDB", async () => {
    const a = makeAttempt();
    const b = makeAttempt();
    await insertPair(a);
    await insertPair(b);
    const snapshot = await collectGuestSnapshot(db);
    const reversed = {
      ...snapshot,
      attempts: [...snapshot.attempts].reverse(),
      events: [...snapshot.events].reverse(),
    };
    // A snapshot whose arrays are shuffled is NOT the canonical one, so the
    // hash must differ — which is exactly why collection sorts deterministically
    // instead of trusting storage order.
    expect(await guestSnapshotHash(reversed)).not.toBe(
      await guestSnapshotHash(snapshot),
    );
    expect(snapshot.attempts.map((x) => x.id)).toEqual(
      [a.id, b.id].sort((x, y) => (x < y ? -1 : 1)),
    );
  });
});
