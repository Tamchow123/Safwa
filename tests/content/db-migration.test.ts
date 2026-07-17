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

// Physical store names are a durable contract: the new v2 learner-state
// stores use the documented snake_case names (DATA_MODEL.md §9); the v1
// content stores keep their shipped camelCase names.
const V2_STORE_NAMES = [
  "bookmarks",
  "contentEntries",
  "contentMetadata",
  "contentReleases",
  "lists",
  "mutation_queue",
  "profile",
  "review_events",
  "sessions",
  "settings",
  "study_attempts",
  "study_components",
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

describe("Dexie migration v1 -> v2", () => {
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

    // 2. The Phase 5 client opens the same database.
    const v2 = track(new SafwaDb(dbName));
    await v2.open();
    expect(v2.verno).toBe(SAFWA_DB_VERSION);
    expect(v2.tables.map((table) => table.name).sort()).toEqual(V2_STORE_NAMES);

    // 3. The cached content survived the upgrade byte-for-byte and still
    //    passes full cryptographic verification.
    const record = await v2.contentReleases.get(built.releaseId);
    expect(record!.serializedLearner).toBe(built.serialized.learner);
    expect(record!.cachedAt).toBe(111);
    const active = await readVerifiedActiveCachedRelease(v2);
    expect(active).not.toBeNull();
    expect(active!.entries).toHaveLength(455);

    // 4. New learner-state stores are empty and usable.
    expect(await v2.profile.count()).toBe(0);
    expect(await v2.settings.count()).toBe(0);
    await v2.bookmarks.add({ entryId: 1, createdAt: 222 });
    expect(await v2.bookmarks.get(1)).toEqual({ entryId: 1, createdAt: 222 });
  });

  it("upgrades an empty v1 database", async () => {
    dbName = "safwa-migration-test-empty";
    const v1 = track(new ContentDbV1(dbName));
    await v1.open();
    v1.close();

    const v2 = track(new SafwaDb(dbName));
    await v2.open();
    expect(v2.verno).toBe(SAFWA_DB_VERSION);
    expect(v2.tables.map((table) => table.name).sort()).toEqual(V2_STORE_NAMES);
    expect(await readVerifiedActiveCachedRelease(v2)).toBeNull();
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
