/**
 * Phase 16 — client sync outbox for the non-scheduling mutation categories
 * (§9.1, §19, OFFLINE_AND_SYNC §4, EXT-F2). Scheduling events carry their own
 * lifecycle on `review_events.syncStatus`; every OTHER outbound mutation —
 * revocations, bookmark upserts/deletes, list snapshots/deletes, setting
 * updates and reinforcement-only attempts — is durably captured here in the
 * Dexie `mutation_queue` so it survives the source row being deleted (a delete
 * cannot be reconstructed from local state) and is retried until the server
 * acknowledges it.
 *
 * OWNERSHIP (§18, EXT-F1). Every queued row records the account that owns it
 * (`userId`, the same `attempt.userId` semantics used for scheduling). The
 * selector sends ONLY the active account's own rows; a guest's rows (enqueued
 * with a null owner, or never enqueued while signed out) and any other account's
 * leftover rows are never uploaded — logging in never implies a merge. The whole
 * queue is account-scoped and wiped on logout with the other private stores.
 *
 * COALESCING. Bookmarks, lists and settings are latest-state-wins: enqueuing a
 * new mutation for a target (`entryId` / list id / setting key) supersedes any
 * still-unsent (`local`) mutation for that same target, bounding the queue.
 * Revocations and reinforcement attempts are append-only and de-duplicated by
 * idempotency key.
 *
 * DEAD-LETTER (OFFLINE_AND_SYNC §4). A recoverable rejection stays `local` and
 * is retried; a permanent (non-recoverable) rejection is moved to `dead` and
 * retained (surfaced, never silently dropped). Browser-only (Dexie); the wire
 * mapping/validation itself is pure.
 *
 * LOGOUT DATA-LOSS TRADE-OFF (§18, SEC-002-T15d). The queue is one of the
 * account-scoped stores wiped on logout/account-switch so a shared device never
 * leaks one account's changes to the next. A consequence, accepted for Stage A:
 * a still-`local` mutation not yet pushed at logout is discarded together with
 * its source row — there is no server copy to re-pull. This matches the
 * server-authoritative re-pull model (the next sign-in bootstraps authoritative
 * state); a pre-logout flush/warning gate is out of scope for Stage A and would
 * conflict with logging out while offline.
 *
 * QUEUE GROWTH (OFFLINE_AND_SYNC §4). Coalesced kinds are bounded per target;
 * append-only kinds (revocation/reinforcement) accumulate while offline and are
 * drained (acked + removed) on the next successful push, so the backlog is
 * bounded by the offline gap, as the mutation-queue design intends.
 */
import { uuidv7 } from "@/lib/uuid";
import {
  asMutationQueueKind,
  type MutationQueueKind,
  type MutationQueueRecord,
  type SafwaDb,
} from "@/modules/content/db";
import {
  isRecoverableReason,
  SYNC_BOUNDS,
  wireAttemptSchema,
  wireBookmarkSchema,
  wireListSchema,
  wireRevocationSchema,
  wireSettingSchema,
  type SyncItemResult,
  type WireAttempt,
  type WireBookmark,
  type WireList,
  type WireRevocation,
  type WireSetting,
} from "@/modules/sync/protocol";

/** The wire arrays the orchestrator sends for the queued categories. */
export type QueuedMutations = {
  revocations: WireRevocation[];
  bookmarks: WireBookmark[];
  lists: WireList[];
  settings: WireSetting[];
  /** Reinforcement-only attempts — merged into the push request's `attempts`. */
  reinforcementAttempts: WireAttempt[];
};

/** The server `itemKind` a queued row's push result carries. */
function resultKindFor(type: string): SyncItemResult["itemKind"] | null {
  switch (type) {
    case "revocation":
      return "revocation";
    case "bookmark":
      return "bookmark";
    case "list":
      return "list";
    case "setting":
      return "setting";
    // A reinforcement-only attempt is graded/persisted as an `attempt` item.
    case "reinforcement":
      return "attempt";
    default:
      return null;
  }
}

type EnqueueParams = {
  db: SafwaDb;
  userId: string;
  type: MutationQueueKind;
  /** Server itemId for this mutation — used for coalescing and result matching. */
  target: string;
  payload: unknown;
  /** Unique local row id; append-only kinds pass a natural key to de-dupe. */
  idempotencyKey: string;
  now: number;
  /** Latest-state-wins (bookmark/list/setting) vs append-only (revocation/reinforcement). */
  coalesce: boolean;
};

/**
 * Enqueue one outbound mutation. Runs in the ambient Dexie transaction when the
 * caller already opened one over `mutation_queue` (so the enqueue commits
 * atomically with the local write), else in its own. Coalescing removes any
 * still-`local` row for the same target; append-only kinds are de-duplicated by
 * `idempotencyKey`.
 */
async function enqueue(params: EnqueueParams): Promise<void> {
  const { db, type, target, userId, coalesce } = params;
  const run = async () => {
    if (coalesce) {
      // Direct compound-index lookup for this exact target (not a full scan);
      // supersede only the still-`local` rows, leaving pushed/dead ones intact.
      const sameTarget = await db.mutationQueue
        .where("[type+userId+target]")
        .equals([type, userId, target])
        .toArray();
      for (const row of sameTarget) {
        if (row.seq !== undefined && (row.status ?? "local") === "local") {
          await db.mutationQueue.delete(row.seq);
        }
      }
    } else {
      const existing = await db.mutationQueue
        .where("idempotencyKey")
        .equals(params.idempotencyKey)
        .first();
      if (existing) return; // already queued — idempotent enqueue
    }
    const record: MutationQueueRecord = {
      idempotencyKey: params.idempotencyKey,
      type,
      target,
      userId,
      status: "local",
      attempts: 0,
      payload: params.payload,
      createdAt: params.now,
      lastReason: null,
    };
    await db.mutationQueue.add(record);
  };
  // Dexie nests this as a sub-transaction when the caller already holds a
  // transaction whose scope includes `mutation_queue` (so the enqueue commits
  // atomically with the local write); otherwise it runs standalone.
  return db.transaction("rw", [db.mutationQueue], run);
}

/** Enqueue a bookmark upsert/delete (latest-state-wins on `entryId`). */
export async function enqueueBookmarkMutation(
  db: SafwaDb,
  params: {
    userId: string;
    entryId: number;
    createdAt: number;
    deleted: boolean;
    now: number;
  },
): Promise<void> {
  const payload: WireBookmark = {
    entryId: params.entryId,
    createdAt: params.createdAt,
    deleted: params.deleted,
  };
  await enqueue({
    db,
    userId: params.userId,
    type: "bookmark",
    target: String(params.entryId),
    payload,
    idempotencyKey: uuidv7(params.now),
    now: params.now,
    coalesce: true,
  });
}

/** Enqueue a list snapshot upsert/delete (latest-state-wins on list id). */
export async function enqueueListMutation(
  db: SafwaDb,
  params: {
    userId: string;
    list: {
      id: string;
      name: string;
      entryIds: readonly number[];
      createdAt: number;
      updatedAt: number;
    };
    deleted: boolean;
    now: number;
  },
): Promise<void> {
  const payload: WireList = {
    id: params.list.id,
    name: params.list.name,
    entryIds: [...params.list.entryIds],
    createdAt: params.list.createdAt,
    updatedAt: params.list.updatedAt,
    deleted: params.deleted,
  };
  await enqueue({
    db,
    userId: params.userId,
    type: "list",
    target: params.list.id,
    payload,
    idempotencyKey: uuidv7(params.now),
    now: params.now,
    coalesce: true,
  });
}

/**
 * Enqueue a setting update (latest-state-wins on the SERVER key). The caller
 * maps the local key/value to the server-syncable key/value first; an unsyncable
 * key must never reach here.
 */
export async function enqueueSettingMutation(
  db: SafwaDb,
  params: {
    userId: string;
    key: string;
    value: unknown;
    updatedAt: number;
    now: number;
  },
): Promise<void> {
  const payload: WireSetting = {
    key: params.key,
    value: params.value,
    updatedAt: params.updatedAt,
  };
  await enqueue({
    db,
    userId: params.userId,
    type: "setting",
    target: params.key,
    payload,
    idempotencyKey: uuidv7(params.now),
    now: params.now,
    coalesce: true,
  });
}

/** Enqueue a post-sync undo revocation (append-only; de-duped by revocationId). */
export async function enqueueRevocationMutation(
  db: SafwaDb,
  params: { userId: string; revocation: WireRevocation; now: number },
): Promise<void> {
  await enqueue({
    db,
    userId: params.userId,
    type: "revocation",
    target: params.revocation.revocationId,
    payload: params.revocation,
    // The revocationId is itself a unique UUID — reuse it so a double undo of
    // the same event can never enqueue two revocations.
    idempotencyKey: params.revocation.revocationId,
    now: params.now,
    coalesce: false,
  });
}

/** Enqueue a reinforcement-only attempt (append-only; de-duped by attempt id). */
export async function enqueueReinforcementMutation(
  db: SafwaDb,
  params: { userId: string; attempt: WireAttempt; now: number },
): Promise<void> {
  await enqueue({
    db,
    userId: params.userId,
    type: "reinforcement",
    target: params.attempt.id,
    payload: params.attempt,
    idempotencyKey: `reinforcement:${params.attempt.id}`,
    now: params.now,
    coalesce: false,
  });
}

/** The wire schema each queued kind's payload must satisfy before it is sent. */
const PAYLOAD_SCHEMAS = {
  revocation: wireRevocationSchema,
  bookmark: wireBookmarkSchema,
  list: wireListSchema,
  setting: wireSettingSchema,
  reinforcement: wireAttemptSchema,
} as const;

/**
 * Select the active account's unsent mutations, bucketed per category and
 * bounded by the wire caps, each payload re-validated against its wire schema
 * (an invalid row is DROPPED, never sent — one malformed local row must never
 * break a whole push). Rows are taken in `seq` (FIFO) order.
 */
export async function selectQueuedMutations(
  db: SafwaDb,
  userId: string,
): Promise<QueuedMutations> {
  // Compound-index scan of ONLY this account's still-`local` rows, then FIFO
  // order by seq (the index does not preserve insertion order).
  const rows = await db.mutationQueue
    .where("[userId+status]")
    .equals([userId, "local"])
    .toArray();
  rows.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const out: QueuedMutations = {
    revocations: [],
    bookmarks: [],
    lists: [],
    settings: [],
    reinforcementAttempts: [],
  };
  const caps = {
    revocation: SYNC_BOUNDS.maxRevocations,
    bookmark: SYNC_BOUNDS.maxBookmarks,
    list: SYNC_BOUNDS.maxLists,
    setting: SYNC_BOUNDS.maxSettings,
    reinforcement: SYNC_BOUNDS.maxAttempts,
  } as const;
  for (const row of rows) {
    const kind = asMutationQueueKind(row.type);
    if (!kind) continue;
    const parsed = PAYLOAD_SCHEMAS[kind].safeParse(row.payload);
    if (!parsed.success) continue;
    switch (kind) {
      case "revocation":
        if (out.revocations.length < caps.revocation)
          out.revocations.push(parsed.data as WireRevocation);
        break;
      case "bookmark":
        if (out.bookmarks.length < caps.bookmark)
          out.bookmarks.push(parsed.data as WireBookmark);
        break;
      case "list":
        if (out.lists.length < caps.list)
          out.lists.push(parsed.data as WireList);
        break;
      case "setting":
        if (out.settings.length < caps.setting)
          out.settings.push(parsed.data as WireSetting);
        break;
      case "reinforcement":
        if (out.reinforcementAttempts.length < caps.reinforcement)
          out.reinforcementAttempts.push(parsed.data as WireAttempt);
        break;
    }
  }
  return out;
}

/** The lifecycle transition a push result implies for a queued row. */
type QueueAck =
  | { kind: "delete" }
  | { kind: "status"; status: "pushed" | "dead"; reason: string };

function ackForResult(result: SyncItemResult): QueueAck | null {
  switch (result.status) {
    case "accepted":
    case "corrected":
    case "duplicate":
      // Applied to authoritative state — the queued mutation is done.
      return { kind: "delete" };
    case "pending":
      return { kind: "status", status: "pushed", reason: result.reasonCode };
    case "rejected":
      // A recoverable rejection stays `local` and is retried on the next flush;
      // a permanent one is dead-lettered (retained, surfaced, never dropped).
      return isRecoverableReason(result.reasonCode)
        ? null
        : { kind: "status", status: "dead", reason: result.reasonCode };
    default:
      return null;
  }
}

/**
 * Apply push results to the ACTIVE ACCOUNT's queued mutations. Matches each
 * result to its row by (itemKind, itemId=target), scoped to `userId` so a target
 * shared across accounts (e.g. both bookmarked entry 5) can never cross-ack.
 * Runs in one Dexie transaction. Returns the number of rows changed.
 * Event/attempt-for-scheduling results are handled elsewhere; only the queued
 * categories are touched here.
 */
export async function applyQueueResults(
  db: SafwaDb,
  userId: string,
  results: readonly SyncItemResult[],
): Promise<number> {
  const relevant = results.filter((r) =>
    (
      ["revocation", "bookmark", "list", "setting", "attempt"] as const
    ).includes(
      r.itemKind as "revocation" | "bookmark" | "list" | "setting" | "attempt",
    ),
  );
  if (relevant.length === 0) return 0;

  return db.transaction("rw", [db.mutationQueue], async () => {
    let changed = 0;
    // Only this account's still-ackable rows (local/pushed) are candidates.
    const rows = await db.mutationQueue
      .where("[userId+status]")
      .anyOf([
        [userId, "local"],
        [userId, "pushed"],
      ])
      .toArray();
    for (const result of relevant) {
      const row = rows.find(
        (r) =>
          r.seq !== undefined &&
          resultKindFor(r.type) === result.itemKind &&
          r.target === result.itemId,
      );
      if (!row || row.seq === undefined) continue;
      const ack = ackForResult(result);
      if (ack === null) {
        // Recoverable rejection — leave `local`, count the attempt for backoff.
        await db.mutationQueue.update(row.seq, {
          attempts: (row.attempts ?? 0) + 1,
          lastReason: result.reasonCode,
        });
        changed++;
        continue;
      }
      if (ack.kind === "delete") {
        await db.mutationQueue.delete(row.seq);
      } else {
        await db.mutationQueue.update(row.seq, {
          status: ack.status,
          attempts: (row.attempts ?? 0) + 1,
          lastReason: ack.reason,
        });
      }
      changed++;
    }
    return changed;
  });
}

/**
 * Count the active account's outstanding queued mutations — rows OWNED by
 * `userId` that are not dead-lettered (`local` or `pushed`). This is folded into
 * the "pending changes" number the status indicator surfaces (§20) alongside
 * the scheduling backlog, so bookmarks/lists/settings/revocations/reinforcement
 * count too (EXT-F2). Dead-lettered rows are excluded from the pending count and
 * surfaced separately as needing attention.
 */
export async function countPendingMutations(
  db: SafwaDb,
  userId: string,
): Promise<number> {
  // Indexed `.count()` over just this account's outstanding rows — no rows are
  // materialised, so the hot status-badge poll scales with the account's own
  // pending set, not the whole table.
  return db.mutationQueue
    .where("[userId+status]")
    .anyOf([
      [userId, "local"],
      [userId, "pushed"],
    ])
    .count();
}

/** Count the active account's dead-lettered mutations (permanent rejections). */
export async function countDeadLetterMutations(
  db: SafwaDb,
  userId: string,
): Promise<number> {
  return db.mutationQueue
    .where("[userId+status]")
    .equals([userId, "dead"])
    .count();
}
