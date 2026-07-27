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
import { buildExportPayload } from "@/modules/profile/export";
import { accountOwnerKey, GUEST_OWNER_KEY } from "@/modules/content/owner-key";
import { readOwnedRows } from "@/modules/content/owner-scope";

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

/**
 * The EXACT shipped v5 schema (modules/content/db.ts immediately before the
 * Phase-16 R2-F3 owner columns), declared independently here so the v5 -> v6
 * upgrade path keeps being guarded even as the SafwaDb class evolves. This is
 * the schema every already-deployed client is on, so it is the population the
 * v6 upgrade actually runs against.
 */
class LearnerDbV5 extends Dexie {
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
    this.version(3).stores({ daily_activity: "localDate" });
    this.version(4).stores({ sync_state: "key" });
    this.version(5).stores({
      mutation_queue:
        "++seq, &idempotencyKey, type, userId, status, [userId+status], [type+userId+target]",
    });
  }
}

/**
 * The EXACT shipped v6 schema (modules/content/db.ts at the end of Phase 16):
 * owner COLUMNS (`userId`, null = guest) and owner-scoped indexes, but the
 * pre-v6 primary keys. This is the population the Phase-17 v7 data-moving
 * upgrade actually runs against, so it is declared independently here rather
 * than inferred from the current SafwaDb class.
 */
class LearnerDbV6 extends Dexie {
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
    this.version(3).stores({ daily_activity: "localDate" });
    this.version(4).stores({ sync_state: "key" });
    this.version(5).stores({
      mutation_queue:
        "++seq, &idempotencyKey, type, userId, status, [userId+status], [type+userId+target]",
    });
    this.version(6).stores({
      study_components: "componentKey, entryId, userId, [userId+componentKey]",
      review_events:
        "eventId, componentKey, parentEventId, syncStatus, userId, [userId+syncStatus], [userId+componentKey]",
      bookmarks: "entryId, createdAt, userId, [userId+entryId]",
      lists: "id, name, userId",
      settings: "key, userId, [userId+key]",
    });
  }
}

// Physical store names are a durable contract: the learner-state stores use
// the documented snake_case names (DATA_MODEL.md §9); the v1 content stores
// keep their shipped camelCase names; v3 adds daily_activity and v4 (Phase 16)
// adds the sync_state cursor store. This is the full store set at the current
// SAFWA_DB_VERSION, which the additive upgrades all converge to.
const CURRENT_STORE_NAMES = [
  "bookmarks_owned",
  "contentEntries",
  "contentMetadata",
  "contentReleases",
  "daily_activity_owned",
  "lists",
  "mutation_queue",
  "profile",
  "review_events",
  "sessions",
  "settings_owned",
  "study_attempts",
  "study_components_owned",
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
    expect(v3.tables.map((table) => table.name).sort()).toEqual(
      CURRENT_STORE_NAMES,
    );

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
    await v3.bookmarks.add({
      ownerKey: GUEST_OWNER_KEY,
      entryId: 1,
      createdAt: 222,
    });
    expect(await v3.bookmarks.get([GUEST_OWNER_KEY, 1])).toEqual({
      ownerKey: GUEST_OWNER_KEY,
      entryId: 1,
      createdAt: 222,
    });
  });

  it("upgrades an empty v1 database", async () => {
    dbName = "safwa-migration-test-empty";
    const v1 = track(new ContentDbV1(dbName));
    await v1.open();
    v1.close();

    const v3 = track(new SafwaDb(dbName));
    await v3.open();
    expect(v3.verno).toBe(SAFWA_DB_VERSION);
    expect(v3.tables.map((table) => table.name).sort()).toEqual(
      CURRENT_STORE_NAMES,
    );
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
    expect(v3.tables.map((table) => table.name).sort()).toEqual(
      CURRENT_STORE_NAMES,
    );
    expect(
      await v3.studyComponents.get([
        GUEST_OWNER_KEY,
        "entry:1:skill:bab_identification",
      ]),
    ).toMatchObject({ entryId: 1, learnerState: "learning" });
    expect(await v3.studyAttempts.get("attempt-1")).toMatchObject({
      sessionId: "session-1",
      attemptedAt: 100,
    });
    expect(await v3.reviewEvents.get("event-1")).toMatchObject({
      status: "scheduling",
      localDateAtEvent: "2026-07-17",
    });
    expect(await v3.settings.get([GUEST_OWNER_KEY, "timezone"])).toMatchObject({
      value: { mode: "iana", timezone: "Asia/Tokyo" },
    });
    expect(
      await v3.settings.get([GUEST_OWNER_KEY, "session-defaults"]),
    ).toMatchObject({
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
    // Every migrated row is owner-stamped as the GUEST (section 10: a pre-v6
    // row with no owner is a guest row), with its natural key intact.
    expect(await v3.sessions.get("session-1")).toEqual({
      id: "session-1",
      ownerKey: GUEST_OWNER_KEY,
      startedAt: 90,
    });
    expect(await v3.bookmarks.get([GUEST_OWNER_KEY, 7])).toEqual({
      ownerKey: GUEST_OWNER_KEY,
      entryId: 7,
      createdAt: 95,
    });
    expect(await v3.lists.get("list-1")).toEqual({
      ownerKey: GUEST_OWNER_KEY,
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
      ownerKey: GUEST_OWNER_KEY,
      localDate: "2026-07-17",
      attempts: 1,
      reviews: 0,
      newItems: 1,
      studyMs: 1000,
      derivedAt: 200,
    });
    expect(
      await v3.dailyActivity.get([GUEST_OWNER_KEY, "2026-07-17"]),
    ).toMatchObject({ attempts: 1 });
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
// CURRENT_STORE_NAMES or any existing exact-equality assertion above.
describe("Dexie schema v3 — collections stores (Phase 14 §29, no new migration)", () => {
  it("a fresh v3 database (no prior version) includes usable bookmarks/lists stores", async () => {
    dbName = "safwa-migration-test-fresh-v3";
    const v3 = track(new SafwaDb(dbName));
    await v3.open();
    expect(v3.verno).toBe(SAFWA_DB_VERSION);
    expect(v3.tables.map((table) => table.name).sort()).toEqual(
      CURRENT_STORE_NAMES,
    );
    expect(await v3.bookmarks.count()).toBe(0);
    expect(await v3.lists.count()).toBe(0);
  });

  it("bookmark/list records written through the collections persistence module survive a db reopen", async () => {
    dbName = "safwa-migration-test-persistence-reopen";
    const KNOWN = new Set([7, 9]);

    const first = track(new SafwaDb(dbName));
    await first.open();
    await toggleBookmark(first, 7, KNOWN, 100, null);
    const list = await createListWithEntry(first, {
      name: "My list",
      entryId: 9,
      knownEntryIds: KNOWN,
      now: 101,
      owner: null,
    });
    first.close();

    // A genuinely fresh client instance re-opens the same on-disk database —
    // not just a re-read of the same still-open Dexie object.
    const reopened = track(new SafwaDb(dbName));
    await reopened.open();
    expect(reopened.verno).toBe(SAFWA_DB_VERSION);
    expect(await reopened.bookmarks.get([GUEST_OWNER_KEY, 7])).toEqual({
      // Writes key the row to its owner (the guest here).
      ownerKey: GUEST_OWNER_KEY,
      entryId: 7,
      createdAt: 100,
    });
    expect(await reopened.lists.get(list.id)).toEqual({
      ownerKey: GUEST_OWNER_KEY,
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

// Phase 16 R2-F3: v6 adds a local OWNER column + owner-scoped indexes to the
// five private learner-state stores. The upgrade is additive (no primary-key
// change, no upgrade function), but every already-deployed client runs it
// against a POPULATED v5 database, so that exact path is guarded here rather
// than inferred from the additive-schema argument (REL-001).
describe("Dexie migration v5 -> v6 — local owner columns (Phase 16 R2-F3)", () => {
  it("upgrades a populated v5 database, preserving rows and reading them as guest-owned", async () => {
    dbName = "safwa-migration-test-v5-populated";

    // 1. A real pre-R2 client: learner state written with NO `userId` field.
    const v5 = track(new LearnerDbV5(dbName));
    await v5.table("study_components").put({
      componentKey: "entry:1:skill:bab_identification",
      entryId: 1,
      learnerState: "learning",
      revision: 1,
    });
    await v5.table("review_events").put({
      eventId: "event-1",
      componentKey: "entry:1:skill:bab_identification",
      parentEventId: null,
      clientComponentRevision: 1,
      syncStatus: "local",
      createdAt: 100,
      status: "scheduling",
      localDateAtEvent: "2026-07-17",
    });
    await v5.table("bookmarks").put({ entryId: 7, createdAt: 95 });
    await v5.table("lists").put({
      id: "list-1",
      name: "My list",
      entryIds: [7, 9],
      createdAt: 96,
      updatedAt: 97,
    });
    await v5.table("settings").put({
      key: "timezone",
      value: { mode: "iana", timezone: "Asia/Tokyo" },
      updatedAt: 100,
    });
    expect(v5.verno).toBe(5);
    v5.close();

    // 2. The v6 client opens the same database. The upgrade must succeed and
    //    leave every pre-existing row readable by its unchanged primary key.
    const v6 = track(new SafwaDb(dbName));
    await v6.open();
    expect(v6.verno).toBe(SAFWA_DB_VERSION);
    expect(v6.tables.map((table) => table.name).sort()).toEqual(
      CURRENT_STORE_NAMES,
    );
    expect(
      await v6.studyComponents.get([
        GUEST_OWNER_KEY,
        "entry:1:skill:bab_identification",
      ]),
    ).toMatchObject({ entryId: 1, learnerState: "learning", revision: 1 });
    expect(await v6.reviewEvents.get("event-1")).toMatchObject({
      status: "scheduling",
      syncStatus: "local",
      localDateAtEvent: "2026-07-17",
    });
    expect(await v6.bookmarks.get([GUEST_OWNER_KEY, 7])).toEqual({
      ownerKey: GUEST_OWNER_KEY,
      entryId: 7,
      createdAt: 95,
    });
    expect(await v6.lists.get("list-1")).toMatchObject({ name: "My list" });
    expect(await v6.settings.get([GUEST_OWNER_KEY, "timezone"])).toMatchObject({
      value: { mode: "iana", timezone: "Asia/Tokyo" },
    });

    // 3. An absent `userId` reads as GUEST-owned, never as any account's.
    expect(
      (await readOwnedRows(v6.studyComponents, null)).map(
        (row) => row.componentKey,
      ),
    ).toEqual(["entry:1:skill:bab_identification"]);
    expect(await readOwnedRows(v6.studyComponents, "acct-1")).toEqual([]);
    expect(
      (await readOwnedRows(v6.reviewEvents, null)).map((r) => r.eventId),
    ).toEqual(["event-1"]);
    expect(await readOwnedRows(v6.reviewEvents, "acct-1")).toEqual([]);
    expect(
      (await readOwnedRows(v6.bookmarks, null)).map((r) => r.entryId),
    ).toEqual([7]);
    expect(await readOwnedRows(v6.bookmarks, "acct-1")).toEqual([]);
    expect((await readOwnedRows(v6.lists, null)).map((r) => r.id)).toEqual([
      "list-1",
    ]);
    expect(await readOwnedRows(v6.lists, "acct-1")).toEqual([]);
    expect((await readOwnedRows(v6.settings, null)).map((r) => r.key)).toEqual([
      "timezone",
    ]);
    expect(await readOwnedRows(v6.settings, "acct-1")).toEqual([]);

    // 4. The migrated guest backlog must NOT appear in an account's indexed
    //    push-selection slice — the R2-F3 starvation/leak guarantee.
    expect(
      await v6.reviewEvents
        .where("[ownerKey+syncStatus]")
        .equals([accountOwnerKey("acct-1"), "local"])
        .count(),
    ).toBe(0);

    // 5. The NEW compound indexes are usable after the upgrade: an account row
    //    written post-migration is found by the owner-scoped index, and the
    //    pre-existing guest row still does not leak into it.
    await v6.reviewEvents.put({
      eventId: "event-2",
      componentKey: "entry:1:skill:bab_identification",
      ownerKey: accountOwnerKey("acct-1"),
      parentEventId: null,
      clientComponentRevision: 1,
      syncStatus: "local",
      createdAt: 200,
      status: "scheduling",
      localDateAtEvent: "2026-07-18",
    });
    expect(
      (
        await v6.reviewEvents
          .where("[ownerKey+syncStatus]")
          .equals([accountOwnerKey("acct-1"), "local"])
          .toArray()
      ).map((row) => row.eventId),
    ).toEqual(["event-2"]);
    expect(
      (
        await v6.reviewEvents
          .where("[ownerKey+componentKey]")
          .equals([
            accountOwnerKey("acct-1"),
            "entry:1:skill:bab_identification",
          ])
          .toArray()
      ).map((row) => row.eventId),
    ).toEqual(["event-2"]);
  });

  it("upgrades an EMPTY v5 database", async () => {
    dbName = "safwa-migration-test-v5-empty";
    const v5 = track(new LearnerDbV5(dbName));
    await v5.open();
    expect(v5.verno).toBe(5);
    v5.close();

    const v6 = track(new SafwaDb(dbName));
    await v6.open();
    expect(v6.verno).toBe(SAFWA_DB_VERSION);
    expect(v6.tables.map((table) => table.name).sort()).toEqual(
      CURRENT_STORE_NAMES,
    );
    expect(await v6.reviewEvents.count()).toBe(0);
  });
});

// Phase 17 §10/§23: v7 promotes the OWNER into the identity of the private
// stores whose logical key collides across identities. IndexedDB cannot change
// a key path in place (Dexie: "Not yet support for changing primary key"), so
// v7 copies each into a new owner-keyed store and v8 drops the original. These
// tests run the upgrade against a POPULATED v6 database — the population every
// deployed Phase-16 client is on — and pin the guarantees §10 requires.
describe("Dexie migration v6 -> v7/v8 — owner-keyed identity (Phase 17 §10)", () => {
  const ACCOUNT = "acct-1";
  const ACCOUNT_KEY = accountOwnerKey(ACCOUNT);
  const COMPONENT = "entry:1:skill:bab_identification";

  /** Populate a v6 database with a guest's rows AND an account's rows. */
  async function seedV6(name: string): Promise<void> {
    const v6 = track(new LearnerDbV6(name));
    await v6.open();
    // GUEST rows (owner absent — the pre-v6 shape — and explicitly null).
    await v6.table("study_components").put({
      componentKey: COMPONENT,
      entryId: 1,
      learnerState: "learning",
      revision: 2,
    });
    await v6.table("bookmarks").put({ entryId: 7, createdAt: 95 });
    await v6.table("settings").put({
      key: "theme",
      value: "dark",
      updatedAt: 10,
      userId: null,
    });
    await v6.table("lists").put({
      id: "guest-list",
      name: "Guest verbs",
      entryIds: [7],
      createdAt: 1,
      updatedAt: 1,
    });
    await v6.table("review_events").put({
      eventId: "11111111-1111-4111-8111-111111111111",
      componentKey: COMPONENT,
      parentEventId: null,
      clientComponentRevision: 1,
      syncStatus: "local",
      createdAt: 100,
      status: "scheduling",
      clientSequence: 4,
    });
    await v6.table("study_attempts").put({
      id: "22222222-2222-4222-8222-222222222222",
      componentKey: COMPONENT,
      sessionId: "guest-session",
      attemptedAt: 100,
      attempt: { id: "22222222-2222-4222-8222-222222222222", userId: null },
    });
    await v6.table("sessions").put({ id: "guest-session", startedAt: 90 });
    // The derived cache, which the upgrade deliberately drops.
    await v6.table("daily_activity").put({
      localDate: "2026-07-17",
      attempts: 1,
      reviews: 1,
      newItems: 1,
      studyMs: 10,
      derivedAt: 1,
    });
    // ACCOUNT rows sharing the SAME natural keys.
    await v6.table("study_components").put({
      componentKey: COMPONENT + ":account",
      entryId: 1,
      userId: ACCOUNT,
      learnerState: "mastered",
      revision: 9,
    });
    await v6.table("settings").put({
      key: "account-only",
      value: "kept",
      updatedAt: 11,
      userId: ACCOUNT,
    });
    await v6.table("review_events").put({
      eventId: "33333333-3333-4333-8333-333333333333",
      componentKey: COMPONENT,
      userId: ACCOUNT,
      parentEventId: null,
      clientComponentRevision: 1,
      syncStatus: "accepted",
      createdAt: 200,
      status: "scheduling",
    });
    await v6.table("study_attempts").put({
      id: "44444444-4444-4444-8444-444444444444",
      componentKey: COMPONENT,
      sessionId: "account-session",
      attemptedAt: 200,
      attempt: { id: "44444444-4444-4444-8444-444444444444", userId: ACCOUNT },
    });
    await v6.table("sessions").put({ id: "account-session", startedAt: 190 });
    expect(v6.verno).toBe(6);
    v6.close();
  }

  it("moves every row to its owner-keyed store, treating an absent owner as the guest", async () => {
    dbName = "safwa-migration-test-v6-populated";
    await seedV6(dbName);

    const db = track(new SafwaDb(dbName));
    await db.open();
    expect(db.verno).toBe(SAFWA_DB_VERSION);
    // The four superseded stores are gone; their owner-keyed replacements exist.
    expect(db.tables.map((table) => table.name).sort()).toEqual(
      CURRENT_STORE_NAMES,
    );

    // Guest rows (absent OR null owner) are the guest's.
    expect(
      await db.studyComponents.get([GUEST_OWNER_KEY, COMPONENT]),
    ).toMatchObject({ entryId: 1, learnerState: "learning", revision: 2 });
    expect(await db.bookmarks.get([GUEST_OWNER_KEY, 7])).toMatchObject({
      createdAt: 95,
    });
    expect(await db.settings.get([GUEST_OWNER_KEY, "theme"])).toMatchObject({
      value: "dark",
    });
    expect(await db.lists.get("guest-list")).toMatchObject({
      ownerKey: GUEST_OWNER_KEY,
      name: "Guest verbs",
    });
    // Account rows keep THEIR owner.
    expect(
      await db.studyComponents.get([ACCOUNT_KEY, COMPONENT + ":account"]),
    ).toMatchObject({ learnerState: "mastered", revision: 9 });
    expect(await db.settings.get([ACCOUNT_KEY, "account-only"])).toMatchObject({
      value: "kept",
    });
    // The legacy owner column is not left behind to drift.
    expect(
      await db.settings.get([GUEST_OWNER_KEY, "theme"]),
    ).not.toHaveProperty("userId");
  });

  it("preserves globally-unique attempt/event ids and their metadata byte-for-byte", async () => {
    dbName = "safwa-migration-test-v6-ids";
    await seedV6(dbName);

    const db = track(new SafwaDb(dbName));
    await db.open();
    const guestEvent = await db.reviewEvents.get(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(guestEvent).toMatchObject({
      ownerKey: GUEST_OWNER_KEY,
      componentKey: COMPONENT,
      clientComponentRevision: 1,
      clientSequence: 4,
      createdAt: 100,
      status: "scheduling",
    });
    const accountEvent = await db.reviewEvents.get(
      "33333333-3333-4333-8333-333333333333",
    );
    expect(accountEvent?.ownerKey).toBe(ACCOUNT_KEY);
    // The attempt keeps its id AND its immutable engine payload untouched.
    const guestAttempt = await db.studyAttempts.get(
      "22222222-2222-4222-8222-222222222222",
    );
    expect(guestAttempt?.ownerKey).toBe(GUEST_OWNER_KEY);
    expect(guestAttempt?.attempt).toEqual({
      id: "22222222-2222-4222-8222-222222222222",
      userId: null,
    });
    const accountAttempt = await db.studyAttempts.get(
      "44444444-4444-4444-8444-444444444444",
    );
    expect(accountAttempt?.ownerKey).toBe(ACCOUNT_KEY);
    // Sessions inherit the owner of the attempts recorded in them.
    expect((await db.sessions.get("guest-session"))?.ownerKey).toBe(
      GUEST_OWNER_KEY,
    );
    expect((await db.sessions.get("account-session"))?.ownerKey).toBe(
      ACCOUNT_KEY,
    );
  });

  it("drops the derived daily-activity cache rather than guessing its owner", async () => {
    dbName = "safwa-migration-test-v6-cache";
    await seedV6(dbName);

    const db = track(new SafwaDb(dbName));
    await db.open();
    // Rebuildable from the raw stores, so it is never attributed by guesswork.
    expect(await db.dailyActivity.count()).toBe(0);
    // …and the new store is immediately usable, per owner.
    await db.dailyActivity.put({
      ownerKey: GUEST_OWNER_KEY,
      localDate: "2026-07-17",
      attempts: 1,
      reviews: 0,
      newItems: 1,
      studyMs: 5,
      derivedAt: 2,
    });
    await db.dailyActivity.put({
      ownerKey: ACCOUNT_KEY,
      localDate: "2026-07-17",
      attempts: 9,
      reviews: 9,
      newItems: 9,
      studyMs: 50,
      derivedAt: 2,
    });
    // The SAME calendar day for two identities is two rows, not one.
    expect(await db.dailyActivity.count()).toBe(2);
    expect(
      (await db.dailyActivity.get([ACCOUNT_KEY, "2026-07-17"]))?.attempts,
    ).toBe(9);
  });

  it("lets a guest and an account hold the SAME natural key without replacement (§10)", async () => {
    dbName = "safwa-migration-test-v6-coexist";
    await seedV6(dbName);

    const db = track(new SafwaDb(dbName));
    await db.open();
    // An ACCOUNT write against the guest's exact natural keys.
    await db.studyComponents.put({
      ownerKey: ACCOUNT_KEY,
      componentKey: COMPONENT,
      entryId: 1,
      learnerState: "needs_review",
      revision: 4,
    });
    await db.bookmarks.put({
      ownerKey: ACCOUNT_KEY,
      entryId: 7,
      createdAt: 96,
    });
    await db.settings.put({
      ownerKey: ACCOUNT_KEY,
      key: "theme",
      value: "light",
      updatedAt: 12,
    });

    // The guest's rows are untouched — the Phase 16 limitation is gone.
    expect(
      await db.studyComponents.get([GUEST_OWNER_KEY, COMPONENT]),
    ).toMatchObject({ learnerState: "learning", revision: 2 });
    expect((await db.bookmarks.get([GUEST_OWNER_KEY, 7]))?.createdAt).toBe(95);
    expect((await db.settings.get([GUEST_OWNER_KEY, "theme"]))?.value).toBe(
      "dark",
    );
    // …and each identity reads only its own rows.
    expect(
      (await readOwnedRows(db.studyComponents, null)).map(
        (row) => row.componentKey,
      ),
    ).toEqual([COMPONENT]);
    expect(
      (await readOwnedRows(db.studyComponents, ACCOUNT))
        .map((row) => row.componentKey)
        .sort(),
    ).toEqual([COMPONENT, COMPONENT + ":account"]);
    expect((await readOwnedRows(db.settings, null)).map((r) => r.key)).toEqual([
      "theme",
    ]);
    expect(
      (await readOwnedRows(db.settings, ACCOUNT)).map((r) => r.key).sort(),
    ).toEqual(["account-only", "theme"]);
  });

  it("survives a close + reopen of the migrated database", async () => {
    dbName = "safwa-migration-test-v6-reopen";
    await seedV6(dbName);

    const first = track(new SafwaDb(dbName));
    await first.open();
    expect(first.verno).toBe(SAFWA_DB_VERSION);
    first.close();

    const reopened = track(new SafwaDb(dbName));
    await reopened.open();
    expect(reopened.verno).toBe(SAFWA_DB_VERSION);
    expect(reopened.tables.map((table) => table.name).sort()).toEqual(
      CURRENT_STORE_NAMES,
    );
    expect(
      await reopened.studyComponents.get([GUEST_OWNER_KEY, COMPONENT]),
    ).toMatchObject({ revision: 2 });
    expect(
      await reopened.settings.get([ACCOUNT_KEY, "account-only"]),
    ).toMatchObject({ value: "kept" });
  });

  it("exports the migrated state, owner-scoped, after the upgrade", async () => {
    dbName = "safwa-migration-test-v6-export";
    await seedV6(dbName);

    const db = track(new SafwaDb(dbName));
    await db.open();
    const guestExport = await buildExportPayload(db, () => 0, null);
    expect(guestExport.bookmarks.map((row) => row.entryId)).toEqual([7]);
    expect(guestExport.settings.map((row) => row.key)).toEqual(["theme"]);
    expect(guestExport.lists.map((row) => row.id)).toEqual(["guest-list"]);
    expect(guestExport.study_attempts.map((row) => row.id)).toEqual([
      "22222222-2222-4222-8222-222222222222",
    ]);
    const accountExport = await buildExportPayload(db, () => 0, ACCOUNT);
    expect(accountExport.settings.map((row) => row.key)).toEqual([
      "account-only",
    ]);
    expect(accountExport.study_attempts.map((row) => row.id)).toEqual([
      "44444444-4444-4444-8444-444444444444",
    ]);
    // Neither export leaks the other identity's rows.
    expect(accountExport.bookmarks).toEqual([]);
  });

  it("rolls the whole upgrade back when it fails part-way (no partial migration)", async () => {
    dbName = "safwa-migration-test-v6-rollback";
    await seedV6(dbName);

    // A row whose stored owner cannot be a valid owner key at all (only
    // reachable by corruption or by hand-editing IndexedDB — the app only ever
    // writes an auth uuid there). The migration must FAIL LOUDLY rather than
    // guess an identity for a private row: guessing "guest" could expose an
    // account's rows, and dropping it would destroy learner data. Because the
    // whole upgrade is one version-change transaction, failing leaves the
    // database exactly as it was, at v6, with every row still readable.
    const corrupt = track(new LearnerDbV6(dbName));
    await corrupt.open();
    await corrupt.table("bookmarks").put({
      entryId: 99,
      createdAt: 1,
      userId: "x".repeat(200),
    });
    corrupt.close();

    const failing = track(new SafwaDb(dbName));
    await expect(failing.open()).rejects.toThrow();
    failing.close();

    // The database is still readable at v6, with every row intact — a failed
    // upgrade must never leave a half-migrated store behind.
    const v6 = track(new LearnerDbV6(dbName));
    await v6.open();
    expect(v6.verno).toBe(6);
    expect(await v6.table("bookmarks").get(7)).toMatchObject({ createdAt: 95 });
    expect(await v6.table("study_components").get(COMPONENT)).toMatchObject({
      revision: 2,
    });
    expect(await v6.table("lists").get("guest-list")).toMatchObject({
      name: "Guest verbs",
    });
    // Nothing was half-copied into the new owner-keyed stores.
    expect(v6.tables.map((table) => table.name)).not.toContain(
      "bookmarks_owned",
    );
  });

  it("upgrades successfully once the row that blocked it is removed (recoverable)", async () => {
    dbName = "safwa-migration-test-v6-recovery";
    await seedV6(dbName);

    // Same corruption as above: the upgrade refuses to guess an owner.
    const corrupt = track(new LearnerDbV6(dbName));
    await corrupt.open();
    await corrupt.table("bookmarks").put({
      entryId: 99,
      createdAt: 1,
      userId: "x".repeat(200),
    });
    corrupt.close();
    const blocked = track(new SafwaDb(dbName));
    await expect(blocked.open()).rejects.toThrow();
    blocked.close();

    // The block is RECOVERABLE, not terminal: the database is still fully
    // readable at v6, so the offending row can be removed (by a support path or
    // the learner's own data tools) and the upgrade then completes normally —
    // no reinstall, no data loss.
    const repair = track(new LearnerDbV6(dbName));
    await repair.open();
    await repair.table("bookmarks").delete(99);
    repair.close();

    const db = track(new SafwaDb(dbName));
    await db.open();
    expect(db.verno).toBe(SAFWA_DB_VERSION);
    expect(await db.bookmarks.get([GUEST_OWNER_KEY, 7])).toMatchObject({
      createdAt: 95,
    });
    expect(
      await db.studyComponents.get([GUEST_OWNER_KEY, COMPONENT]),
    ).toMatchObject({ revision: 2 });
  });

  it("migrates a history larger than one batch, in bounded batches", async () => {
    dbName = "safwa-migration-test-v6-batched";
    // More rows than MIGRATION_BATCH_SIZE (500) so the key-range paging loop
    // runs several times: every row must still arrive exactly once, with its
    // own owner, and none may be skipped at a batch boundary.
    const ROWS = 1200;
    const v6 = track(new LearnerDbV6(dbName));
    await v6.open();
    await v6.table("bookmarks").bulkPut(
      Array.from({ length: ROWS }, (_, index) => ({
        entryId: index + 1,
        createdAt: index,
        // Alternate identities so a batch boundary cannot silently coerce one.
        userId: index % 2 === 0 ? null : ACCOUNT,
      })),
    );
    await v6.table("review_events").bulkPut(
      Array.from({ length: ROWS }, (_, index) => ({
        eventId: `event-${String(index).padStart(5, "0")}`,
        componentKey: COMPONENT,
        parentEventId: null,
        clientComponentRevision: 1,
        syncStatus: "local",
        createdAt: index,
        status: "scheduling",
        userId: index % 2 === 0 ? null : ACCOUNT,
      })),
    );
    v6.close();

    const db = track(new SafwaDb(dbName));
    await db.open();
    expect(await db.bookmarks.count()).toBe(ROWS);
    expect(await db.reviewEvents.count()).toBe(ROWS);
    // Half each way, and the first/last row of the range both survived.
    expect((await readOwnedRows(db.bookmarks, null)).length).toBe(ROWS / 2);
    expect((await readOwnedRows(db.bookmarks, ACCOUNT)).length).toBe(ROWS / 2);
    expect(await db.bookmarks.get([GUEST_OWNER_KEY, 1])).toMatchObject({
      createdAt: 0,
    });
    expect(await db.bookmarks.get([ACCOUNT_KEY, ROWS])).toMatchObject({
      createdAt: ROWS - 1,
    });
    expect((await readOwnedRows(db.reviewEvents, ACCOUNT)).length).toBe(
      ROWS / 2,
    );
  });

  it("upgrades an EMPTY v6 database", async () => {
    dbName = "safwa-migration-test-v6-empty";
    const v6 = track(new LearnerDbV6(dbName));
    await v6.open();
    expect(v6.verno).toBe(6);
    v6.close();

    const db = track(new SafwaDb(dbName));
    await db.open();
    expect(db.verno).toBe(SAFWA_DB_VERSION);
    expect(db.tables.map((table) => table.name).sort()).toEqual(
      CURRENT_STORE_NAMES,
    );
    expect(await db.studyComponents.count()).toBe(0);
    expect(await db.bookmarks.count()).toBe(0);
    expect(await db.settings.count()).toBe(0);
    expect(await db.dailyActivity.count()).toBe(0);
  });
});
