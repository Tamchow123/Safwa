/**
 * Phase 17 §12, §13 — the staged guest→account upload driver.
 *
 * Drives one merge attempt: claim the durable import key, `begin`, send the
 * chunks the server still needs, `finalize`. It is the only place the three
 * stages are sequenced, and every decision it makes is about the same question:
 * what may be re-sent, and what may never be claimed twice.
 *
 * NOTHING HERE RUNS WITHOUT CONSENT (§9.1). The driver is called by the state
 * machine only after the learner has agreed; it does not observe sessions, does
 * not poll and has no automatic trigger of its own.
 *
 * RESUME (§12). The import key is persisted BEFORE the first network mutation,
 * and the server answers `begin` with the first chunk index it still needs. A
 * resumed attempt skips to that index — chunking is deterministic, so chunk `n`
 * is byte-identical to the one the interrupted attempt would have sent. An
 * interruption therefore costs the chunks not yet sent, not the history.
 *
 * WHAT IT REFUSES TO DO. It never re-plans a snapshot mid-upload, never invents
 * a new key to escape a refusal, and never reports success before finalisation
 * says so — an upload that got every chunk through but could not finalise is
 * `incomplete`, which is neither success nor rollback, and saying otherwise is
 * the false-rollback claim §29 forbids.
 *
 * ONE ATTEMPT AT A TIME, PER ACCOUNT (REL-002). The driver holds no lock of its
 * own. `claimGuestImport` stops two callers minting two keys, and both the
 * server's per-item idempotency and `recordGuestImportProgress`'s monotonic
 * `Math.max` stop concurrent attempts corrupting anything — but two live drivers
 * under one key would still duplicate the whole upload's traffic and report
 * progress each does not know the other has passed. Serialising is the CALLER's
 * job, the same way `orchestrator.ts` single-flights ordinary sync per account;
 * the merge state machine owns it. Putting a lock here instead would make this
 * module stateful for an invariant its caller has to enforce anyway.
 *
 * Browser-only (Dexie for the durable key); the network is injected so the
 * driver is testable without one.
 */
import type { SafwaDb } from "@/modules/content/db";
import {
  SYNC_PROTOCOL_VERSION,
  type GuestListMapping,
  type GuestMergeReasonCode,
  type GuestMergeRequest,
  type GuestMergeResult,
  type GuestMergeSummary,
} from "@/modules/sync/protocol";

import {
  claimGuestImport,
  markGuestImportFailed,
  recordGuestImportProgress,
  type GuestImportOptions,
} from "./guest-import-key";
import { guestSnapshotHash, type GuestSnapshot } from "./guest-snapshot";
import {
  isRetryableMergeFailure,
  postGuestMerge,
  type GuestMergeApiFailure,
  type GuestMergeApiResult,
} from "./guest-merge-api";
import { declaredCountsOf, planGuestMergeChunks } from "./guest-merge-chunking";

/**
 * Sent when a guest reaches the merge with no device profile ever minted
 * (`GuestSnapshot.deviceId` is null). `guest_imports.device_id` is an
 * AUDIT-ONLY column — the server reads it for nothing, deriving ownership from
 * the session and idempotency from the import key — so a placeholder costs
 * observability, not correctness, and refusing the merge over a diagnostic
 * field would cost the learner their history.
 *
 * Deliberately not UUID-shaped, so an operator reading the audit trail can see
 * at a glance that this is the unminted case and not mistake it for a device.
 */
const UNMINTED_DEVICE_ID = "unminted-device";

/** Progress for the UI. Item counts, never ids or payloads (§21). */
export type GuestMergeProgress = {
  /** Chunks durably accepted so far. */
  chunksSent: number;
  /** Chunks this attempt must get through in total. */
  chunksTotal: number;
  /** Items the server has durably accepted under this key. */
  acceptedItems: number;
};

/** How the upload ended. Exactly one of these is true of any attempt. */
export type GuestMergeUploadOutcome =
  | {
      status: "completed";
      /** `applied` or `no_op` — a repeated merge is honestly not a second success. */
      result: Extract<GuestMergeResult, "applied" | "no_op">;
      summary: GuestMergeSummary;
      listIdMappings: GuestListMapping[];
      serverCursor: number;
      importKey: string;
    }
  | {
      /** Refused for a reason another attempt under this key cannot change. */
      status: "rejected";
      reasonCode: GuestMergeReasonCode;
      importKey: string;
    }
  | {
      /**
       * Interrupted. NOT a rollback: whatever was accepted stays accepted, and
       * the next attempt resumes under the same key (§29).
       */
      status: "interrupted";
      retryable: boolean;
      failure?: GuestMergeApiFailure;
      reasonCode?: GuestMergeReasonCode;
      importKey: string;
    };

export type GuestMergeUploadDeps = {
  /** Injected for tests; defaults to the real endpoint client. */
  post?: typeof postGuestMerge;
  onProgress?: (progress: GuestMergeProgress) => void;
  /** Passed through to the durable import-key store (CSPRNG + clock). */
  importOptions?: GuestImportOptions;
  /** Per-request timeout (ms); defaults to `DEFAULT_MERGE_REQUEST_TIMEOUT_MS`. */
  requestTimeoutMs?: number;
};

/**
 * Per-request ceiling, matching ordinary sync's (REL-003-T15). PER REQUEST, not
 * per merge: a large history legitimately takes many chunks and minutes, but no
 * single stage should ever hang.
 *
 * Without this the merge could stall forever on a request a proxy holds open —
 * and because the merge dialog is deliberately not dismissible while running,
 * that stall was not a stuck progress bar but a modal blocking the whole
 * signed-in app with no way out but a reload.
 */
const DEFAULT_MERGE_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Race one stage against the clock, aborting the fetch. A timeout is reported
 * as `network`, which `isRetryableMergeFailure` already treats as retryable —
 * the honest reading, since the request may well have been received.
 */
async function withTimeout(
  timeoutMs: number,
  call: (init: { signal: AbortSignal }) => Promise<GuestMergeApiResult>,
): Promise<GuestMergeApiResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<GuestMergeApiResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, reason: "network" });
    }, timeoutMs);
  });
  try {
    return await Promise.race([call({ signal: controller.signal }), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function interrupted(
  importKey: string,
  failure: GuestMergeApiFailure,
  reasonCode?: GuestMergeReasonCode,
): GuestMergeUploadOutcome {
  return {
    status: "interrupted",
    retryable: isRetryableMergeFailure(failure),
    failure,
    ...(reasonCode ? { reasonCode } : {}),
    importKey,
  };
}

/**
 * Upload `snapshot` into the signed-in account `userId`.
 *
 * Never throws for a network or protocol condition — those are outcomes the UI
 * must render honestly. It does propagate a programming error (an unplannable
 * snapshot, a Dexie failure), because those are bugs, not states.
 */
export async function uploadGuestMerge(
  db: SafwaDb,
  userId: string,
  snapshot: GuestSnapshot,
  deps: GuestMergeUploadDeps = {},
): Promise<GuestMergeUploadOutcome> {
  const rawPost = deps.post ?? postGuestMerge;
  const timeoutMs = deps.requestTimeoutMs ?? DEFAULT_MERGE_REQUEST_TIMEOUT_MS;
  // Every stage goes through the timeout, so the driver always SETTLES. A hung
  // request cannot leave the merge dialog — which is deliberately not
  // dismissible while running — blocking the app forever (REL-003-T15).
  const post = (request: GuestMergeRequest): Promise<GuestMergeApiResult> =>
    withTimeout(timeoutMs, (init) => rawPost(request, init));

  // Plan BEFORE claiming a key: a snapshot that cannot be chunked must not
  // leave a claimed import behind for a merge that can never be sent.
  const chunks = planGuestMergeChunks(snapshot);
  const snapshotHash = await guestSnapshotHash(snapshot);
  const claim = await claimGuestImport(
    db,
    userId,
    snapshotHash,
    deps.importOptions,
  );
  const { importKey } = claim;

  const report = (chunksSent: number, acceptedItems: number): void =>
    deps.onProgress?.({
      chunksSent,
      chunksTotal: chunks.length,
      acceptedItems,
    });

  // --- 1. begin -------------------------------------------------------------
  const begun = await post({
    protocolVersion: SYNC_PROTOCOL_VERSION,
    stage: "begin",
    importKey,
    snapshotHash,
    deviceId: snapshot.deviceId ?? UNMINTED_DEVICE_ID,
    declared: declaredCountsOf(snapshot),
  });
  if (!begun.ok) {
    await markGuestImportFailed(db, userId, importKey);
    return interrupted(importKey, begun.reason, begun.reasonCode);
  }
  if (begun.data.stage !== "begin") {
    // `postGuestMerge` already refuses a mismatched stage, so this is a type
    // narrowing rather than a runtime possibility.
    await markGuestImportFailed(db, userId, importKey);
    return interrupted(importKey, "invalid_response");
  }
  const beginBody = begun.data;

  if (beginBody.importStatus === "rejected") {
    await markGuestImportFailed(db, userId, importKey);
    return { status: "rejected", reasonCode: beginBody.reasonCode, importKey };
  }
  // --- 2. chunks ------------------------------------------------------------
  // Skip whatever the server already holds. `resumeFromChunk` is the server's
  // count, not this attempt's: a fresh key answers 0, a resumed one answers
  // where the interruption left it.
  //
  // An ALREADY-COMPLETED import (the same key + the same snapshot after success,
  // §12) sends no chunks and goes straight to `finalize`. It is tempting to
  // return `begin`'s stored summary here and stop — but `finalize` on a
  // completed row returns that same summary PLUS the durable `finalServerCursor`
  // and the stored list mappings, which `begin` does not carry and which local
  // finalisation needs to re-key its rows. Two exchanges instead of one, in
  // exchange for never having to special-case a half-informed success.
  let acceptedItems = beginBody.acceptedItems;
  const startChunk =
    beginBody.importStatus === "completed"
      ? chunks.length
      : beginBody.resumeFromChunk;
  report(Math.min(startChunk, chunks.length), acceptedItems);

  for (let index = startChunk; index < chunks.length; index++) {
    const body = chunks[index]!;
    const sent = await post({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      stage: "chunk",
      importKey,
      snapshotHash,
      chunkIndex: index,
      ...body,
    });
    if (!sent.ok) {
      await markGuestImportFailed(db, userId, importKey);
      return interrupted(importKey, sent.reason, sent.reasonCode);
    }
    if (sent.data.stage !== "chunk") {
      await markGuestImportFailed(db, userId, importKey);
      return interrupted(importKey, "invalid_response");
    }
    if (sent.data.importStatus === "rejected") {
      await markGuestImportFailed(db, userId, importKey);
      return {
        status: "rejected",
        reasonCode: sent.data.reasonCode,
        importKey,
      };
    }
    acceptedItems = sent.data.acceptedItems;
    // Persist the resume point BEFORE reporting it: progress the UI has seen but
    // the database has not would resume from the wrong chunk after a reload.
    await recordGuestImportProgress(db, userId, importKey, acceptedItems);
    report(index + 1, acceptedItems);
  }

  // --- 3. finalize ----------------------------------------------------------
  const finalized = await post({
    protocolVersion: SYNC_PROTOCOL_VERSION,
    stage: "finalize",
    importKey,
    snapshotHash,
  });
  if (!finalized.ok) {
    await markGuestImportFailed(db, userId, importKey);
    return interrupted(importKey, finalized.reason, finalized.reasonCode);
  }
  if (finalized.data.stage !== "finalize") {
    await markGuestImportFailed(db, userId, importKey);
    return interrupted(importKey, "invalid_response");
  }
  const body = finalized.data;

  if (body.result === "rejected") {
    await markGuestImportFailed(db, userId, importKey);
    return { status: "rejected", reasonCode: body.reasonCode, importKey };
  }
  if (body.result === "incomplete") {
    // Chunks were applied but finalisation could not conclude. Retryable under
    // the SAME key, and emphatically not a rollback.
    await markGuestImportFailed(db, userId, importKey);
    return {
      status: "interrupted",
      retryable: true,
      reasonCode: body.reasonCode,
      importKey,
    };
  }

  // NOT marked completed here. The server's merge is durable, but the LOCAL
  // finalisation (owner re-keying, guest cleanup) has not run yet, and §20
  // forbids the database claiming a completed merge while only half of the
  // ownership conversion committed. The finalisation step marks it, and until
  // it does, a reload correctly resumes into finalisation rather than into a
  // merge that looks done.
  report(chunks.length, acceptedItems);
  return {
    status: "completed",
    result: body.result,
    summary: body.summary,
    listIdMappings: body.listIdMappings,
    serverCursor: body.serverCursor,
    importKey,
  };
}
