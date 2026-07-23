import "fake-indexeddb/auto";

import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";

import Dexie from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildArtifacts, SOURCE_DATASET_PATH } from "@/modules/content/build";
import {
  cacheLearnerRelease,
  readVerifiedActiveCachedRelease,
  SAFWA_DB_VERSION,
  SafwaDb,
} from "@/modules/content/db";
import {
  createListWithEntry,
  toggleBookmark,
} from "@/modules/collections/persistence";

const ensureDurableGuestStateSpy = vi.fn(async () => ({ deviceId: "dev-1" }));

vi.mock("@/modules/profile/persistence", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/modules/profile/persistence")>();
  return {
    ...original,
    ensureDurableGuestState: (
      ...args: Parameters<typeof ensureDurableGuestStateSpy>
    ) => ensureDurableGuestStateSpy(...args),
  };
});

// Web Crypto for sha256HexBrowser under jsdom.
if (typeof globalThis.crypto?.subtle === "undefined") {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });
}

// Full-artifact verification over 455 entries through fake-indexeddb is
// slow under V8 coverage instrumentation; allow generous per-test time.
vi.setConfig({ testTimeout: 30_000 });

const built = buildArtifacts(readFileSync(SOURCE_DATASET_PATH, "utf8"));

/**
 * The EXACT shipped v1 schema (modules/content/db.ts at Phase 3), declared
 * independently here so this test keeps guarding the real upgrade path even
 * as the SafwaDb class evolves.
 */
class ContentDbV1 extends Dexie {
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      contentReleases: "releaseId",
      contentEntries:
        "[releaseId+entryId], releaseId, entryId, bab, verbType, bookPage",
      contentMetadata: "key",
    });
  }
}

/**
 * The EXACT shipped v2 schema (modules/content/db.ts at Phase 5–11), declared
 * independently here so the v2 → v3 upgrade path keeps being guarded even as
 * the SafwaDb class evolves.
 */
class LearnerDbV2 extends Dexie {
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      contentReleases: "releaseId",
      contentEntries:
        "[releaseId+entryId], releaseId, entryId, bab, verbType, bookPage",
      contentMetadata: "key",
    });
    this.version(2).stores({
      study_components: "componentKey, entryId",
      study_attempts: "id, componentKey, sessionId, attemptedAt",
      review_events: "eventId, componentKey, parentEventId, syncStatus",
      sessions: "id, startedAt",
      bookmarks: "entryId, createdAt",
      lists: "id, name",
      settings: "key",
      mutation_queue: "++seq, &idempotencyKey",
      profile: "key",
    });
  }
}

// Physical store names are a durable contract: the learner-state stores use
// the documented snake_case names (DATA_MODEL.md §9); the v1 content stores
// keep their shipped camelCase names; v3 adds daily_activity and v4 (Phase 16)
// adds the sync_state cursor store. This is the full store set at the current
// SAFWA_DB_VERSION, which the additive upgrades all converge to.
const V3_STORE_NAMES = [
  "bookmarks",
  "contentEntries",
  "contentMetadata",
  "contentReleases",
  "daily_activity",
  "lists",
  "mutation_queue",
  "profile",
  "review_events",
  "sessions",
  "settings",
  "study_attempts",
  "study_components",
  "sync_state",
];

let dbName = "";
let openDbs: Dexie[] = [];

function track<T extends Dexie>(db: T): T {
  openDbs.push(db);
  return db;
}

afterEach(async () => {
  for (const db of openDbs) {
    db.close();
  }
  openDbs = [];
  if (dbName) await Dexie.delete(dbName);
});

describe("Dexie migration v1 -> v3", () => {
  it("upgrades a populated v1 database and preserves the verified content cache", async () => {
    dbName = "safwa-migration-test-populated";

    // 1. A real Phase 3/4 client: v1 schema with a cached release.
    const v1 = track(new ContentDbV1(dbName));
    // cacheLearnerRelease only touches the three v1 content stores, so the
    // structural cast exercises the genuine write path on the v1 schema.
    await cacheLearnerRelease(
      v1 as unknown as SafwaDb,
      built.serialized.learner,
      built.checksums.learner,
      111,
    );
    expect(await v1.table("contentReleases").count()).toBe(1);
    v1.close();

    // 2. The current client opens the same database.
    const v3 = track(new SafwaDb(dbName));
    await v3.open();
    expect(v3.verno).toBe(SAFWA_DB_VERSION);
    expect(v3.tables.map((table) => table.name).sort()).toEqual(V3_STORE_NAMES);

    // 3. The cached content survived the upgrade byte-for-byte and still
    //    passes full cryptographic verification.
    const record = await v3.contentReleases.get(built.releaseId);
    expect(record!.serializedLearner).toBe(built.serialized.learner);
    expect(record!.cachedAt).toBe(111);
    const active = await readVerifiedActiveCachedRelease(v3);
    expect(active).not.toBeNull();
    expect(active!.entries).toHaveLength(455);

    // 4. New learner-state + derived-cache stores are empty and usable.
    expect(await v3.profile.count()).toBe(0);
    expect(await v3.settings.count()).toBe(0);
    expect(await v3.dailyActivity.count()).toBe(0);
    await v3.bookmarks.add({ entryId: 1, createdAt: 222 });
    expect(await v3.bookmarks.get(1)).toEqual({ entryId: 1, createdAt: 222 });
  });

  it("upgrades an empty v1 database", async () => {
    dbName = "safwa-migration-test-empty";
    const v1 = track(new ContentDbV1(dbName));
    await v1.open();
    v1.close();

    const v3 = track(new SafwaDb(dbName));
    await v3.open();
    expect(v3.verno).toBe(SAFWA_DB_VERSION);
    expect(v3.tables.map((table) => table.name).sort()).toEqual(V3_STORE_NAMES);
    expect(await readVerifiedActiveCachedRelease(v3)).toBeNull();
  });

  it("upgrades a populated v2 database preserving every learner store", async () => {
    dbName = "safwa-migration-test-v2-populated";

    // 1. A real Phase 5–11 client: v2 schema with learner state, settings
    //    (timezone + session defaults), attempts, events and a profile.
    const v2 = track(new LearnerDbV2(dbName));
    await v2.table("study_components").put({
      componentKey: "entry:1:skill:bab_identification",
      entryId: 1,
      learnerState: "learning",
    });
    await v2.table("study_attempts").put({
      id: "attempt-1",
      componentKey: "entry:1:skill:bab_identification",
      sessionId: "session-1",
      attemptedAt: 100,
    });
    await v2.table("review_events").put({
      eventId: "event-1",
      componentKey: "entry:1:skill:bab_identification",
      parentEventId: null,
      clientComponentRevision: 1,
      syncStatus: "local",
      createdAt: 100,
      status: "scheduling",
      localDateAtEvent: "2026-07-17",
    });
    await v2.table("settings").put({
      key: "timezone",
      value: { mode: "iana", timezone: "Asia/Tokyo" },
      updatedAt: 100,
    });
    await v2.table("settings").put({
      key: "session-defaults",
      value: {
        questionCount: 15,
        optionCount: 5,
        newPerDay: 7,
        reviewsPerDay: 12,
      },
      updatedAt: 100,
    });
    await v2.table("profile").put({
      key: "device",
      deviceId: "device-1",
      createdAt: 100,
      persistenceRequestedAt: null,
      persistenceGranted: null,
    });
    await v2.table("sessions").put({ id: "session-1", startedAt: 90 });
    await v2.table("bookmarks").put({ entryId: 7, createdAt: 95 });
    await v2.table("lists").put({
      id: "list-1",
      name: "My list",
      entryIds: [7, 9],
      createdAt: 96,
      updatedAt: 97,
    });
    await v2.table("mutation_queue").put({
      seq: 1,
      idempotencyKey: "mutation-1",
      type: "test",
      payload: null,
      createdAt: 98,
    });
    v2.close();

    // 2. The v3 client opens the same database: everything carries forward,
    //    the new derived-cache store starts empty and usable.
    const v3 = track(new SafwaDb(dbName));
    await v3.open();
    expect(v3.verno).toBe(SAFWA_DB_VERSION);
    expect(v3.tables.map((table) => table.name).sort()).toEqual(V3_STORE_NAMES);
    expect(
      await v3.studyComponents.get("entry:1:skill:bab_identification"),
    ).toMatchObject({ entryId: 1, learnerState: "learning" });
    expect(await v3.studyAttempts.get("attempt-1")).toMatchObject({
      sessionId: "session-1",
      attemptedAt: 100,
    });
    expect(await v3.reviewEvents.get("event-1")).toMatchObject({
      status: "scheduling",
      localDateAtEvent: "2026-07-17",
    });
    expect(await v3.settings.get("timezone")).toMatchObject({
      value: { mode: "iana", timezone: "Asia/Tokyo" },
    });
    expect(await v3.settings.get("session-defaults")).toMatchObject({
      value: {
        questionCount: 15,
        optionCount: 5,
        newPerDay: 7,
        reviewsPerDay: 12,
      },
    });
    expect(await v3.profile.get("device")).toMatchObject({
      deviceId: "device-1",
    });
    expect(await v3.sessions.get("session-1")).toEqual({
      id: "session-1",
      startedAt: 90,
    });
    expect(await v3.bookmarks.get(7)).toEqual({ entryId: 7, createdAt: 95 });
    expect(await v3.lists.get("list-1")).toEqual({
      id: "list-1",
      name: "My list",
      entryIds: [7, 9],
      createdAt: 96,
      updatedAt: 97,
    });
    expect(await v3.mutationQueue.get(1)).toEqual({
      seq: 1,
      idempotencyKey: "mutation-1",
      type: "test",
      payload: null,
      createdAt: 98,
    });
    expect(await v3.dailyActivity.count()).toBe(0);
    await v3.dailyActivity.put({
      localDate: "2026-07-17",
      attempts: 1,
      reviews: 0,
      newItems: 1,
      studyMs: 1000,
      derivedAt: 200,
    });
    expect(await v3.dailyActivity.get("2026-07-17")).toMatchObject({
      attempts: 1,
    });
  });

  it("assigns monotonically increasing sequence numbers in the mutation queue", async () => {
    dbName = "safwa-migration-test-queue";
    const v2 = track(new SafwaDb(dbName));
    const first = await v2.mutationQueue.add({
      idempotencyKey: "one",
      type: "test",
      payload: null,
      createdAt: 1,
    });
    const second = await v2.mutationQueue.add({
      idempotencyKey: "two",
      type: "test",
      payload: null,
      createdAt: 2,
    });
    expect(first).toBeTypeOf("number");
    expect(second).toBeGreaterThan(first!);
    const ordered = await v2.mutationQueue.orderBy("seq").toArray();
    expect(ordered.map((row) => row.idempotencyKey)).toEqual(["one", "two"]);

    // idempotencyKey is a UNIQUE index: a duplicate enqueue is rejected at
    // the storage layer, not left for sync-phase code to deduplicate.
    await expect(
      v2.mutationQueue.add({
        idempotencyKey: "one",
        type: "test",
        payload: null,
        createdAt: 3,
      }),
    ).rejects.toThrow();
    expect(await v2.mutationQueue.count()).toBe(2);
  });
});

// Phase 14 §29: bookmarks/lists already existed in the shipped v2->v3
// schema (guarded above), so this phase introduces NO new migration. These
// tests add the remaining coverage the phase doc calls for without touching
// V3_STORE_NAMES or any existing exact-equality assertion above.
describe("Dexie schema v3 — collections stores (Phase 14 §29, no new migration)", () => {
  it("a fresh v3 database (no prior version) includes usable bookmarks/lists stores", async () => {
    dbName = "safwa-migration-test-fresh-v3";
    const v3 = track(new SafwaDb(dbName));
    await v3.open();
    expect(v3.verno).toBe(SAFWA_DB_VERSION);
    expect(v3.tables.map((table) => table.name).sort()).toEqual(V3_STORE_NAMES);
    expect(await v3.bookmarks.count()).toBe(0);
    expect(await v3.lists.count()).toBe(0);
  });

  it("bookmark/list records written through the collections persistence module survive a db reopen", async () => {
    dbName = "safwa-migration-test-persistence-reopen";
    const KNOWN = new Set([7, 9]);

    const first = track(new SafwaDb(dbName));
    await first.open();
    await toggleBookmark(first, 7, KNOWN, 100);
    const list = await createListWithEntry(first, {
      name: "My list",
      entryId: 9,
      knownEntryIds: KNOWN,
      now: 101,
    });
    first.close();

    // A genuinely fresh client instance re-opens the same on-disk database —
    // not just a re-read of the same still-open Dexie object.
    const reopened = track(new SafwaDb(dbName));
    await reopened.open();
    expect(reopened.verno).toBe(SAFWA_DB_VERSION);
    expect(await reopened.bookmarks.get(7)).toEqual({
      entryId: 7,
      createdAt: 100,
    });
    expect(await reopened.lists.get(list.id)).toEqual({
      id: list.id,
      name: "My list",
      entryIds: [9],
      createdAt: 101,
      updatedAt: 101,
    });

    // Content cache, study state and the derived daily_activity cache are
    // untouched by a collections-only write/reopen cycle.
    expect(await reopened.contentReleases.count()).toBe(0);
    expect(await reopened.contentMetadata.count()).toBe(0);
    expect(await reopened.studyComponents.count()).toBe(0);
    expect(await reopened.studyAttempts.count()).toBe(0);
    expect(await reopened.reviewEvents.count()).toBe(0);
    expect(await reopened.sessions.count()).toBe(0);
    expect(await reopened.dailyActivity.count()).toBe(0);
  });
});
