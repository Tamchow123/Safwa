/**
 * Dexie content cache — schema version 1 (content stores only; study,
 * profile and settings stores arrive in later phases with new versions).
 *
 * BROWSER-ONLY: server components must never import or instantiate this.
 * Creation is lazy; tests use fake-indexeddb.
 */
import Dexie, { type EntityTable } from "dexie";

import type {
  ContentEntryRecord,
  ContentMetadataRecord,
  ContentReleaseRecord,
  LearnerEntry,
  LearnerRelease,
} from "@/modules/content/schema";

export const CONTENT_DB_NAME = "safwa-content";
export const CONTENT_DB_VERSION = 1;

export class SafwaContentDb extends Dexie {
  contentReleases!: EntityTable<ContentReleaseRecord, "releaseId">;
  contentEntries!: EntityTable<ContentEntryRecord, "releaseId">;
  contentMetadata!: EntityTable<ContentMetadataRecord, "key">;

  constructor(name: string = CONTENT_DB_NAME) {
    super(name);
    this.version(CONTENT_DB_VERSION).stores({
      contentReleases: "releaseId",
      // Compound primary key + indexes needed by the upcoming library phase.
      contentEntries:
        "[releaseId+entryId], releaseId, entryId, bab, verbType, bookPage",
      contentMetadata: "key",
    });
  }
}

let singleton: SafwaContentDb | null = null;

/** Lazy browser singleton. Never call during server rendering. */
export function getContentDb(): SafwaContentDb {
  if (typeof indexedDB === "undefined") {
    throw new Error("content cache requires IndexedDB (browser context only)");
  }
  singleton ??= new SafwaContentDb();
  return singleton;
}

export type CachedRelease = {
  release: ContentReleaseRecord;
  entries: LearnerEntry[];
};

/**
 * Cache one release transactionally: the release row, all entries and the
 * active-metadata update commit together or not at all — a partial write
 * can never become the active release.
 */
export async function cacheLearnerRelease(
  db: SafwaContentDb,
  release: LearnerRelease,
  learnerChecksum: string,
  now: number = Date.now(),
): Promise<void> {
  await db.transaction(
    "rw",
    [db.contentReleases, db.contentEntries, db.contentMetadata],
    async () => {
      await db.contentEntries
        .where("releaseId")
        .equals(release.release_id)
        .delete();
      await db.contentReleases.put({
        releaseId: release.release_id,
        contentVersion: release.content_version,
        schemaVersion: release.schema_version,
        learnerChecksum,
        questionGeneratorVersion: release.question_generator_version,
        entryCount: release.entry_count,
        cachedAt: now,
      });
      await db.contentEntries.bulkPut(
        release.entries.map((entry) => ({
          releaseId: release.release_id,
          entryId: entry.id,
          bab: entry.bab,
          verbType: entry.verb_type,
          bookPage: entry.book_page,
          entry,
        })),
      );
      // Activation is the LAST step inside the same transaction.
      await db.contentMetadata.put({
        key: "active",
        activeReleaseId: release.release_id,
        activeReleaseChecksum: learnerChecksum,
        lastSuccessfulRefreshAt: now,
      });
    },
  );
}

/** Read a fully cached release; null if absent or incomplete. */
export async function readCachedRelease(
  db: SafwaContentDb,
  releaseId: string,
): Promise<CachedRelease | null> {
  const release = await db.contentReleases.get(releaseId);
  if (!release) return null;
  const records = await db.contentEntries
    .where("releaseId")
    .equals(releaseId)
    .sortBy("entryId");
  if (records.length !== release.entryCount) return null;
  return { release, entries: records.map((record) => record.entry) };
}

/** Read the currently active cached release; null if none is valid. */
export async function readActiveCachedRelease(
  db: SafwaContentDb,
): Promise<CachedRelease | null> {
  const metadata = await db.contentMetadata.get("active");
  if (!metadata) return null;
  const cached = await readCachedRelease(db, metadata.activeReleaseId);
  if (!cached) return null;
  if (cached.release.learnerChecksum !== metadata.activeReleaseChecksum) {
    return null;
  }
  return cached;
}
