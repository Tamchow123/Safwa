/**
 * Dexie (IndexedDB) mirror — current schema version is `SAFWA_DB_VERSION`
 * (each `this.version(n).stores(...)` block below is the authoritative record
 * of what that version added).
 *
 * v1: content cache stores only. v2 (Phase 5) adds the local learner-state
 * stores from DATA_MODEL.md §9: study components (keyed by the shared
 * natural key string), attempts, review events, sessions, bookmarks, lists,
 * settings, the outbound mutation queue and the anonymous device profile.
 * v3 (Phase 12) adds the `daily_activity` derived analytics cache. v4 (Phase
 * 16) adds the `sync_state` cursor store; v5 (Phase 16) adds the outbox
 * indexes to `mutation_queue`. v6 (Phase 16, R2-F3) adds a local OWNER
 * (`userId`, null = guest) + owner-scoped compound indexes to the private
 * learner-state stores (study_components, review_events, bookmarks, lists,
 * settings) so a signed-in account never reads/extends/overwrites a guest's (or
 * another account's) rows sharing the same natural key — additive (new columns
 * + indexes only, no key change, no data move).
 *
 * v7/v8 (Phase 17 §10) finish that job: the owner becomes part of a private
 * row's IDENTITY, not just a column, so a guest's and an account's rows for the
 * same natural key COEXIST instead of one physically replacing the other. The
 * owner is the non-null `OwnerKey` (`guest` | `account:<id>` —
 * modules/content/owner-key.ts), because IndexedDB cannot index `null` and a
 * compound key containing it is not a valid key at all. study_components,
 * bookmarks, settings and daily_activity are re-keyed to `[ownerKey+…]` (a
 * key-path change IndexedDB cannot make in place, hence the copy-into-new-store
 * migration in v7 and the drop of the originals in v8); review_events,
 * study_attempts, sessions and lists keep their globally-unique primary keys —
 * imported ids must never change — and gain an indexed `ownerKey`.
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
import Dexie, { type EntityTable, type Table, type Transaction } from "dexie";

import {
  learnerReleaseSchema,
  type ContentEntryRecord,
  type ContentMetadataRecord,
  type ContentReleaseRecord,
  type LearnerEntry,
  type LearnerRelease,
} from "@/modules/content/schema";
import {
  GUEST_OWNER_KEY,
  ownerKeyFromLegacyUserId,
  type OwnerKey,
} from "@/modules/content/owner-key";
import { sha256HexBrowser } from "@/modules/content/sha256-browser";
import type { AttemptRecord } from "@/modules/study-engine/attempts";

/**
 * On-disk database name. Kept from v1 ("safwa-content") even though the
 * database now also holds learner state — renaming an IndexedDB database
 * would strand existing v1 caches instead of migrating them.
 *
 * v3 (Phase 12) adds the `daily_activity` DERIVED cache store additively:
 * no upgrade function, no change to any existing store's keys or indexes.
 */
export const SAFWA_DB_NAME = "safwa-content";
export const SAFWA_DB_VERSION = 8;

/**
 * Physical names of the four stores schema v7 RECREATED with an owner-keyed
 * compound primary key. IndexedDB cannot change an existing store's key path, so
 * the owner-keyed store is a new one and the v6 store is dropped in v8 — see the
 * version blocks below. The names are an implementation detail of this module:
 * every consumer goes through the camelCase accessors (`db.bookmarks`, …). It
 * is exported only so the E2E raw-IndexedDB helpers — which cannot import Dexie
 * into `page.evaluate` — can be CHECKED against it rather than drifting from it
 * (tests/e2e-helpers/idb-store-names.test.ts).
 */
export const OWNED_STORE_NAMES = {
  studyComponents: "study_components_owned",
  bookmarks: "bookmarks_owned",
  settings: "settings_owned",
  dailyActivity: "daily_activity_owned",
} as const;

/** A row as stored under the v6 contract, whose owner was the nullable `userId`. */
type LegacyOwnedRow = { userId?: string | null };

/**
 * How many rows the v7 upgrade reads and writes at a time. Bounds the peak
 * memory of a one-off migration over a multi-year learner history without
 * making the pass chatty (a few hundred rows per round trip).
 */
const MIGRATION_BATCH_SIZE = 500;

/* ------------------------------------------------------------------ */
/* Learner-state records (schema v2) and derived-cache records (v3)    */
/*                                                                     */
/* Dexie fixes only key paths and indexes. The identity/index fields   */
/* below are the durable contract; the phases that first WRITE each    */
/* store (study engine 6, scheduler 7, sync 16+) extend the record     */
/* bodies additively without a schema version bump. DailyActivityRecord */
/* belongs to schema v3 (Phase 12) — see its own doc comment.          */
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
  /**
   * Last issued per-DEVICE monotonic `client_sequence` (schema v7). It lives on
   * the device profile — not in `settings` — because it belongs to the device,
   * not to any one identity: the counter must keep advancing across a guest, an
   * account and a merge that removes the guest's rows, which an owner-keyed
   * settings row could not guarantee. Absent until the first scheduling event.
   */
  lastClientSequence?: number;
};

/**
 * The local owner of a private learner-state row: the signed-in account id, or
 * `null` for a guest. This is the LOGICAL owner every adapter and hook passes
 * around; its durable, IndexedDB-valid encoding is the `OwnerKey`
 * (`modules/content/owner-key.ts`), which is what rows actually store and what
 * the compound primary keys are built from.
 *
 * Since schema v7 (Phase 17 §10) the owner is part of a private row's IDENTITY,
 * not merely a column: a guest's and an account's rows for the same natural key
 * COEXIST instead of one replacing the other, which is what makes a deferred
 * merge (and a scoped logout that preserves guest data) possible at all.
 */
export type LocalOwnerId = string | null;

export type SettingRecord = {
  /** Owner half of the compound primary key `[ownerKey+key]` (schema v7). */
  ownerKey: OwnerKey;
  key: string;
  value: unknown;
  updatedAt: number;
};

export type BookmarkRecord = {
  /** Owner half of the compound primary key `[ownerKey+entryId]` (schema v7). */
  ownerKey: OwnerKey;
  entryId: number;
  createdAt: number;
};

export type CustomListRecord = {
  /**
   * Owning identity (schema v7). The primary key stays the globally-unique
   * `id`, so an imported guest list can keep its uuid; `ownerKey` is the
   * indexed scope every read narrows on.
   */
  ownerKey: OwnerKey;
  id: string;
  name: string;
  entryIds: number[];
  createdAt: number;
  updatedAt: number;
};

/**
 * Local FSRS card state; identity is the shared natural key string. The Phase-7
 * scheduler fields are added additively (no schema-version bump — no index
 * change): they are absent until the component's first review. Shapes mirror
 * `modules/scheduler` (`SchedulerCard` / `LearnerState`); the scheduler stays
 * pure and does the writing via a thin adapter in later phases.
 */
export type StudyComponentRecord = {
  /** Owner half of the compound primary key `[ownerKey+componentKey]` (schema v7). */
  ownerKey: OwnerKey;
  componentKey: string;
  entryId: number;
  /** FSRS card fields (present once the component has been reviewed). */
  fsrs?: {
    stability: number;
    difficulty: number;
    dueAtMs: number;
    state: "new" | "learning" | "review" | "relearning";
    reps: number;
    lapses: number;
    scheduledDays: number;
    learningSteps: number;
    lastReviewAtMs: number | null;
  };
  /** Projected learner state (recomputed from replay). */
  learnerState?: "not_started" | "learning" | "mastered" | "needs_review";
  /** Head client_component_revision of the local chain (0 = none). */
  revision?: number;
  /**
   * Lineage ANCHOR (R2-F2), set only by a server pull: the authoritative
   * accepted chain head's event id + that head's client_component_revision. When
   * this account has NO local events for the component (a fresh bootstrap, or
   * after a logout wiped the local chain), the next review parents onto this
   * anchor so it extends the server chain instead of rooting a rejected stale
   * branch. Cleared the moment a local event exists (a projection write omits
   * them), after which the local chain head is authoritative. Null head = the
   * server has no accepted scheduling head to extend.
   */
  syncedHeadEventId?: string | null;
  syncedHeadClientRevision?: number | null;
};

export type StudyAttemptRecord = {
  id: string;
  /**
   * Owning identity (schema v7), lifted out of the embedded engine payload so
   * attempts can be selected, re-keyed by a merge and cleaned up by owner. The
   * primary key stays the globally-unique attempt `id` — server idempotency
   * depends on it, so an import never changes it (§10).
   */
  ownerKey: OwnerKey;
  componentKey: string;
  sessionId: string;
  attemptedAt: number;
  /**
   * The full engine attempt payload (Phase 8+), stored so scheduling events can
   * be (re)derived, an attempt undone, and — later — the attempt synced. Added
   * additively over the Phase-5 store contract: the indexed fields above are
   * unchanged, so no schema-version bump or index change is needed. Optional so
   * any pre-Phase-8 rows (there are none in practice) remain readable.
   */
  attempt?: AttemptRecord;
};

/**
 * A stored review event. `syncStatus` is the LOCAL sync lifecycle; the Phase-7
 * scheduler fields (added additively, no index change) capture the causal
 * lineage + rating + event lifecycle `status` + immutable event-time dates that
 * `modules/scheduler` produces (`ReviewEvent`). Optional until first written.
 */
export type ReviewEventRecord = {
  eventId: string;
  componentKey: string;
  /**
   * Owning identity (schema v7). Stamped from the linked attempt's owner at
   * write time so scheduling selection and chain reads scope to the active
   * identity and an account event never parents a guest event. The primary key
   * stays the globally-unique `eventId` — server idempotency and the imported
   * chain's internal lineage both depend on it (§9.4, §10).
   */
  ownerKey: OwnerKey;
  /** Head of the local causal chain (null for a chain root). */
  parentEventId: string | null;
  clientComponentRevision: number;
  syncStatus: "local" | "pushed" | "accepted" | "demoted" | "rejected";
  createdAt: number;
  attemptId?: string;
  rating?: "again" | "hard" | "good" | "easy";
  status?:
    | "scheduling"
    | "reinforcement"
    | "conflict_demoted"
    | "revoked"
    | "pending_parent";
  baseServerRevision?: number;
  clientSequence?: number;
  occurredAtClient?: string;
  deviceId?: string;
  sessionId?: string;
  releaseId?: string;
  contentVersion?: string;
  timezoneAtEvent?: string;
  utcOffsetMinutesAtEvent?: number;
  localDateAtEvent?: string;
  timezoneSource?: "browser_detected" | "user_setting" | "server_fallback";
};

export type StudySessionRecord = {
  id: string;
  /** Owning identity (schema v7); the primary key stays the session uuid. */
  ownerKey: OwnerKey;
  startedAt: number;
};

/**
 * One derived local-date activity row (Phase 12 §14, DATA_MODEL.md §7). A
 * REBUILDABLE cache over `study_attempts` + `review_events` — never learner
 * truth in its own right: the dashboard rebuilds it atomically from the raw
 * stores (modules/analytics/persistence.ts) and a deleted or corrupted cache
 * loses nothing.
 */
export type DailyActivityRecord = {
  /**
   * Owner half of the compound primary key `[ownerKey+localDate]` (schema v7):
   * a guest's and an account's activity for the same calendar day are different
   * rows, where before one silently overwrote the other.
   */
  ownerKey: OwnerKey;
  /** "YYYY-MM-DD" — the immutable stored event-time local date. */
  localDate: string;
  attempts: number;
  reviews: number;
  newItems: number;
  studyMs: number;
  /** When this row was derived (epoch ms; injected by the rebuilder). */
  derivedAt: number;
};

/**
 * The single source of truth for the set of known mutation kinds. The
 * `MutationQueueKind` union is DERIVED from this array (below), so adding a kind
 * in one place keeps the union, the runtime narrowing and any exhaustive record
 * in lock-step — neither direction can drift.
 */
export const MUTATION_QUEUE_KINDS = [
  "revocation",
  "bookmark",
  "list",
  "setting",
  "reinforcement",
] as const;

/** The Phase-16 outbound mutation categories carried by the queue (§9.1). */
export type MutationQueueKind = (typeof MUTATION_QUEUE_KINDS)[number];

/**
 * Narrow a stored `MutationQueueRecord.type` (kept a broad `string` so a legacy
 * or generic-mechanics row still type-checks) to a known `MutationQueueKind`, or
 * null if it is off-contract. The one sanctioned narrowing lives here with the
 * schema owner so consumers never re-derive it with unsafe casts.
 */
export function asMutationQueueKind(type: string): MutationQueueKind | null {
  return (MUTATION_QUEUE_KINDS as readonly string[]).includes(type)
    ? (type as MutationQueueKind)
    : null;
}

/**
 * Outbound-queue lifecycle (Phase 16 §19, OFFLINE_AND_SYNC §4). `local` = not
 * yet accepted (selected + retried on every flush); `pushed` = held server-side
 * (recoverable), resolved by a later push/pull; `dead` = a permanent (non-
 * recoverable) rejection moved to the dead-letter state — retained and surfaced,
 * never silently dropped. An absent `status` on a legacy row is read as `local`.
 */
export type MutationQueueStatus = "local" | "pushed" | "dead";

export type MutationQueueRecord = {
  /** Auto-incremented outbound order; assigned by Dexie on add. */
  seq?: number;
  idempotencyKey: string;
  type: string;
  payload: unknown;
  createdAt: number;
  /**
   * Phase-16 sync-outbox fields. Optional so a pre-Phase-16 row (the store has
   * existed, unused, since v2) still type-checks and is safely treated as an
   * un-owned `local` row. `enqueueMutation` always writes them explicitly.
   */
  /** Owning account (`attempt.userId` semantics); null/undefined = not account-owned, never selected for sync. */
  userId?: string | null;
  /** Stable per-target key (the server itemId) for latest-state-wins coalescing and result matching. */
  target?: string;
  /** Sync lifecycle; absent = `local`. */
  status?: MutationQueueStatus;
  /** Push attempts so far (retry/backoff accounting). */
  attempts?: number;
  /** Last rejection reason code, for the dead-letter surface. */
  lastReason?: string | null;
};

/**
 * Online-sync client state (schema v4, Phase 16). A single row keyed "account"
 * persisting the account this device last synced as, the account-wide pull
 * cursor (`serverCursor`), and the last successful sync time. The `userId` is
 * how the client detects an account switch / logout and invalidates the prior
 * user's sync context (§18) — a mismatch means the stored cursor is not ours.
 */
export type SyncStateRecord = {
  key: "account";
  /** The signed-in account this cursor belongs to; null when signed out. */
  userId: string | null;
  /** The account-wide pull cursor last reconciled (0 = never / bootstrap). */
  serverCursor: number;
  /** Last successful push+pull completion (epoch ms), or null. */
  lastSyncAt: number | null;
};

/**
 * The v7 data-moving upgrade (Phase 17 §10). IndexedDB cannot change an
 * existing store's key path, and Dexie refuses it outright ("UpgradeError: Not
 * yet support for changing primary key"), so the four stores whose identity
 * gains the owner are RECREATED under new physical names and their rows copied
 * across in this upgrade function; v8 then drops the originals. (Deleting them
 * in v7 is impossible: a version's schema changes are applied BEFORE its upgrade
 * function runs, so the source rows would already be gone.) An error anywhere in
 * the sequence rolls the whole version-change transaction back, so the database
 * either fully migrates or stays exactly as it was.
 */
async function upgradeToOwnerKeyedStores(tx: Transaction): Promise<void> {
  /**
   * Read one store in bounded BATCHES, in primary-key order, handing each batch
   * to `onBatch`. A years-long learner history can hold tens of thousands of
   * attempts and events, and this runs inside the one version-change transaction
   * that blocks every other connection to the database, so neither the rows nor
   * their mapped copies may be held in memory all at once. Paging by key range
   * (rather than `offset`) keeps the whole pass linear: each batch resumes from
   * the last key instead of re-walking the rows already migrated.
   */
  async function forEachBatch<Row>(
    name: string,
    /** The row's primary-key value — every migrated store has an INBOUND key. */
    keyOf: (row: Row) => string | number,
    onBatch: (rows: Row[]) => Promise<void>,
  ): Promise<void> {
    const table = tx.table(name);
    let after: string | number | undefined;
    for (;;) {
      const collection =
        after === undefined
          ? table.orderBy(":id")
          : table.where(":id").above(after);
      const rows = (await collection
        .limit(MIGRATION_BATCH_SIZE)
        .toArray()) as Row[];
      if (rows.length === 0) return;
      await onBatch(rows);
      if (rows.length < MIGRATION_BATCH_SIZE) return;
      after = keyOf(rows[rows.length - 1]);
    }
  }

  /** Copy every row of `from` into `to`, mapped by `map`, batch by batch. */
  async function copyStore<Source, Target>(
    from: string,
    to: string,
    keyOf: (row: Source) => string | number,
    map: (row: Source) => Target,
  ): Promise<void> {
    await forEachBatch<Source>(from, keyOf, async (rows) => {
      await tx.table(to).bulkPut(rows.map(map));
    });
  }

  /** Rewrite every row of a store IN PLACE (same primary key, new owner field). */
  async function rewriteStore<Row>(
    name: string,
    keyOf: (row: Row) => string | number,
    map: (row: Row) => Row,
  ): Promise<void> {
    await forEachBatch<Row>(name, keyOf, async (rows) => {
      await tx.table(name).bulkPut(rows.map(map));
    });
  }

  // A v6 row carries the owner in `userId` (null/absent = guest); a pre-v6 row
  // has no owner field at all and is likewise a guest's. `ownerKeyFromLegacyUserId`
  // owns that rule (§10 "existing pre-v6 rows with absent owner are treated as
  // guest rows"), and `userId` is dropped so only one owner field survives.
  const ownerOf = (row: { userId?: string | null }): OwnerKey =>
    ownerKeyFromLegacyUserId(row.userId);

  await copyStore<LegacyOwnedRow & Record<string, unknown>, unknown>(
    "study_components",
    OWNED_STORE_NAMES.studyComponents,
    (row) => row.componentKey as string,
    ({ userId: _userId, ...rest }) => ({
      ...rest,
      ownerKey: ownerOf({ userId: _userId }),
    }),
  );
  await copyStore<LegacyOwnedRow & Record<string, unknown>, unknown>(
    "bookmarks",
    OWNED_STORE_NAMES.bookmarks,
    (row) => row.entryId as number,
    ({ userId: _userId, ...rest }) => ({
      ...rest,
      ownerKey: ownerOf({ userId: _userId }),
    }),
  );
  await copyStore<LegacyOwnedRow & Record<string, unknown>, unknown>(
    "settings",
    OWNED_STORE_NAMES.settings,
    (row) => row.key as string,
    ({ userId: _userId, ...rest }) => ({
      ...rest,
      ownerKey: ownerOf({ userId: _userId }),
    }),
  );
  // `daily_activity` is deliberately NOT copied. It is a DERIVED cache (§10 "the
  // derived daily_activity cache may be rebuilt rather than treated as
  // authoritative") whose pre-v7 rows carry no owner at all, so attributing them
  // to any identity would be a guess. Dropping them loses nothing: the next
  // analytics read rebuilds the cache from the raw attempts/events it owns.

  // Stores whose primary key already is globally unique keep it and are only
  // re-stamped in place.
  await rewriteStore<LegacyOwnedRow & Record<string, unknown>>(
    "lists",
    (row) => row.id as string,
    ({ userId: _userId, ...rest }) => ({
      ...rest,
      ownerKey: ownerOf({ userId: _userId }),
    }),
  );
  await rewriteStore<LegacyOwnedRow & Record<string, unknown>>(
    "review_events",
    (row) => row.eventId as string,
    ({ userId: _userId, ...rest }) => ({
      ...rest,
      ownerKey: ownerOf({ userId: _userId }),
    }),
  );

  // An attempt's owner lived INSIDE its engine payload (`attempt.userId`), which
  // stays where it is — it is part of the immutable attempt record the sync wire
  // is built from. The owner is lifted to an indexed top-level `ownerKey` so
  // attempts can be selected, re-keyed and cleaned up by owner like every other
  // private store.
  //
  // Sessions never stored an owner at all, so the same pass records which
  // identity each session's attempts belonged to (a session belongs to whoever
  // was studying). Only that small session→owner map is retained across
  // batches; the attempt rows themselves are released after each batch.
  const ownerBySession = new Map<string, OwnerKey>();
  await forEachBatch<
    StudyAttemptRecord & { attempt?: { userId?: string | null } }
  >(
    "study_attempts",
    (row) => row.id,
    async (rows) => {
      await tx.table("study_attempts").bulkPut(
        rows.map((row) => {
          const ownerKey = ownerKeyFromLegacyUserId(row.attempt?.userId);
          if (typeof row.sessionId === "string") {
            ownerBySession.set(row.sessionId, ownerKey);
          }
          return { ...row, ownerKey };
        }),
      );
    },
  );
  // A session with no surviving attempt is the guest's — the same default
  // every other ownerless row takes.
  await rewriteStore<StudySessionRecord>(
    "sessions",
    (row) => row.id,
    (row) => ({
      ...row,
      ownerKey: ownerBySession.get(row.id) ?? GUEST_OWNER_KEY,
    }),
  );
}

export class SafwaDb extends Dexie {
  contentReleases!: EntityTable<ContentReleaseRecord, "releaseId">;
  contentEntries!: EntityTable<ContentEntryRecord, "releaseId">;
  contentMetadata!: EntityTable<ContentMetadataRecord, "key">;
  /** Owner-keyed (schema v7): the primary key is `[ownerKey+componentKey]`. */
  studyComponents!: Table<StudyComponentRecord, [OwnerKey, string]>;
  studyAttempts!: EntityTable<StudyAttemptRecord, "id">;
  reviewEvents!: EntityTable<ReviewEventRecord, "eventId">;
  /** Owner-keyed (schema v7): the primary key is `[ownerKey+localDate]`. */
  dailyActivity!: Table<DailyActivityRecord, [OwnerKey, string]>;
  sessions!: EntityTable<StudySessionRecord, "id">;
  /** Owner-keyed (schema v7): the primary key is `[ownerKey+entryId]`. */
  bookmarks!: Table<BookmarkRecord, [OwnerKey, number]>;
  lists!: EntityTable<CustomListRecord, "id">;
  /** Owner-keyed (schema v7): the primary key is `[ownerKey+key]`. */
  settings!: Table<SettingRecord, [OwnerKey, string]>;
  mutationQueue!: EntityTable<MutationQueueRecord, "seq">;
  profile!: EntityTable<DeviceProfileRecord, "key">;
  syncState!: EntityTable<SyncStateRecord, "key">;

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
    // v3 (Phase 12): the daily_activity DERIVED cache, keyed by the stored
    // event-time local date. Purely additive — every earlier store and its
    // data carry forward untouched, no upgrade function needed.
    this.version(3).stores({
      daily_activity: "localDate",
    });
    // v4 (Phase 16): the online-sync client state (single "account" row).
    // Purely additive — no upgrade function needed.
    this.version(4).stores({
      sync_state: "key",
    });
    // v5 (Phase 16): the mutation_queue becomes the live sync outbox for
    // bookmarks/lists/settings/revocations/reinforcement (§9.1, EXT-F2). This
    // only ADDS indexes to the existing store so the account-scoped selector,
    // ack and status-badge counts can narrow the cursor to the caller's own
    // account + lifecycle instead of scanning the whole table: the compound
    // `[userId+status]` drives the hot pending/dead-letter counts and the push
    // selection, and `[type+userId+target]` drives the coalesce lookup. The
    // primary key and unique idempotencyKey are unchanged, existing rows are
    // re-indexed in place, and no data-moving upgrade function is needed.
    this.version(5).stores({
      mutation_queue:
        "++seq, &idempotencyKey, type, userId, status, [userId+status], [type+userId+target]",
    });
    // v6 (Phase 16, R2-F3): add a local OWNER (`userId`, null = guest) plus
    // owner-scoped compound indexes to the private learner-state stores, so a
    // signed-in account's reads/selection/writes never touch a guest's (or
    // another account's) rows sharing the same natural key. Additive: each
    // store's PRIMARY KEY is unchanged (existing rows keep their identity and
    // are re-indexed in place with an absent `userId`, read as guest); only new
    // indexes are added, so no data-moving upgrade function is needed.
    //   - review_events   `[userId+syncStatus]` drives the owner-scoped push
    //     selection + pending count (no starvation by a guest backlog);
    //     `[userId+componentKey]` scopes the causal-chain read so an account
    //     event never parents a guest event.
    //   - study_components `[userId+componentKey]` scopes the projected card.
    //   - bookmarks        `[userId+entryId]` scopes the per-entry lookup.
    //   - settings         `[userId+key]` scopes account-syncable settings.
    //   - lists            `userId` scopes the (uuid-keyed) list rows.
    this.version(6).stores({
      study_components: "componentKey, entryId, userId, [userId+componentKey]",
      review_events:
        "eventId, componentKey, parentEventId, syncStatus, userId, [userId+syncStatus], [userId+componentKey]",
      bookmarks: "entryId, createdAt, userId, [userId+entryId]",
      lists: "id, name, userId",
      settings: "key, userId, [userId+key]",
    });
    // v7 (Phase 17 §10): the OWNER becomes part of the row's IDENTITY, so a
    // guest's and an account's rows for the same natural key can coexist instead
    // of one physically replacing the other (the Phase 16 limitation §10 names).
    //
    // The four stores whose logical key collides across owners get a compound
    // `[ownerKey+naturalKey]` primary key. That is a key-path change, which
    // IndexedDB cannot do in place, so each is created as a NEW store here and
    // its rows are copied by `upgradeToOwnerKeyedStores`; v8 then drops the
    // originals (see that function's comment for why the drop cannot happen in
    // this same version). The stores whose primary key is already globally
    // unique — review_events/study_attempts/sessions by uuid, lists by uuidv7 —
    // keep it and only gain the indexed `ownerKey` column, so no imported
    // attempt/event id ever changes (§10 "do not change globally unique
    // attempt/event ids unnecessarily; preserve original ids used by server
    // idempotency").
    //
    // Every owner-scoped read now narrows on an INDEXED, non-null owner key, so
    // the v6-era "IndexedDB cannot index null, so guests must scan" split is
    // gone: guest reads are indexed exactly like an account's.
    this.version(7)
      .stores({
        [OWNED_STORE_NAMES.studyComponents]:
          "[ownerKey+componentKey], ownerKey, componentKey, entryId, [ownerKey+entryId]",
        [OWNED_STORE_NAMES.bookmarks]:
          "[ownerKey+entryId], ownerKey, entryId, createdAt",
        [OWNED_STORE_NAMES.settings]: "[ownerKey+key], ownerKey, key",
        [OWNED_STORE_NAMES.dailyActivity]:
          "[ownerKey+localDate], ownerKey, localDate",
        study_attempts:
          "id, componentKey, sessionId, attemptedAt, ownerKey, [ownerKey+componentKey]",
        review_events:
          "eventId, componentKey, parentEventId, syncStatus, ownerKey, [ownerKey+syncStatus], [ownerKey+componentKey]",
        sessions: "id, startedAt, ownerKey",
        lists: "id, name, ownerKey",
      })
      .upgrade(upgradeToOwnerKeyedStores);
    // v8 (Phase 17 §10): drop the four superseded stores now that v7 has copied
    // their rows. Separate version because a version's schema changes are
    // applied BEFORE its own upgrade function runs — deleting them in v7 would
    // destroy the source rows before they could be copied.
    this.version(SAFWA_DB_VERSION).stores({
      study_components: null,
      bookmarks: null,
      settings: null,
      daily_activity: null,
    });
    // Code-facing accessors stay camelCase per TS convention; the mapping
    // to the physical stores lives here and nowhere else.
    this.studyComponents = this.table(OWNED_STORE_NAMES.studyComponents);
    this.studyAttempts = this.table("study_attempts");
    this.reviewEvents = this.table("review_events");
    this.dailyActivity = this.table(OWNED_STORE_NAMES.dailyActivity);
    this.bookmarks = this.table(OWNED_STORE_NAMES.bookmarks);
    this.settings = this.table(OWNED_STORE_NAMES.settings);
    this.mutationQueue = this.table("mutation_queue");
    this.syncState = this.table("sync_state");
  }
}

/**
 * The private, OWNER-SCOPED stores: every row in them carries an `ownerKey` and
 * belongs to exactly one identity (a guest or one account). SINGLE SOURCE OF
 * TRUTH for this security-relevant grouping (the schema owner owns it) — the
 * scoped sign-out / account-switch cleanup (phases-17.md §11) and the
 * guest-merge re-keying both iterate exactly this set, so a NEW private store
 * must be classified here or it silently escapes both.
 */
export function ownerScopedTables(
  db: SafwaDb,
): Table<{ ownerKey: OwnerKey }>[] {
  return [
    db.studyComponents,
    db.studyAttempts,
    db.reviewEvents,
    db.dailyActivity,
    db.sessions,
    db.bookmarks,
    db.lists,
    db.settings,
  ] as unknown as Table<{ ownerKey: OwnerKey }>[];
}

/**
 * Every store whose contents belong to an account rather than the device: the
 * owner-scoped private stores plus the outbound queue and the sync cursor
 * (which carry their own account `userId` rather than an owner key). A NEW
 * account-owned store MUST be classified here — the `accountScopedTables +
 * deviceAndContentTables === all tables` coverage test fails otherwise, turning
 * silent drift (a stale store leaking across accounts) into a build signal.
 */
export function accountScopedTables(db: SafwaDb): Table[] {
  return [
    ...ownerScopedTables(db),
    db.mutationQueue,
    db.syncState,
  ] as unknown as Table[];
}

/**
 * The device / shared-content stores PRESERVED across a logout: the anonymous
 * device profile (device identity, not account data) and the immutable,
 * hash-verified content cache. The complement of `accountScopedTables`.
 */
export function deviceAndContentTables(db: SafwaDb): Table[] {
  return [
    db.profile,
    db.contentReleases,
    db.contentEntries,
    db.contentMetadata,
  ] as unknown as Table[];
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
