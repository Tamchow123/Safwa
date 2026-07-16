/**
 * Dexie content cache — schema version 1 (content stores only; study,
 * profile and settings stores arrive in later phases with new versions).
 *
 * INTEGRITY MODEL: the exact serialized learner artifact is stored and is
 * authoritative. Every write recomputes SHA-256 over the exact bytes and
 * fully validates the parsed release before anything is persisted; every
 * read re-verifies hash + schema + metadata before any cached Arabic value
 * is returned. Indexed entry rows exist for future queries only — if they
 * are missing or inconsistent they are rebuilt transactionally from the
 * verified artifact and can never override it.
 *
 * BROWSER-ONLY: server components must never import or instantiate this.
 * Creation is lazy; tests use fake-indexeddb.
 */
import Dexie, { type EntityTable } from "dexie";

import {
  learnerReleaseSchema,
  type ContentEntryRecord,
  type ContentMetadataRecord,
  type ContentReleaseRecord,
  type LearnerEntry,
  type LearnerRelease,
} from "@/modules/content/schema";
import { sha256HexBrowser } from "@/modules/content/sha256-browser";

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

class CacheIntegrityError extends Error {}

/**
 * Verify serialized learner text against an expected checksum and fully
 * validate it. This is the single gate for both cache writes and reads —
 * a caller can never make arbitrary content "valid" by supplying an
 * arbitrary checksum string, because the hash is recomputed here from the
 * exact bytes and the parsed release must agree with itself.
 */
async function verifySerializedLearner(
  serializedLearner: string,
  expectedChecksum: string,
): Promise<{ release: LearnerRelease; checksum: string }> {
  const checksum = await sha256HexBrowser(serializedLearner);
  if (checksum !== expectedChecksum) {
    throw new CacheIntegrityError(
      `learner artifact checksum mismatch (expected ${expectedChecksum}, computed ${checksum})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serializedLearner);
  } catch (error) {
    throw new CacheIntegrityError(
      `learner artifact is not JSON: ${String(error)}`,
    );
  }
  const release = learnerReleaseSchema.parse(parsed);
  if (release.entry_count !== release.entries.length) {
    throw new CacheIntegrityError(
      `entry_count ${release.entry_count} disagrees with ${release.entries.length} entries`,
    );
  }
  const ids = new Set(release.entries.map((entry) => entry.id));
  if (ids.size !== release.entries.length) {
    throw new CacheIntegrityError("duplicate entry ids in learner artifact");
  }
  return { release, checksum };
}

function entryRowsFor(release: LearnerRelease): ContentEntryRecord[] {
  return release.entries.map((entry) => ({
    releaseId: release.release_id,
    entryId: entry.id,
    bab: entry.bab,
    verbType: entry.verb_type,
    bookPage: entry.book_page,
    entry,
  }));
}

/**
 * Cache one release transactionally from its EXACT serialized text. The
 * text is hash-verified and schema-validated before the transaction opens;
 * release row, exact artifact, entry rows and active metadata commit
 * together or not at all.
 */
export async function cacheLearnerRelease(
  db: SafwaContentDb,
  serializedLearner: string,
  expectedChecksum: string,
  now: number = Date.now(),
): Promise<LearnerRelease> {
  const { release, checksum } = await verifySerializedLearner(
    serializedLearner,
    expectedChecksum,
  );
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
        learnerChecksum: checksum,
        questionGeneratorVersion: release.question_generator_version,
        entryCount: release.entry_count,
        serializedLearner,
        cachedAt: now,
      });
      await db.contentEntries.bulkPut(entryRowsFor(release));
      // Activation is the LAST step inside the same transaction.
      await db.contentMetadata.put({
        key: "active",
        activeReleaseId: release.release_id,
        activeReleaseChecksum: checksum,
        lastSuccessfulRefreshAt: now,
      });
    },
  );
  return release;
}

/**
 * Read a cached release with full verification: recompute SHA-256 over the
 * stored artifact bytes, require agreement with the stored record checksum
 * (and the caller's expected checksum, e.g. from the active pointer or
 * active metadata), strictly re-validate, and confirm the record metadata
 * matches the parsed release.
 *
 * Indexed-row policy (documented): the verified artifact is authoritative.
 * Missing or inconsistent entry rows are rebuilt transactionally from it;
 * row contents are never returned directly. Returns null when the cache is
 * absent or fails verification — corrupted caches are never surfaced.
 */
export async function readVerifiedCachedRelease(
  db: SafwaContentDb,
  releaseId: string,
  expectedChecksum?: string,
): Promise<CachedRelease | null> {
  const record = await db.contentReleases.get(releaseId);
  if (!record || typeof record.serializedLearner !== "string") return null;

  let release: LearnerRelease;
  let checksum: string;
  try {
    ({ release, checksum } = await verifySerializedLearner(
      record.serializedLearner,
      expectedChecksum ?? record.learnerChecksum,
    ));
  } catch {
    return null;
  }
  if (checksum !== record.learnerChecksum) return null;
  if (
    release.release_id !== record.releaseId ||
    release.content_version !== record.contentVersion ||
    release.schema_version !== record.schemaVersion ||
    release.question_generator_version !== record.questionGeneratorVersion ||
    release.entry_count !== record.entryCount
  ) {
    return null;
  }

  // Rebuild the indexed rows if they drifted from the verified artifact.
  const rows = await db.contentEntries
    .where("releaseId")
    .equals(releaseId)
    .sortBy("entryId");
  const expectedRows = entryRowsFor(release);
  const rowsConsistent =
    rows.length === expectedRows.length &&
    rows.every(
      (row, index) =>
        row.entryId === expectedRows[index].entryId &&
        JSON.stringify(row.entry) === JSON.stringify(expectedRows[index].entry),
    );
  if (!rowsConsistent) {
    await db.transaction("rw", [db.contentEntries], async () => {
      await db.contentEntries.where("releaseId").equals(releaseId).delete();
      await db.contentEntries.bulkPut(expectedRows);
    });
  }

  // Entries are ALWAYS returned from the verified artifact, never rows.
  return { release: record, entries: release.entries };
}

/** Read the active cached release with full verification; null if invalid. */
export async function readVerifiedActiveCachedRelease(
  db: SafwaContentDb,
): Promise<CachedRelease | null> {
  const metadata = await db.contentMetadata.get("active");
  if (!metadata) return null;
  return readVerifiedCachedRelease(
    db,
    metadata.activeReleaseId,
    metadata.activeReleaseChecksum,
  );
}
