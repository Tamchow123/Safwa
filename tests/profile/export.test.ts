import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SafwaDb } from "@/modules/content/db";
import {
  addEntryToList,
  createList,
  createListWithEntry,
  deleteList,
  removeEntryFromList,
  renameList,
  toggleBookmark,
} from "@/modules/collections/persistence";
import { getOrCreateDeviceProfile } from "@/modules/profile/device";
import {
  buildExportPayload,
  EXPORT_SCHEMA_VERSION,
  exportFilename,
  serializeExport,
} from "@/modules/profile/export";
import { writeSetting } from "@/modules/profile/settings";

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

const KNOWN = new Set([1, 2, 7, 9, 262, 275]);

let dbCounter = 0;
let db: SafwaDb;

beforeEach(() => {
  dbCounter += 1;
  db = new SafwaDb(`safwa-export-test-${dbCounter}`);
  ensureDurableGuestStateSpy.mockClear();
});

afterEach(async () => {
  await db.delete();
});

describe("buildExportPayload", () => {
  it("exports an empty guest as a valid, well-formed document", async () => {
    const payload = await buildExportPayload(db, () => 0);
    expect(payload).toEqual({
      export_schema_version: EXPORT_SCHEMA_VERSION,
      app: "safwa",
      exported_at: "1970-01-01T00:00:00.000Z",
      device_profile: null,
      active_content: null,
      settings: [],
      bookmarks: [],
      lists: [],
      sessions: [],
      study_components: [],
      study_attempts: [],
      review_events: [],
      mutation_queue: [],
    });
  });

  it("deliberately excludes the daily_activity derived cache (Phase 12 §24)", async () => {
    // The cache is rebuildable from study_attempts/review_events; exporting
    // it would ship derived data as if it were learner truth.
    await db.dailyActivity.put({
      localDate: "2026-07-17",
      attempts: 3,
      reviews: 1,
      newItems: 2,
      studyMs: 4500,
      derivedAt: 1,
    });
    const payload = await buildExportPayload(db, () => 0);
    expect(payload).not.toHaveProperty("daily_activity");
    expect(payload).not.toHaveProperty("dailyActivity");
  });

  it("includes every learner-state store and the active content reference", async () => {
    const profile = await getOrCreateDeviceProfile(db, {
      now: () => 1,
      randomUUID: () => "uuid-export",
    });
    await writeSetting(db, "arabic-font-scale", "large", () => 2);
    await db.bookmarks.add({ entryId: 7, createdAt: 3 });
    await db.lists.add({
      id: "list-1",
      name: "My verbs",
      entryIds: [7, 9],
      createdAt: 4,
      updatedAt: 4,
    });
    await db.sessions.add({ id: "session-1", startedAt: 5 });
    await db.studyComponents.add({
      componentKey:
        "entry:7:skill:meaning_recognition:field:madi:direction:arabic_to_english",
      entryId: 7,
    });
    await db.studyAttempts.add({
      id: "attempt-1",
      componentKey:
        "entry:7:skill:meaning_recognition:field:madi:direction:arabic_to_english",
      sessionId: "session-1",
      attemptedAt: 6,
    });
    await db.reviewEvents.add({
      eventId: "event-1",
      componentKey:
        "entry:7:skill:meaning_recognition:field:madi:direction:arabic_to_english",
      parentEventId: null,
      clientComponentRevision: 1,
      syncStatus: "local",
      createdAt: 7,
    });
    await db.mutationQueue.add({
      idempotencyKey: "idem-1",
      type: "test",
      payload: { ok: true },
      createdAt: 8,
    });
    // Direct records, not the verified cache path: the export reads
    // metadata references only and never re-serves content.
    await db.contentReleases.add({
      releaseId: "rel-1",
      contentVersion: "2.0.0",
      schemaVersion: "1",
      learnerChecksum: "a".repeat(64),
      questionGeneratorVersion: "1",
      entryCount: 1,
      serializedLearner: "{}",
      cachedAt: 9,
    });
    await db.contentMetadata.add({
      key: "active",
      activeReleaseId: "rel-1",
      activeReleaseChecksum: "a".repeat(64),
      lastSuccessfulRefreshAt: 9,
    });

    const payload = await buildExportPayload(db, () => 1_000);
    expect(payload.device_profile).toEqual(profile);
    expect(payload.active_content).toEqual({
      release_id: "rel-1",
      content_version: "2.0.0",
    });
    expect(payload.settings).toHaveLength(1);
    expect(payload.bookmarks).toEqual([{ entryId: 7, createdAt: 3 }]);
    expect(payload.lists).toHaveLength(1);
    expect(payload.sessions).toHaveLength(1);
    expect(payload.study_components).toHaveLength(1);
    expect(payload.study_attempts).toHaveLength(1);
    expect(payload.review_events).toHaveLength(1);
    expect(payload.mutation_queue).toHaveLength(1);
    expect(payload.mutation_queue[0].seq).toBeTypeOf("number");
    // The export must never embed the content artifact itself.
    expect(JSON.stringify(payload)).not.toContain("serializedLearner");
  });

  it("serialises to valid JSON that round-trips losslessly", async () => {
    await getOrCreateDeviceProfile(db, { randomUUID: () => "uuid-rt" });
    const payload = await buildExportPayload(db, () => 123_456);
    const json = serializeExport(payload);
    expect(JSON.parse(json)).toEqual(payload);
  });

  // Phase 14 §22: bookmarks/lists round-trip through the collections
  // persistence layer (modules/collections/persistence.ts), not raw Dexie
  // writes — proving the export reflects exactly what the real write paths
  // (createList/addEntryToList/renameList/deleteList/toggleBookmark)
  // actually persist, without an export-schema bump (still version 1).
  describe("bookmarks/lists round-trip (§22)", () => {
    it("keeps the export schema version at 1 (no bump for the collections stores)", async () => {
      await toggleBookmark(db, 7, KNOWN, 1, null);
      const payload = await buildExportPayload(db, () => 2);
      expect(payload.export_schema_version).toBe(EXPORT_SCHEMA_VERSION);
      expect(EXPORT_SCHEMA_VERSION).toBe(1);
    });

    it("a created bookmark appears in the export", async () => {
      await toggleBookmark(db, 7, KNOWN, 10, null);
      const payload = await buildExportPayload(db, () => 20);
      expect(payload.bookmarks).toEqual([
        { entryId: 7, createdAt: 10, userId: null },
      ]);
    });

    it("a created list appears in the export with canonical (deduped, sorted) membership", async () => {
      const list = await createList(db, {
        name: "My verbs",
        now: 1,
        owner: null,
      });
      // Added out of order and with a duplicate id — the write path
      // canonicalises, so the export reflects the canonical form, never the
      // raw call order.
      await addEntryToList(db, list.id, 9, KNOWN, 2, null);
      await addEntryToList(db, list.id, 2, KNOWN, 3, null);
      await addEntryToList(db, list.id, 9, KNOWN, 4, null); // idempotent duplicate

      const payload = await buildExportPayload(db, () => 5);
      expect(payload.lists).toHaveLength(1);
      expect(payload.lists[0].name).toBe("My verbs");
      expect(payload.lists[0].entryIds).toEqual([2, 9]);
    });

    it("a list rename appears in the export", async () => {
      const list = await createList(db, {
        name: "Original name",
        now: 1,
        owner: null,
      });
      await renameList(db, list.id, "Renamed list", 2, null);

      const payload = await buildExportPayload(db, () => 3);
      expect(payload.lists).toHaveLength(1);
      expect(payload.lists[0].name).toBe("Renamed list");
    });

    it("a removed entry disappears from the export", async () => {
      const list = await createListWithEntry(db, {
        name: "Two entries",
        entryId: 7,
        knownEntryIds: KNOWN,
        now: 1,
        owner: null,
      });
      await addEntryToList(db, list.id, 9, KNOWN, 2, null);
      await removeEntryFromList(db, list.id, 7, 3, null);

      const payload = await buildExportPayload(db, () => 4);
      expect(payload.lists[0].entryIds).toEqual([9]);
    });

    it("a deleted list disappears from the export", async () => {
      const kept = await createList(db, { name: "Kept", now: 1, owner: null });
      const removed = await createList(db, {
        name: "Removed",
        now: 2,
        owner: null,
      });
      await deleteList(db, removed.id, 0, null);

      const payload = await buildExportPayload(db, () => 3);
      expect(payload.lists).toHaveLength(1);
      expect(payload.lists[0].id).toBe(kept.id);
    });

    it("bookmarks survive list deletion", async () => {
      await toggleBookmark(db, 7, KNOWN, 1, null);
      const list = await createListWithEntry(db, {
        name: "Temporary list",
        entryId: 7,
        knownEntryIds: KNOWN,
        now: 2,
        owner: null,
      });
      await deleteList(db, list.id, 0, null);

      const payload = await buildExportPayload(db, () => 3);
      expect(payload.lists).toEqual([]);
      expect(payload.bookmarks).toEqual([
        { entryId: 7, createdAt: 1, userId: null },
      ]);
    });

    it("stays internally consistent: bookmarks and lists exactly match the current Dexie rows after a mixed sequence of writes", async () => {
      await toggleBookmark(db, 7, KNOWN, 1, null);
      await toggleBookmark(db, 9, KNOWN, 2, null);
      await toggleBookmark(db, 7, KNOWN, 3, null); // un-bookmark 7
      const listA = await createListWithEntry(db, {
        name: "List A",
        entryId: 2,
        knownEntryIds: KNOWN,
        now: 4,
        owner: null,
      });
      const listB = await createList(db, {
        name: "List B",
        now: 5,
        owner: null,
      });
      await deleteList(db, listB.id, 0, null);
      await addEntryToList(db, listA.id, 262, KNOWN, 6, null);

      const payload = await buildExportPayload(db, () => 7);
      const [expectedBookmarks, expectedLists] = await Promise.all([
        db.bookmarks.toArray(),
        db.lists.toArray(),
      ]);
      expect(payload.bookmarks).toEqual(expectedBookmarks);
      expect(payload.lists).toEqual(expectedLists);
      expect(payload.bookmarks.map((b) => b.entryId)).toEqual([9]);
      expect(payload.lists).toHaveLength(1);
      expect(payload.lists[0].entryIds).toEqual([2, 262]);
    });
  });
});

/**
 * Owner scoping (schema v6, R2-F3 / ARCH-001, SEC-001). Since a guest's and a
 * signed-in account's private rows can coexist in these stores until the
 * sign-out wipe, "export my data" must hand back only the ACTIVE identity's
 * rows — otherwise a shared device lets one identity download another's
 * bookmarks, lists, FSRS cards and review history.
 */
describe("buildExportPayload owner scoping (R2-F3 / ARCH-001)", () => {
  const ACCOUNT = "acct-1";

  /** Seed one bookmark + list + component + attempt + event owned by `owner`. */
  async function seedOwned(
    owner: string | null,
    entryId: number,
    suffix: string,
  ): Promise<void> {
    await db.bookmarks.put({ entryId, createdAt: 1, userId: owner });
    await db.lists.put({
      id: `list-${suffix}`,
      name: `List ${suffix}`,
      entryIds: [entryId],
      createdAt: 1,
      updatedAt: 1,
      userId: owner,
    });
    await db.settings.put({
      key: `setting-${suffix}`,
      value: suffix,
      updatedAt: 1,
      userId: owner,
    });
    await db.studyComponents.put({
      componentKey: `entry:${entryId}:skill:bab_identification`,
      entryId,
      userId: owner,
      learnerState: "learning",
    });
    await db.studyAttempts.put({
      id: `attempt-${suffix}`,
      componentKey: `entry:${entryId}:skill:bab_identification`,
      sessionId: `session-${suffix}`,
      attemptedAt: 1,
      attempt: { userId: owner, entryId } as never,
    });
    await db.reviewEvents.put({
      eventId: `event-${suffix}`,
      componentKey: `entry:${entryId}:skill:bab_identification`,
      userId: owner,
      parentEventId: null,
      clientComponentRevision: 1,
      syncStatus: "local",
      createdAt: 1,
    });
    await db.mutationQueue.add({
      idempotencyKey: `mutation-${suffix}`,
      type: "bookmark",
      payload: null,
      createdAt: 1,
      userId: owner ?? undefined,
    } as never);
  }

  it("an account's export contains NONE of a coexisting guest's private rows", async () => {
    await seedOwned(null, 1, "guest");
    await seedOwned(ACCOUNT, 2, "acct");

    const payload = await buildExportPayload(db, () => 0, ACCOUNT);
    expect(payload.bookmarks.map((b) => b.entryId)).toEqual([2]);
    expect(payload.lists.map((l) => l.id)).toEqual(["list-acct"]);
    expect(payload.settings.map((s) => s.key)).toEqual(["setting-acct"]);
    expect(payload.study_components.map((c) => c.componentKey)).toEqual([
      "entry:2:skill:bab_identification",
    ]);
    expect(payload.study_attempts.map((a) => a.id)).toEqual(["attempt-acct"]);
    expect(payload.review_events.map((e) => e.eventId)).toEqual(["event-acct"]);
    expect(payload.mutation_queue.map((m) => m.idempotencyKey)).toEqual([
      "mutation-acct",
    ]);
  });

  it("a guest's export contains NONE of a coexisting account's private rows", async () => {
    await seedOwned(null, 1, "guest");
    await seedOwned(ACCOUNT, 2, "acct");

    const payload = await buildExportPayload(db, () => 0, null);
    expect(payload.bookmarks.map((b) => b.entryId)).toEqual([1]);
    expect(payload.lists.map((l) => l.id)).toEqual(["list-guest"]);
    expect(payload.settings.map((s) => s.key)).toEqual(["setting-guest"]);
    expect(payload.study_components.map((c) => c.componentKey)).toEqual([
      "entry:1:skill:bab_identification",
    ]);
    expect(payload.study_attempts.map((a) => a.id)).toEqual(["attempt-guest"]);
    expect(payload.review_events.map((e) => e.eventId)).toEqual([
      "event-guest",
    ]);
    expect(payload.mutation_queue.map((m) => m.idempotencyKey)).toEqual([
      "mutation-guest",
    ]);
  });

  it("device-level rows (profile, sessions, active content) are NOT owner-filtered", async () => {
    await db.sessions.put({ id: "session-x", startedAt: 5 });
    await getOrCreateDeviceProfile(db, { now: () => 1 });

    const payload = await buildExportPayload(db, () => 0, ACCOUNT);
    expect(payload.sessions.map((s) => s.id)).toEqual(["session-x"]);
    expect(payload.device_profile).not.toBeNull();
  });
});

describe("exportFilename", () => {
  it("uses the UTC date of the export moment", () => {
    // 2026-07-16T23:59:59Z stays the 16th in UTC regardless of local zone.
    const now = () => Date.UTC(2026, 6, 16, 23, 59, 59);
    expect(exportFilename(now)).toBe("safwa-export-2026-07-16.json");
  });
});
