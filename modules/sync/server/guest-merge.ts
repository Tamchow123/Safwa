/**
 * Phase 17 §13–§15 — the guest→account merge COORDINATOR.
 *
 * The state machine behind the staged protocol: `begin` claims an import key,
 * `chunk` carries the history in, `finalize` concludes it.
 *
 * NOTHING IS REMEMBERED IN PROCESS. The `guest_imports` row plus its
 * `guest_import_list_mappings` children are the server's entire memory between
 * requests, and that is what makes an interrupted merge resumable rather than
 * restartable. The three stages are separate HTTP requests, which on this
 * deployment are routinely served by different serverless instances, so
 * anything held in module state would be lost between them — not rarely, but
 * routinely, and silently.
 *
 * OWNERSHIP IS NEVER TAKEN FROM THE REQUEST. `userId` is a parameter because
 * the route derives it from the session and nothing else (§9.2); no field of
 * `GuestMergeRequest` names an account, so there is nothing here to confuse.
 * The feature flag and email-verification gates are likewise the route's — they
 * are the same gates every sync endpoint applies, and duplicating them here
 * would create a second place for them to drift. What this module owns is the
 * translation of a guard failure into the protocol's own reason-code
 * vocabulary, so the route has one obvious thing to call and cannot invent its
 * own spelling of "merge disabled".
 *
 * SERIALISATION. Every stage reads its row `FOR UPDATE` inside a short
 * transaction, so two requests under one import key cannot both decide what to
 * do next. The heavy work — ingestion, collection and settings merges — happens
 * OUTSIDE that lock, because those paths take their own per-component and
 * per-account locks and holding a merge lock across them would invert the lock
 * order the rest of `modules/sync/server` uses.
 *
 * That is safe because of `next_chunk_index`. A chunk is admitted only when it
 * is exactly the chunk expected next, so two requests racing under one key are
 * either the SAME chunk — and every write path they drive is idempotent, so
 * applying it twice changes nothing — or a different one, which is refused as
 * out of range. There is never a window in which two DIFFERENT chunks are in
 * flight together, which is what lets the cumulative list ceiling below be
 * decided from a single row read.
 *
 * `server-only`.
 */
import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { guestImportListMappings, guestImports } from "@/db/schema";
import { getActiveRelease } from "@/modules/content/server-release-registry";
import {
  emptyGuestMergeSummary,
  GUEST_MERGE_BOUNDS,
  type GuestListMapping,
  type GuestMergeBeginRequest,
  type GuestMergeChunkRequest,
  type GuestMergeFinalizeRequest,
  type GuestMergeReasonCode,
  type GuestMergeRequest,
  type GuestMergeResponse,
  type GuestMergeSummary,
  summaryChangedAnything,
  SYNC_PROTOCOL_VERSION,
  totalChunkItemCount,
  totalDeclaredItems,
  type SyncItemResult,
} from "@/modules/sync/protocol";

import { currentAccountCursor, type SyncTx } from "./cursor";
import type { SyncGuardRefusal } from "./guard-decision";
import {
  mergeGuestBookmarks,
  mergeGuestLists,
} from "./guest-merge-collections";
import { mergeGuestSettings } from "./guest-merge-settings";
import { ingestSchedulingBatch } from "./ingest";

export type GuestMergeOptions = {
  /** Injected server-receipt clock (epoch ms) — never Date.now(). */
  nowMs: number;
  /** Correlation id for the request, recorded in audit rows. */
  correlationId?: string;
  /** Test-only override forwarded to the release registry. */
  registryDir?: string;
};

type ImportRow = typeof guestImports.$inferSelect;

/** The stored summary, or a zeroed one when a row has none yet. */
function storedSummary(row: ImportRow): GuestMergeSummary {
  const stored = row.summary as Partial<GuestMergeSummary> | null;
  return { ...emptyGuestMergeSummary(), ...(stored ?? {}) };
}

/**
 * Add one stage's counts onto the running total. The summary is accumulated in
 * the ROW rather than recomputed at finalisation, because by then the chunks
 * that produced the numbers are long gone — the server does not retain the
 * payloads (§30), so there is nothing left to count.
 */
function addSummaries(
  base: GuestMergeSummary,
  delta: Partial<GuestMergeSummary>,
): GuestMergeSummary {
  const total = { ...base };
  for (const [key, value] of Object.entries(delta) as [
    keyof GuestMergeSummary,
    number | undefined,
  ][]) {
    if (typeof value === "number") total[key] += value;
  }
  return total;
}

function beginResponse(
  row: ImportRow | null,
  reasonCode: GuestMergeReasonCode,
  options: { includeSummary?: boolean } = {},
): GuestMergeResponse {
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    stage: "begin",
    importStatus:
      (row?.status as "open" | "completed" | "rejected" | undefined) ??
      "rejected",
    reasonCode,
    resumeFromChunk: row?.nextChunkIndex ?? 0,
    acceptedItems: row?.acceptedItems ?? 0,
    ...(options.includeSummary && row ? { summary: storedSummary(row) } : {}),
  };
}

function chunkResponse(
  chunkIndex: number,
  row: ImportRow | null,
  reasonCode: GuestMergeReasonCode,
  results: SyncItemResult[] = [],
): GuestMergeResponse {
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    stage: "chunk",
    importStatus:
      (row?.status as "open" | "completed" | "rejected" | undefined) ??
      "rejected",
    reasonCode,
    chunkIndex,
    results,
    acceptedItems: row?.acceptedItems ?? 0,
  };
}

async function finalizeResponse(
  result: "applied" | "no_op" | "rejected" | "incomplete",
  reasonCode: GuestMergeReasonCode,
  summary: GuestMergeSummary,
  serverCursor: number,
  mappings: GuestListMapping[],
  options: GuestMergeOptions,
): Promise<GuestMergeResponse> {
  const release = await getActiveRelease(
    options.registryDir ? { registryDir: options.registryDir } : {},
  );
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    stage: "finalize",
    result,
    reasonCode,
    summary,
    serverCursor,
    activeReleaseId: release.releaseId,
    listIdMappings: mappings,
  };
}

/**
 * Resolve an import key to its row, under `FOR UPDATE`, and decide whether this
 * request may act on it at all.
 *
 * The three refusals here are the ones that must be identical at every stage,
 * so they live in one place rather than being restated three times:
 *   - the key belongs to another account (§15) — refused WITHOUT revealing the
 *     other account's progress, which is why the response is built from `null`
 *     rather than from the row we just read;
 *   - the key is bound to a different snapshot (§12) — treating different data
 *     as the same import is exactly the silent corruption the hash exists to
 *     prevent;
 *   - the key was durably rejected — the stored reason says why, which is what
 *     `guest_imports.reason_code` exists for.
 */
type Resolution =
  | { ok: true; row: ImportRow }
  | { ok: false; reasonCode: GuestMergeReasonCode; row: ImportRow | null };

/**
 * The account's already-completed import of this snapshot, if it has one.
 *
 * Backs §15's "the same successful import resubmitted is a no-op" for the case
 * the import KEY cannot detect: a client that lost its key and minted a new one
 * for a history the account already holds.
 */
async function completedImportOfSnapshot(
  tx: SyncTx,
  userId: string,
  snapshotHash: string,
): Promise<ImportRow | null> {
  const [row] = await tx
    .select()
    .from(guestImports)
    .where(
      and(
        eq(guestImports.userId, userId),
        eq(guestImports.snapshotHash, snapshotHash),
        eq(guestImports.status, "completed"),
      ),
    );
  return row ?? null;
}

async function resolveImport(
  tx: SyncTx,
  userId: string,
  importKey: string,
  snapshotHash: string,
): Promise<Resolution | null> {
  const [row] = await tx
    .select()
    .from(guestImports)
    .where(eq(guestImports.importKey, importKey))
    .for("update");
  if (!row) return null;

  if (row.userId !== userId) {
    // Enumeration-safe: the caller learns the key is not theirs and nothing
    // about whose it is or how far it got.
    return { ok: false, reasonCode: "cross_account_import", row: null };
  }
  if (row.snapshotHash !== snapshotHash) {
    return { ok: false, reasonCode: "snapshot_mismatch", row };
  }
  if (row.status === "rejected") {
    return {
      ok: false,
      reasonCode:
        (row.reasonCode as GuestMergeReasonCode | null) ?? "internal_error",
      row,
    };
  }
  return { ok: true, row };
}

/**
 * `begin` — claim the import key, or recognise one already claimed (§12, §15).
 *
 * Idempotent in the way that matters: the same key with the same snapshot after
 * success returns the STORED summary and applies nothing, so a client that
 * retried through a lost response shows the learner the same numbers rather
 * than merging a second time.
 */
async function begin(
  userId: string,
  request: GuestMergeBeginRequest,
): Promise<GuestMergeResponse> {
  const db = getDb();
  const declared = totalDeclaredItems(request.declared);

  return db.transaction(async (tx) => {
    const resolved = await resolveImport(
      tx,
      userId,
      request.importKey,
      request.snapshotHash,
    );

    if (resolved && !resolved.ok) {
      return beginResponse(resolved.row, resolved.reasonCode);
    }

    if (resolved) {
      const { row } = resolved;
      if (row.status === "completed") {
        // Nothing to do, and say so with the numbers already recorded.
        return beginResponse(row, "already_completed", {
          includeSummary: true,
        });
      }
      // Open: resume where it got to. The declared totals are NOT re-recorded —
      // the first `begin` fixed what this import is, and letting a later one
      // redeclare would make "was the upload complete?" a question about the
      // most recent claim rather than about the import.
      return beginResponse(row, "accepted");
    }

    // A fresh key — but possibly not a fresh SNAPSHOT. `guest_imports` carries a
    // partial unique index on (user_id, snapshot_hash) WHERE status = 'completed'
    // (§15), so an account can complete a given snapshot at most once however
    // many keys it mints for it. Discovering that at finalisation would mean the
    // whole history had already been re-uploaded and re-applied first, and the
    // completion write would then fail on the index rather than answering.
    //
    // So it is answered here, before a single chunk is accepted: the snapshot is
    // already merged, the stored numbers are the true ones, and there is nothing
    // for this key to do.
    const alreadyMerged = await completedImportOfSnapshot(
      tx,
      userId,
      request.snapshotHash,
    );
    if (alreadyMerged) {
      return beginResponse(alreadyMerged, "already_completed", {
        includeSummary: true,
      });
    }

    // The wire schema already refused an oversized declaration, so reaching here
    // with one would mean the schema and this check disagree; it is repeated
    // because the row is about to become durable either way.
    if (declared > GUEST_MERGE_BOUNDS.maxDeclaredItems) {
      return beginResponse(null, "declared_totals_exceeded");
    }
    if (request.declared.lists > GUEST_MERGE_BOUNDS.maxLists) {
      return beginResponse(null, "list_ceiling_exceeded");
    }

    const [created] = await tx
      .insert(guestImports)
      .values({
        userId,
        deviceId: request.deviceId,
        importKey: request.importKey,
        snapshotHash: request.snapshotHash,
        declaredItems: declared,
        summary: emptyGuestMergeSummary(),
      })
      // Another request under this key raced us here. It did the same work with
      // the same values, so the loser simply reads what the winner wrote rather
      // than failing a merge over a duplicate click.
      .onConflictDoNothing({ target: guestImports.importKey })
      .returning();

    if (created) return beginResponse(created, "accepted");

    const reread = await resolveImport(
      tx,
      userId,
      request.importKey,
      request.snapshotHash,
    );
    if (!reread) return beginResponse(null, "internal_error");
    if (!reread.ok) return beginResponse(reread.row, reread.reasonCode);
    return beginResponse(reread.row, "accepted");
  });
}

/**
 * `chunk` — validate one chunk against the durable claim, apply it, and record
 * that it arrived.
 *
 * Three separate transactions on purpose. The first decides, under the row
 * lock, whether this chunk may be applied at all — including the CUMULATIVE
 * list ceiling, which no per-request schema can enforce because it is a fact
 * about the import rather than about any one request (SEC-003). The second is
 * the application itself, which takes its own locks. The third records the
 * advance, again under the row lock.
 */
async function chunk(
  userId: string,
  request: GuestMergeChunkRequest,
  options: GuestMergeOptions,
): Promise<GuestMergeResponse> {
  const db = getDb();
  const itemCount = totalChunkItemCount(request);

  // --- 1. May this chunk be applied? ---------------------------------------
  const gate = await db.transaction(async (tx) => {
    const resolved = await resolveImport(
      tx,
      userId,
      request.importKey,
      request.snapshotHash,
    );
    if (!resolved) {
      return {
        admit: false as const,
        row: null,
        reasonCode: "unknown_import" as const,
      };
    }
    if (!resolved.ok) {
      return {
        admit: false as const,
        row: resolved.row,
        reasonCode: resolved.reasonCode,
      };
    }
    const { row } = resolved;
    if (row.status === "completed") {
      return {
        admit: false as const,
        row,
        reasonCode: "already_completed" as const,
      };
    }
    if (request.chunkIndex > row.nextChunkIndex) {
      // A gap. Accepting it would make `next_chunk_index` a lie and let
      // finalisation call a truncated upload complete.
      return {
        admit: false as const,
        row,
        reasonCode: "chunk_out_of_range" as const,
      };
    }
    if (request.chunkIndex < row.nextChunkIndex) {
      // Already applied. Re-applying would be harmless (every write path below
      // is idempotent) but would re-count it, so it is reported as accepted
      // without being done again.
      return {
        admit: false as const,
        row,
        reasonCode: "accepted" as const,
        replay: true as const,
      };
    }

    // SEC-003: the cumulative list ceiling. `accepted_lists` is the running
    // count that survives between requests, which is the only place this can be
    // decided — `maxChunks × SYNC_BOUNDS.maxLists` allows far more list items
    // across an import than the ceiling, so the per-chunk schema cannot bound
    // it. Refused rather than truncated: dropping the excess would orphan those
    // guest list ids on the client and break the re-keying §17 guarantees.
    if (
      row.acceptedLists + request.lists.length >
      GUEST_MERGE_BOUNDS.maxLists
    ) {
      const [rejected] = await tx
        .update(guestImports)
        .set({
          status: "rejected",
          result: "rejected",
          reasonCode: "list_ceiling_exceeded",
          completedAt: new Date(options.nowMs),
        })
        .where(eq(guestImports.id, row.id))
        .returning();
      return {
        admit: false as const,
        row: rejected ?? row,
        reasonCode: "list_ceiling_exceeded" as const,
      };
    }

    return { admit: true as const, row, reasonCode: "accepted" as const };
  });

  if (!gate.admit) {
    return chunkResponse(request.chunkIndex, gate.row, gate.reasonCode);
  }

  // --- 2. Apply it, outside the row lock -----------------------------------
  const importId = gate.row.id;
  const results: SyncItemResult[] = [];
  // A COMPLETE zeroed summary, not a partial. Accumulating onto {} and casting
  // it to the full shape would make the first addition land on `undefined`,
  // and NaN is exactly what the numbers-only constraint on this column exists
  // to catch.
  let delta: GuestMergeSummary = emptyGuestMergeSummary();
  let acceptedLists = 0;
  let listMappings: GuestListMapping[] = [];

  if (request.events.length > 0 || request.attempts.length > 0) {
    const ingested = await ingestSchedulingBatch(
      userId,
      request.events,
      request.attempts,
      {
        nowMs: options.nowMs,
        correlationId: options.correlationId,
        // Forwarded for the same reason the collection merges forward it: the
        // release registry is what decides `invalid_release`/`revoked_release`
        // here too, and an override that reached three of the four merge paths
        // would leave the fourth untestable. It is `undefined` in production
        // and rejected outright outside NODE_ENV=test.
        registryDir: options.registryDir,
        // The server-internal merge ingestion mode (§13). This is the only
        // place in the codebase that sets it, and the id comes from the row
        // this coordinator holds — never from the request.
        guestImport: { importId },
      },
    );
    results.push(...ingested.results);
    delta = addSummaries(delta, countIngested(ingested.results));
  }

  if (request.bookmarks.length > 0) {
    const merged = await mergeGuestBookmarks(userId, request.bookmarks, {
      correlationId: options.correlationId,
      registryDir: options.registryDir,
    });
    results.push(...merged.results);
    delta = addSummaries(delta, {
      bookmarksAdded: merged.added,
      bookmarksAlreadyPresent: merged.alreadyPresent,
      bookmarksRejected: merged.rejected,
    });
  }

  if (request.lists.length > 0) {
    const merged = await mergeGuestLists(userId, request.lists, {
      correlationId: options.correlationId,
      registryDir: options.registryDir,
    });
    results.push(...merged.results);
    acceptedLists = merged.created + merged.merged;
    delta = addSummaries(delta, {
      listsCreated: merged.created,
      listsMerged: merged.merged,
      listsRejected: merged.rejected,
    });
    listMappings = merged.mappings;
  }

  if (request.settings.length > 0) {
    const merged = await mergeGuestSettings(userId, request.settings, {
      correlationId: options.correlationId,
    });
    results.push(...merged.results);
    delta = addSummaries(delta, {
      settingsAdopted: merged.adopted,
      settingsKeptFromAccount: merged.keptFromAccount,
      settingsRejected: merged.rejected,
    });
  }

  // --- 3. Record that it arrived -------------------------------------------
  const advanced = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(guestImports)
      .where(eq(guestImports.id, importId))
      .for("update");
    if (!row) return null;

    // Recorded BEFORE the index check, and outside it. The mappings are what
    // the client needs to re-key, and they must be durable whether or not this
    // particular request is the one that advances the counter — a racing
    // duplicate did the same work and produced the same pairs, and the primary
    // key makes writing them twice a no-op. Counting is the thing that must
    // happen once; recording an identity is not.
    await recordListMappings(tx, importId, listMappings);

    // Only the transaction that finds the index still un-advanced records the
    // counts. A racing duplicate of this same chunk did the same idempotent
    // work and must not count it twice.
    if (row.nextChunkIndex !== request.chunkIndex) return row;

    const [updated] = await tx
      .update(guestImports)
      .set({
        nextChunkIndex: request.chunkIndex + 1,
        acceptedItems: row.acceptedItems + itemCount,
        acceptedLists: row.acceptedLists + acceptedLists,
        eventCount: row.eventCount + request.events.length,
        attemptCount: row.attemptCount + request.attempts.length,
        summary: addSummaries(storedSummary(row), delta),
      })
      .where(eq(guestImports.id, importId))
      .returning();
    return updated ?? row;
  });

  return chunkResponse(request.chunkIndex, advanced, "accepted", results);
}

/**
 * Translate per-item ingestion results into summary counts. Attempts and events
 * are counted from what the server DECIDED, never from what the client claimed
 * it was sending — the same rule that governs correctness and rating (§9.3).
 */
function countIngested(results: readonly SyncItemResult[]) {
  const counts = {
    attemptsApplied: 0,
    attemptsDuplicate: 0,
    attemptsRejected: 0,
    eventsApplied: 0,
    eventsDuplicate: 0,
    eventsRejected: 0,
    componentsAffected: 0,
  };
  const components = new Set<string>();
  for (const item of results) {
    const applied = item.status === "accepted" || item.status === "corrected";
    if (item.itemKind === "attempt") {
      if (applied) counts.attemptsApplied += 1;
      else if (item.duplicate) counts.attemptsDuplicate += 1;
      else counts.attemptsRejected += 1;
    } else if (item.itemKind === "event") {
      if (applied) counts.eventsApplied += 1;
      else if (item.duplicate) counts.eventsDuplicate += 1;
      // A held `pending_parent` event is neither applied nor rejected: its
      // parent has not arrived yet and it may still be promoted. Counting it as
      // either would be a claim the server has not made.
      else if (item.status === "rejected") counts.eventsRejected += 1;
      if (applied && item.componentKey) components.add(item.componentKey);
    }
  }
  counts.componentsAffected = components.size;
  return counts;
}

/**
 * List id mappings are accumulated across chunks because a guest list's fate is
 * only settled once every chunk that could contribute to it has arrived (§17),
 * and they are read back by `finalize` — a DIFFERENT HTTP request.
 *
 * DURABLE, AND IT HAS TO BE. Two independent reasons, either alone sufficient:
 * this deploys to Vercel serverless, so the `chunk` that produces a mapping and
 * the `finalize` that returns it are routinely served by different instances;
 * and a mapping cannot be recomputed after the fact, because a `completed`
 * import refuses to re-apply its chunks — which is exactly what idempotency
 * requires of it. Process-local state would therefore not degrade gracefully:
 * it would yield a merge that genuinely applied, reported success, and returned
 * no mappings, leaving the client holding guest ids that name nothing.
 *
 * Written inside the same row-locked transaction that records the chunk, with
 * `ON CONFLICT DO NOTHING` against the (import_id, guest_list_id) primary key,
 * so a re-sent chunk cannot duplicate an entry or push the response past its
 * own `maxLists` bound.
 */
async function recordListMappings(
  tx: SyncTx,
  importId: string,
  mappings: readonly GuestListMapping[],
): Promise<void> {
  if (mappings.length === 0) return;
  await tx
    .insert(guestImportListMappings)
    .values(
      mappings.map((mapping) => ({
        importId,
        guestListId: mapping.guestListId,
        accountListId: mapping.accountListId,
      })),
    )
    .onConflictDoNothing();
}

async function readListMappings(
  tx: SyncTx,
  importId: string,
): Promise<GuestListMapping[]> {
  const rows = await tx
    .select({
      guestListId: guestImportListMappings.guestListId,
      accountListId: guestImportListMappings.accountListId,
    })
    .from(guestImportListMappings)
    .where(eq(guestImportListMappings.importId, importId));
  return rows;
}

/**
 * `finalize` — conclude the import, or report honestly that it could not be
 * concluded (§13, §15, §29).
 *
 * `incomplete` is a first-class outcome, not an error path. Chunks were
 * applied but the declared upload never finished, so the merge neither
 * succeeded nor rolled back — and telling the learner either would be false.
 * The row stays `open` so the client resumes under the same key.
 */
async function finalize(
  userId: string,
  request: GuestMergeFinalizeRequest,
  options: GuestMergeOptions,
): Promise<GuestMergeResponse> {
  const db = getDb();

  type FinalizeOutcome = {
    result: "applied" | "no_op" | "rejected" | "incomplete";
    reasonCode: GuestMergeReasonCode;
    summary: GuestMergeSummary;
    /**
     * The cursor the client should pull from. Read INSIDE the transaction that
     * decides the outcome, and for an already-completed import taken from the
     * value stored at its completion — a fresh read afterwards could return a
     * later cursor than the one recorded, telling the client to start from a
     * point past the state this merge actually produced.
     */
    serverCursor: number;
    /** Guest-list-id to account-list-id, read durably (§17). */
    mappings: GuestListMapping[];
  };

  const outcome: FinalizeOutcome = await db.transaction(async (tx) => {
    // REL-003: two DIFFERENT keys for the same snapshot can reach completion at
    // the same moment, and `guest_imports_user_snapshot_completed_idx` admits
    // only one of them. Checking for the other one first is check-then-act: both
    // transactions would see none and the loser would surface a raw constraint
    // violation instead of the graceful answer below. This lock makes the check
    // authoritative by serialising finalisation per (account, snapshot).
    //
    // Taken FIRST, before any row lock, so every finaliser acquires in the same
    // order; nothing else in the codebase takes this key.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${userId}:guest-merge-snapshot:${request.snapshotHash}`}), 0)`,
    );

    const resolved = await resolveImport(
      tx,
      userId,
      request.importKey,
      request.snapshotHash,
    );
    if (!resolved) {
      return {
        result: "rejected" as const,
        reasonCode: "unknown_import" as const,
        summary: emptyGuestMergeSummary(),
        serverCursor: 0,
        mappings: [],
      };
    }
    if (!resolved.ok) {
      return {
        result: "rejected" as const,
        reasonCode: resolved.reasonCode,
        summary: resolved.row
          ? storedSummary(resolved.row)
          : emptyGuestMergeSummary(),
        serverCursor: 0,
        mappings: [],
      };
    }

    const { row } = resolved;
    const summary = storedSummary(row);

    if (row.status === "completed") {
      // The database constrains a completed row's result to `applied` or
      // `no_op` (guest_imports_completion_check), so the narrowing below cannot
      // widen what is actually stored; `no_op` is the conservative default if a
      // row ever reached here without one.
      const stored = row.result === "applied" ? "applied" : "no_op";
      return {
        result: stored as "applied" | "no_op",
        reasonCode: "already_completed" as const,
        summary,
        serverCursor: row.finalServerCursor ?? 0,
        mappings: await readListMappings(tx, row.id),
      };
    }

    if (row.acceptedItems < row.declaredItems) {
      // Not everything declared has arrived. Record the attempt so a later
      // reader can tell "interrupted" from "never tried", and leave the
      // lifecycle open so the client resumes rather than starting over.
      await tx
        .update(guestImports)
        .set({ result: "incomplete", reasonCode: "incomplete_upload" })
        .where(eq(guestImports.id, row.id));
      return {
        result: "incomplete" as const,
        reasonCode: "incomplete_upload" as const,
        summary,
        // Nothing is final yet, so there is no post-merge cursor to adopt; the
        // client resumes rather than pulling.
        serverCursor: 0,
        mappings: await readListMappings(tx, row.id),
      };
    }

    // Another key completed this same snapshot after this one began — the
    // narrow race `begin`'s check cannot close on its own. The unique index
    // would refuse the completion below, so answer instead of throwing.
    //
    // The lifecycle becomes `rejected` because this IMPORT was refused, and the
    // reason says exactly why. The learner is not told a merge failed: the
    // response is `no_op` / `already_completed`, which is what actually
    // happened — the history is on the account, just not by way of this key.
    const raced = await completedImportOfSnapshot(
      tx,
      userId,
      request.snapshotHash,
    );
    if (raced) {
      await tx
        .update(guestImports)
        .set({
          status: "rejected",
          result: "rejected",
          reasonCode: "already_completed",
          completedAt: new Date(options.nowMs),
        })
        .where(eq(guestImports.id, row.id));
      return {
        result: "no_op" as const,
        reasonCode: "already_completed" as const,
        summary: storedSummary(raced),
        serverCursor: raced.finalServerCursor ?? 0,
        // The WINNER's mappings: those are the ids the account's lists actually
        // have, and this key's own rows describe the same lists by construction.
        mappings: await readListMappings(tx, raced.id),
      };
    }

    const cursor = await currentAccountCursor(tx, userId);
    // `no_op` when a resubmitted history was already the account's: honest,
    // and distinct from `applied` in exactly the case a learner would notice.
    const result = summaryChangedAnything(summary) ? "applied" : "no_op";
    await tx
      .update(guestImports)
      .set({
        status: "completed",
        result,
        reasonCode: "accepted",
        completedAt: new Date(options.nowMs),
        finalServerCursor: cursor,
        summary,
      })
      .where(eq(guestImports.id, row.id));
    return {
      result,
      reasonCode: "accepted" as const,
      summary,
      serverCursor: cursor,
      mappings: await readListMappings(tx, row.id),
    };
  });

  return finalizeResponse(
    outcome.result,
    outcome.reasonCode,
    outcome.summary,
    outcome.serverCursor,
    outcome.mappings,
    options,
  );
}

/**
 * Run one staged merge request against an ALREADY-AUTHORISED account.
 *
 * `userId` must come from the server session and nothing else (§9.2). The route
 * is responsible for the flag/session/verification gates; see
 * {@link guestMergeGuardReason} for turning a guard failure into this
 * protocol's vocabulary.
 */
export async function runGuestMerge(
  userId: string,
  request: GuestMergeRequest,
  options: GuestMergeOptions,
): Promise<GuestMergeResponse> {
  switch (request.stage) {
    case "begin":
      return begin(userId, request);
    case "chunk":
      return chunk(userId, request, options);
    case "finalize":
      return finalize(userId, request, options);
  }
}

/**
 * The merge's name for a sync-guard refusal. The guard itself is shared with
 * every other sync endpoint (`./auth-guard`); only the vocabulary differs, and
 * keeping the translation here means the route cannot spell it differently.
 *
 * Branches on the guard's own `reason`, NOT on the HTTP status, because the
 * status is ambiguous: a cross-origin refusal and an unverified email are both
 * 403. Reading the number would have told a learner whose browser followed a
 * link from another site to go and verify an email that is already verified —
 * an instruction that cannot be followed and does not describe what happened.
 */
export function guestMergeGuardReason(
  reason: SyncGuardRefusal,
): GuestMergeReasonCode {
  switch (reason) {
    case "disabled":
      return "merge_disabled";
    case "unverified":
      return "email_unverified";
    // A cross-origin request and an unparseable one are the same thing from
    // the learner's side: the client sent something the server would not
    // accept, and there is nothing for them to act on. `unauthenticated`
    // joins them because the merge's vocabulary has no "signed out" code —
    // the session is the client's to re-establish, not the learner's.
    case "cross-origin":
    case "unauthenticated":
      return "malformed_request";
  }
}
