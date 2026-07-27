/**
 * Phase 17 §13 — the guest→account MERGE wire protocol.
 *
 * A merge is not a push. A push is one shot: whatever fits in a batch, applied
 * and forgotten. A merge is a whole history moving under a single identity that
 * has to survive being interrupted, so it is STAGED — `begin`, then as many
 * `chunk`s as the history needs, then `finalize` — with every stage naming the
 * same import key and snapshot hash. That is what makes "the same import key
 * with the same snapshot is a no-op after success" and "materially different
 * content fails safely as a payload conflict" (§12) enforceable server-side
 * rather than hoped for.
 *
 * ONE ROUTE, three stages, discriminated on `stage`. Three sibling routes would
 * mean three places to remember the auth guard, the body-size limit, the
 * feature flag and the rate limit; one union means the route handler cannot
 * parse a request at all without having decided which stage it is, and a stage
 * added later cannot skip a guard by omission.
 *
 * WHAT IS REUSED, DELIBERATELY (§13 "reuse current Phase 16 modules, do not
 * duplicate"): the item shapes (`wireAttemptSchema`, `wireEventSchema`,
 * `wireBookmarkSchema`, `wireListSchema`, `wireSettingSchema`), the per-item
 * result shape (`syncItemResultSchema`) and its reason-code vocabulary, and the
 * per-kind/total item bounds. A merged attempt and a synced attempt are the same
 * bytes, so the server can regrade both through one validation path — a second
 * item vocabulary would be a second place for the trust boundary to drift.
 *
 * WHAT IS NOT CARRIED: revocations. A guest cannot revoke — revocation is an
 * account-scoped correction that travels through the ordinary queue — so there
 * is no field for one, which is stronger than validating it away (§12 "no dead
 * or unrelated account queue entries").
 *
 * There is deliberately NO client-settable merge flag on the ordinary push
 * endpoint (§13, §30 "no client-accessible merge-mode bypass"). Merge ingestion
 * is reachable only through this protocol, behind the authenticated coordinator.
 *
 * PURE and isomorphic: Zod only, importable from both the browser client and the
 * Node/Postgres server.
 */
import { z } from "zod";

import { SYNC_BOUNDS, SYNC_PROTOCOL_VERSION } from "./constants";
import {
  boundedId,
  shortString,
  syncItemResultSchema,
  uuidSchema,
  wireAttemptSchema,
  wireBookmarkSchema,
  wireEventSchema,
  wireListSchema,
  wireSettingSchema,
} from "./wire";

/** The staged merge's phases, in the only order they may occur. */
export const GUEST_MERGE_STAGES = ["begin", "chunk", "finalize"] as const;
export type GuestMergeStage = (typeof GUEST_MERGE_STAGES)[number];

/**
 * How far an import has got, as the SERVER sees it. Distinct from the client's
 * local `GuestImportStatus`: this is the durable, authoritative state recorded
 * against the import key, and it is what makes a resubmission idempotent.
 *
 * - `open`      — accepted and receiving chunks; resumable.
 * - `completed` — durably applied. Resubmitting the same key + snapshot returns
 *                 the stored result and changes nothing (§12, §15).
 * - `rejected`  — refused; see the reason code. Not retryable as-is.
 */
export const GUEST_IMPORT_SERVER_STATUSES = [
  "open",
  "completed",
  "rejected",
] as const;
export type GuestImportServerStatus =
  (typeof GUEST_IMPORT_SERVER_STATUSES)[number];

/**
 * The FINAL outcome of a merge (§13). `incomplete` is a first-class result, not
 * an error: chunks were applied but finalisation could not conclude, so the
 * client must retry under the SAME key rather than start over — and, critically,
 * must not tell the learner the merge either succeeded or rolled back, because
 * neither is true (§29 "cancellation must not produce false rollback claims").
 */
export const GUEST_MERGE_RESULTS = [
  "applied",
  "no_op",
  "rejected",
  "incomplete",
] as const;
export type GuestMergeResult = (typeof GUEST_MERGE_RESULTS)[number];

/**
 * Import-level reason codes — the only machine-readable failure signals this
 * protocol emits, deliberately enumerated so no raw error, SQL fragment or
 * payload echo can reach the client (§30 "safe generic errors", "no raw
 * payloads in logs"). Item-level failures keep the existing
 * `SYNC_REASON_CODES` vocabulary through `syncItemResultSchema`.
 */
export const GUEST_MERGE_REASON_CODES = [
  "accepted",
  /** The same key + the same snapshot after success: nothing to do (§12). */
  "already_completed",
  /**
   * The key exists but is bound to a DIFFERENT snapshot hash. Refused rather
   * than merged, because treating different data as the same import is exactly
   * the silent corruption the hash exists to prevent (§12, §15).
   */
  "snapshot_mismatch",
  /** A chunk or finalisation arrived for a key that was never begun. */
  "unknown_import",
  /** Finalisation arrived before every declared item had been accepted. */
  "incomplete_upload",
  /** The declared totals exceed what one import may carry. */
  "declared_totals_exceeded",
  /** Chunks arrived out of order or past the declared count. */
  "chunk_out_of_range",
  /**
   * Cumulative custom lists across the import exceeded `maxLists`. Distinct from
   * `declared_totals_exceeded` because it is detected while chunks are arriving,
   * against what has ACTUALLY been accepted, not against what was declared.
   */
  "list_ceiling_exceeded",
  /** The key belongs to another account; never merged across accounts (§15). */
  "cross_account_import",
  /** The merge feature is disabled (`SYNC_ENABLED=false`). */
  "merge_disabled",
  /** The account's email is not verified, so it cannot receive an import. */
  "email_unverified",
  "malformed_request",
  "internal_error",
] as const;
export type GuestMergeReasonCode = (typeof GUEST_MERGE_REASON_CODES)[number];

/**
 * Bounds specific to a merge (§29). The per-chunk caps are the ORDINARY push
 * caps — a merge chunk is exactly as large as a push batch, so one body-size
 * limit and one set of per-kind caps govern both — and `maxChunks` is what turns
 * "as many chunks as the history needs" into a finite number.
 *
 * `maxChunks × maxItemsPerBatch` = 100,000, comfortably above the client's own
 * snapshot ceiling (`GUEST_SNAPSHOT_BOUNDS`, ~50,500 items) so a legitimate
 * history is never refused here, while an unbounded one still is.
 */
export const GUEST_MERGE_BOUNDS = {
  maxChunks: 100,
  maxItemsPerChunk: SYNC_BOUNDS.maxItemsPerBatch,
  maxDeclaredItems: 100 * SYNC_BOUNDS.maxItemsPerBatch,
  /**
   * Custom lists one import may carry in TOTAL, and therefore the most id
   * mappings finalisation can return. `GUEST_SNAPSHOT_BOUNDS.maxLists` derives
   * from this, so the client's own ceiling and the wire's are one number.
   *
   * THIS IS A CUMULATIVE INVARIANT AND THE SCHEMA CANNOT ENFORCE IT. Each chunk
   * is parsed on its own, so the only structural bound on list items is the
   * per-chunk `SYNC_BOUNDS.maxLists`; across `maxChunks` chunks a client that
   * ignores its declaration can still submit far more than this. The coordinator
   * MUST therefore track the running count of accepted lists per import and
   * reject further ones with `list_ceiling_exceeded`.
   *
   * The `.max()` on `listIdMappings` is a BACKSTOP, not that guarantee: it makes
   * a coordinator that failed to enforce the ceiling fail loudly when it tries to
   * serialise the mappings, rather than silently truncating them and orphaning
   * the guest list ids beyond the cap — which would break exactly the re-keying
   * §17 requires.
   */
  maxLists: 500,
} as const;

/** Lowercase hex SHA-256 — the canonical snapshot hash (§12). */
export const snapshotHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "invalid snapshot hash");

/**
 * The import key: a UUID, so it is bounded and unguessable and a malformed or
 * attacker-chosen key is refused here rather than reaching the `guest_imports`
 * unique index as arbitrary text.
 *
 * LOWERCASE ONLY — deliberately stricter than the generic `uuidSchema`, for the
 * same reason `snapshotHashSchema` is. This key is the idempotency anchor behind
 * "the same import key with the same snapshot must be a no-op after success"
 * (§12), and that guarantee is enforced by a unique index and an equality
 * lookup, both of which compare TEXT. Accepting two spellings of one key would
 * make them two keys: a client holding a completed key could re-case it and
 * drive the whole merge again against the same guest history, bypassing the
 * no-op path entirely. `crypto.randomUUID` always mints lowercase, so no
 * legitimate client is affected.
 */
export const importKeySchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    "invalid import key",
  );
const count = z.number().int().min(0).max(GUEST_MERGE_BOUNDS.maxDeclaredItems);

/**
 * What the client says it is about to send, per kind. Declared UP FRONT so the
 * server can refuse an oversized import before a single item is stored, and so
 * finalisation can tell a complete upload from a truncated one instead of
 * applying whatever happened to arrive (§13 "explicit final status", §15
 * "partial processing cannot be mistaken for completed success").
 */
export const guestMergeDeclaredCountsSchema = z.strictObject({
  attempts: count,
  events: count,
  bookmarks: count,
  // Bounded by the list ceiling rather than the generic item cap. This bounds
  // what the client DECLARES; what it actually sends across chunks is bounded
  // only per chunk, so the cumulative ceiling is the coordinator's to enforce
  // (see GUEST_MERGE_BOUNDS.maxLists).
  lists: z.number().int().min(0).max(GUEST_MERGE_BOUNDS.maxLists),
  settings: count,
});
export type GuestMergeDeclaredCounts = z.infer<
  typeof guestMergeDeclaredCountsSchema
>;

/** Total declared items across every kind. */
export function totalDeclaredItems(counts: GuestMergeDeclaredCounts): number {
  return (
    counts.attempts +
    counts.events +
    counts.bookmarks +
    counts.lists +
    counts.settings
  );
}

// --- requests ----------------------------------------------------------------

const begin = z
  .strictObject({
    protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
    stage: z.literal("begin"),
    importKey: importKeySchema,
    snapshotHash: snapshotHashSchema,
    deviceId: boundedId,
    declared: guestMergeDeclaredCountsSchema,
  })
  // Enforced at parse time so a route handler cannot forget it — the same
  // reason `pushRequestSchema` refines its total (§29, phases-16.md §9.1).
  .refine(
    (request) =>
      totalDeclaredItems(request.declared) <=
      GUEST_MERGE_BOUNDS.maxDeclaredItems,
    { error: `import exceeds ${GUEST_MERGE_BOUNDS.maxDeclaredItems} items` },
  );

const chunk = z
  .strictObject({
    protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
    stage: z.literal("chunk"),
    importKey: importKeySchema,
    // Repeated on EVERY chunk, not just `begin`: a chunk that belongs to a
    // different snapshot than the one the key was opened with must be refused
    // on arrival, not discovered at finalisation after it has been stored.
    snapshotHash: snapshotHashSchema,
    chunkIndex: z
      .number()
      .int()
      .min(0)
      .max(GUEST_MERGE_BOUNDS.maxChunks - 1),
    attempts: z
      .array(wireAttemptSchema)
      .max(SYNC_BOUNDS.maxAttempts)
      .default([]),
    events: z.array(wireEventSchema).max(SYNC_BOUNDS.maxEvents).default([]),
    bookmarks: z
      .array(wireBookmarkSchema)
      .max(SYNC_BOUNDS.maxBookmarks)
      .default([]),
    lists: z.array(wireListSchema).max(SYNC_BOUNDS.maxLists).default([]),
    settings: z
      .array(wireSettingSchema)
      .max(SYNC_BOUNDS.maxSettings)
      .default([]),
  })
  .refine(
    (request) =>
      totalChunkItemCount(request) <= GUEST_MERGE_BOUNDS.maxItemsPerChunk,
    {
      error: `merge chunk exceeds ${GUEST_MERGE_BOUNDS.maxItemsPerChunk} total items`,
    },
  );

const finalize = z.strictObject({
  protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
  stage: z.literal("finalize"),
  importKey: importKeySchema,
  snapshotHash: snapshotHashSchema,
});

/** The staged merge request: exactly one of `begin`, `chunk`, `finalize`. */
export const guestMergeRequestSchema = z.discriminatedUnion("stage", [
  begin,
  chunk,
  finalize,
]);
export type GuestMergeRequest = z.infer<typeof guestMergeRequestSchema>;
export type GuestMergeBeginRequest = Extract<
  GuestMergeRequest,
  { stage: "begin" }
>;
export type GuestMergeChunkRequest = Extract<
  GuestMergeRequest,
  { stage: "chunk" }
>;
export type GuestMergeFinalizeRequest = Extract<
  GuestMergeRequest,
  { stage: "finalize" }
>;

/** Total items in one chunk. Also enforced by the chunk schema. */
export function totalChunkItemCount(chunkBody: {
  attempts: readonly unknown[];
  events: readonly unknown[];
  bookmarks: readonly unknown[];
  lists: readonly unknown[];
  settings: readonly unknown[];
}): number {
  return (
    chunkBody.attempts.length +
    chunkBody.events.length +
    chunkBody.bookmarks.length +
    chunkBody.lists.length +
    chunkBody.settings.length
  );
}

// --- responses ---------------------------------------------------------------

/**
 * Counts for the post-merge summary (§13, §21). Deliberately separates what was
 * APPLIED from what was already there: a learner who is told "42 reviews merged"
 * when 40 were duplicates of a history the account already had has been given a
 * number that is not true of anything.
 */
export const guestMergeSummarySchema = z.strictObject({
  attemptsApplied: count,
  attemptsDuplicate: count,
  attemptsRejected: count,
  eventsApplied: count,
  eventsDuplicate: count,
  eventsRejected: count,
  bookmarksAdded: count,
  bookmarksAlreadyPresent: count,
  /** Guest bookmarks refused — e.g. an entry id that is not in the release. */
  bookmarksRejected: count,
  listsCreated: count,
  listsMerged: count,
  listsRejected: count,
  settingsAdopted: count,
  settingsKeptFromAccount: count,
  /** Guest settings refused by the server allow-list or its value validator. */
  settingsRejected: count,
  /** Study components whose scheduling state the merge actually changed. */
  componentsAffected: count,
});
export type GuestMergeSummary = z.infer<typeof guestMergeSummarySchema>;

/**
 * One guest list's identity as it now exists on the account (§17). A guest list
 * whose normalised name already existed is folded into the ACCOUNT's list, which
 * keeps its own id — so the guest id the client still holds locally no longer
 * names anything. Without this mapping the client cannot re-key its local rows
 * and would either duplicate the list on the next sync or lose the membership it
 * just merged. `accountListId` equals `guestListId` when the guest's uuid was
 * preserved, which keeps the shape uniform for the caller instead of making
 * "unchanged" a separate case it has to remember to handle.
 */
export const guestListMappingSchema = z.strictObject({
  guestListId: uuidSchema,
  accountListId: uuidSchema,
});
export type GuestListMapping = z.infer<typeof guestListMappingSchema>;

const beginResponse = z.strictObject({
  protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
  stage: z.literal("begin"),
  importStatus: z.enum(GUEST_IMPORT_SERVER_STATUSES),
  reasonCode: z.enum(GUEST_MERGE_REASON_CODES),
  /**
   * The first chunk index the server still needs. A resumed import returns the
   * position it reached, so an interruption costs the chunks not yet sent rather
   * than the whole history (§12).
   */
  resumeFromChunk: z.number().int().min(0).max(GUEST_MERGE_BOUNDS.maxChunks),
  /** Items durably accepted so far under this key — the progress denominator. */
  acceptedItems: count,
  /**
   * Present only when the key is already `completed`: the stored summary, so a
   * resubmission after success can show the same result without reapplying
   * anything (§12, §15).
   */
  summary: guestMergeSummarySchema.optional(),
});

const chunkResponse = z.strictObject({
  protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
  stage: z.literal("chunk"),
  importStatus: z.enum(GUEST_IMPORT_SERVER_STATUSES),
  reasonCode: z.enum(GUEST_MERGE_REASON_CODES),
  chunkIndex: z
    .number()
    .int()
    .min(0)
    .max(GUEST_MERGE_BOUNDS.maxChunks - 1),
  /**
   * One result per submitted item, in the existing per-item vocabulary. Bounded
   * like the request side: a response is server-authored, but a schema that only
   * bounds one direction stops being a statement about what this protocol
   * carries and becomes a statement about who is trusted.
   */
  results: z
    .array(syncItemResultSchema)
    .max(GUEST_MERGE_BOUNDS.maxItemsPerChunk),
  acceptedItems: count,
});

const finalizeResponse = z.strictObject({
  protocolVersion: z.literal(SYNC_PROTOCOL_VERSION),
  stage: z.literal("finalize"),
  result: z.enum(GUEST_MERGE_RESULTS),
  reasonCode: z.enum(GUEST_MERGE_REASON_CODES),
  summary: guestMergeSummarySchema,
  /**
   * The cursor to pull from immediately after the merge, so the client adopts
   * the AUTHORITATIVE post-merge state rather than assuming its own optimistic
   * view was right (§13, and CLAUDE.md's server-derived-scheduling rule).
   */
  serverCursor: z.number().int().min(0),
  activeReleaseId: shortString,
  /**
   * Guest-list-id → account-list-id for every list the merge touched (§17).
   * Returned at FINALISATION rather than per chunk because a guest list's fate
   * is only settled once every chunk that could contribute to it has arrived.
   */
  listIdMappings: z
    .array(guestListMappingSchema)
    .max(GUEST_MERGE_BOUNDS.maxLists)
    .default([]),
});

export const guestMergeResponseSchema = z.discriminatedUnion("stage", [
  beginResponse,
  chunkResponse,
  finalizeResponse,
]);
export type GuestMergeResponse = z.infer<typeof guestMergeResponseSchema>;
export type GuestMergeBeginResponse = Extract<
  GuestMergeResponse,
  { stage: "begin" }
>;
export type GuestMergeChunkResponse = Extract<
  GuestMergeResponse,
  { stage: "chunk" }
>;
export type GuestMergeFinalizeResponse = Extract<
  GuestMergeResponse,
  { stage: "finalize" }
>;

/** A summary with every count zero — the starting point for accumulation. */
export function emptyGuestMergeSummary(): GuestMergeSummary {
  return {
    attemptsApplied: 0,
    attemptsDuplicate: 0,
    attemptsRejected: 0,
    eventsApplied: 0,
    eventsDuplicate: 0,
    eventsRejected: 0,
    bookmarksAdded: 0,
    bookmarksAlreadyPresent: 0,
    bookmarksRejected: 0,
    listsCreated: 0,
    listsMerged: 0,
    listsRejected: 0,
    settingsAdopted: 0,
    settingsKeptFromAccount: 0,
    settingsRejected: 0,
    componentsAffected: 0,
  };
}

/**
 * Did this merge change anything the learner would recognise as theirs? Drives
 * the `applied` vs `no_op` distinction (§13): a resubmission that duplicates an
 * already-merged history is honestly a no-op, not a second success.
 */
export function summaryChangedAnything(summary: GuestMergeSummary): boolean {
  return (
    summary.attemptsApplied > 0 ||
    summary.eventsApplied > 0 ||
    summary.bookmarksAdded > 0 ||
    summary.listsCreated > 0 ||
    summary.listsMerged > 0 ||
    summary.settingsAdopted > 0
  );
}
