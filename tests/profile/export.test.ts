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
      await toggleBookmark(db, 7, KNOWN, 1);
      const payload = await buildExportPayload(db, () => 2);
      expect(payload.export_schema_version).toBe(EXPORT_SCHEMA_VERSION);
      expect(EXPORT_SCHEMA_VERSION).toBe(1);
    });

    it("a created bookmark appears in the export", async () => {
      await toggleBookmark(db, 7, KNOWN, 10);
      const payload = await buildExportPayload(db, () => 20);
      expect(payload.bookmarks).toEqual([{ entryId: 7, createdAt: 10 }]);
    });

    it("a created list appears in the export with canonical (deduped, sorted) membership", async () => {
      const list = await createList(db, { name: "My verbs", now: 1 });
      // Added out of order and with a duplicate id — the write path
      // canonicalises, so the export reflects the canonical form, never the
      // raw call order.
      await addEntryToList(db, list.id, 9, KNOWN, 2);
      await addEntryToList(db, list.id, 2, KNOWN, 3);
      await addEntryToList(db, list.id, 9, KNOWN, 4); // idempotent duplicate

      const payload = await buildExportPayload(db, () => 5);
      expect(payload.lists).toHaveLength(1);
      expect(payload.lists[0].name).toBe("My verbs");
      expect(payload.lists[0].entryIds).toEqual([2, 9]);
    });

    it("a list rename appears in the export", async () => {
      const list = await createList(db, { name: "Original name", now: 1 });
      await renameList(db, list.id, "Renamed list", 2);

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
      });
      await addEntryToList(db, list.id, 9, KNOWN, 2);
      await removeEntryFromList(db, list.id, 7, 3);

      const payload = await buildExportPayload(db, () => 4);
      expect(payload.lists[0].entryIds).toEqual([9]);
    });

    it("a deleted list disappears from the export", async () => {
      const kept = await createList(db, { name: "Kept", now: 1 });
      const removed = await createList(db, { name: "Removed", now: 2 });
      await deleteList(db, removed.id);

      const payload = await buildExportPayload(db, () => 3);
      expect(payload.lists).toHaveLength(1);
      expect(payload.lists[0].id).toBe(kept.id);
    });

    it("bookmarks survive list deletion", async () => {
      await toggleBookmark(db, 7, KNOWN, 1);
      const list = await createListWithEntry(db, {
        name: "Temporary list",
        entryId: 7,
        knownEntryIds: KNOWN,
        now: 2,
      });
      await deleteList(db, list.id);

      const payload = await buildExportPayload(db, () => 3);
      expect(payload.lists).toEqual([]);
      expect(payload.bookmarks).toEqual([{ entryId: 7, createdAt: 1 }]);
    });

    it("stays internally consistent: bookmarks and lists exactly match the current Dexie rows after a mixed sequence of writes", async () => {
      await toggleBookmark(db, 7, KNOWN, 1);
      await toggleBookmark(db, 9, KNOWN, 2);
      await toggleBookmark(db, 7, KNOWN, 3); // un-bookmark 7
      const listA = await createListWithEntry(db, {
        name: "List A",
        entryId: 2,
        knownEntryIds: KNOWN,
        now: 4,
      });
      const listB = await createList(db, { name: "List B", now: 5 });
      await deleteList(db, listB.id);
      await addEntryToList(db, listA.id, 262, KNOWN, 6);

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

describe("exportFilename", () => {
  it("uses the UTC date of the export moment", () => {
    // 2026-07-16T23:59:59Z stays the 16th in UTC regardless of local zone.
    const now = () => Date.UTC(2026, 6, 16, 23, 59, 59);
    expect(exportFilename(now)).toBe("safwa-export-2026-07-16.json");
  });
});
