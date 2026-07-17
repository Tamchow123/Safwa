/**
 * Dexie (IndexedDB) mirror — schema version 2.
 *
 * v1: content cache stores only. v2 (Phase 5) adds the local learner-state
 * stores from DATA_MODEL.md §9: study components (keyed by the shared
 * natural key string), attempts, review events, sessions, bookmarks, lists,
 * settings, the outbound mutation queue and the anonymous device profile.
 * Content and learning state live in separate stores of one database:
 * cached content releases are immutable verified artifacts, never editable
 * copies.
 *
 * INTEGRITY MODEL (content stores): the exact serialized learner artifact
 * is stored and is authoritative. Every write recomputes SHA-256 over the
 * exact bytes and fully validates the parsed release before anything is
 * persisted; every read re-verifies hash + schema + metadata before any
 * cached Arabic value is returned. Indexed entry rows exist for future
 * queries only — if they are missing or inconsistent they are rebuilt
 * transactionally from the verified artifact and can never override it.
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

/**
 * On-disk database name. Kept from v1 ("safwa-content") even though the
 * database now also holds learner state — renaming an IndexedDB database
 * would strand existing v1 caches instead of migrating them.
 */
export const SAFWA_DB_NAME = "safwa-content";
export const SAFWA_DB_VERSION = 2;

/* ------------------------------------------------------------------ */
/* Learner-state records (schema v2)                                   */
/*                                                                     */
/* Dexie fixes only key paths and indexes. The identity/index fields   */
/* below are the durable contract; the phases that first WRITE each    */
/* store (study engine 6, scheduler 7, sync 16+) extend the record     */
/* bodies additively without a schema version bump.                    */
/* ------------------------------------------------------------------ */

/** Anonymous local device profile — singleton row under key "device". */
export type DeviceProfileRecord = {
  key: "device";
  /** Random UUID minted lazily on first durable learner-state write. */
  deviceId: string;
  createdAt: number;
  /** navigator.storage.persist() outcome; null until first requested. */
  persistenceRequestedAt: number | null;
  persistenceGranted: boolean | null;
};

export type SettingRecord = {
  key: string;
  value: unknown;
  updatedAt: number;
};

export type BookmarkRecord = {
  entryId: number;
  createdAt: number;
};

export type CustomListRecord = {
  id: string;
  name: string;
  entryIds: number[];
  createdAt: number;
  updatedAt: number;
};

/** Local FSRS card state; identity is the shared natural key string. */
export type StudyComponentRecord = {
  componentKey: string;
  entryId: number;
};

export type StudyAttemptRecord = {
  id: string;
  componentKey: string;
  sessionId: string;
  attemptedAt: number;
};

export type ReviewEventRecord = {
  eventId: string;
  componentKey: string;
  /** Head of the local causal chain (null for a chain root). */
  parentEventId: string | null;
  clientComponentRevision: number;
  syncStatus: "local" | "pushed" | "accepted" | "demoted" | "rejected";
  createdAt: number;
};

export type StudySessionRecord = {
  id: string;
  startedAt: number;
};

export type MutationQueueRecord = {
  /** Auto-incremented outbound order; assigned by Dexie on add. */
  seq?: number;
  idempotencyKey: string;
  type: string;
  payload: unknown;
  createdAt: number;
};

export class SafwaDb extends Dexie {
  contentReleases!: EntityTable<ContentReleaseRecord, "releaseId">;
  contentEntries!: EntityTable<ContentEntryRecord, "releaseId">;
  contentMetadata!: EntityTable<ContentMetadataRecord, "key">;
  studyComponents!: EntityTable<StudyComponentRecord, "componentKey">;
  studyAttempts!: EntityTable<StudyAttemptRecord, "id">;
  reviewEvents!: EntityTable<ReviewEventRecord, "eventId">;
  sessions!: EntityTable<StudySessionRecord, "id">;
  bookmarks!: EntityTable<BookmarkRecord, "entryId">;
  lists!: EntityTable<CustomListRecord, "id">;
  settings!: EntityTable<SettingRecord, "key">;
  mutationQueue!: EntityTable<MutationQueueRecord, "seq">;
  profile!: EntityTable<DeviceProfileRecord, "key">;

  constructor(name: string = SAFWA_DB_NAME) {
    super(name);
    this.version(1).stores({
      contentReleases: "releaseId",
      // Compound primary key + indexes needed by the library phase.
      contentEntries:
        "[releaseId+entryId], releaseId, entryId, bab, verbType, bookPage",
      contentMetadata: "key",
    });
    // v2 is purely additive: new learner-state stores, no upgrade function
    // needed — Dexie carries every v1 store and its data forward untouched.
    // Physical store names follow the documented schema contract
    // (DATA_MODEL.md §9: snake_case). The v1 content stores keep their
    // shipped camelCase names — renaming an already-deployed store would
    // need a data-copying migration, an explicit migration decision.
    this.version(SAFWA_DB_VERSION).stores({
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
    // Code-facing accessors stay camelCase per TS convention; the mapping
    // to the snake_case physical stores lives here and nowhere else.
    this.studyComponents = this.table("study_components");
    this.studyAttempts = this.table("study_attempts");
    this.reviewEvents = this.table("review_events");
    this.mutationQueue = this.table("mutation_queue");
  }
}

let singleton: SafwaDb | null = null;

/** Lazy browser singleton. Never call during server rendering. */
export function getSafwaDb(): SafwaDb {
  if (typeof indexedDB === "undefined") {
    throw new Error(
      "local persistence requires IndexedDB (browser context only)",
    );
  }
  singleton ??= new SafwaDb();
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
 * Compare EVERY field of an indexed row against the artifact-derived
 * expectation — including the denormalised index fields (bab, verbType,
 * bookPage), because Dexie queries filter on those independently of the
 * embedded entry. Any drift marks the whole row set inconsistent.
 */
export function entryRowMatchesExpected(
  actual: ContentEntryRecord,
  expected: ContentEntryRecord,
): boolean {
  return (
    actual.releaseId === expected.releaseId &&
    actual.entryId === expected.entryId &&
    actual.bab === expected.bab &&
    actual.verbType === expected.verbType &&
    actual.bookPage === expected.bookPage &&
    JSON.stringify(actual.entry) === JSON.stringify(expected.entry)
  );
}

/**
 * Cache one release transactionally from its EXACT serialized text. The
 * text is hash-verified and schema-validated before the transaction opens;
 * release row, exact artifact, entry rows and active metadata commit
 * together or not at all.
 */
export async function cacheLearnerRelease(
  db: SafwaDb,
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
  db: SafwaDb,
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
    rows.every((row, index) =>
      entryRowMatchesExpected(row, expectedRows[index]),
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
  db: SafwaDb,
): Promise<CachedRelease | null> {
  const metadata = await db.contentMetadata.get("active");
  if (!metadata) return null;
  return readVerifiedCachedRelease(
    db,
    metadata.activeReleaseId,
    metadata.activeReleaseChecksum,
  );
}
