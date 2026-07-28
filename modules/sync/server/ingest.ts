/**
 * Phase 16 — server-authoritative ingestion orchestrator (§8, §10-§15).
 *
 * Ingests a push batch's attempts + scheduling events into authoritative state.
 * For each component the whole flow runs in ONE transaction under a per-component
 * advisory lock so two online requests can never corrupt one component's chain:
 *
 *   dedup (idempotency) → resolve release + validate component (T5) → grade
 *   objectively / validate flashcard (T6) → canonical time (T7) → classify
 *   lineage (T8) → persist attempt + event → deterministic replay (T9-replay) →
 *   bump component revision + account cursor (LAST) → stamp last_sync_seq.
 *
 * The server never trusts client correctness/rating/time/lineage. Rejections
 * and corrections are audited (T11). The account cursor is bumped as the LAST
 * write in the transaction (after all row locks) to avoid lock-order deadlocks.
 *
 * `server-only`.
 */
import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { getDb, type Database } from "@/db/client";
import {
  reviewEvents,
  studyAttempts,
  studyComponents,
  studySessions,
} from "@/db/schema";
import { ChainError } from "@/modules/scheduler";
import {
  createQuestionContextFromRelease,
  type QuestionContext,
} from "@/modules/study-engine/generator";
import {
  isRecoverableReason,
  SYNC_BOUNDS,
  type SyncItemResult,
  type SyncReasonCode,
  type WireAttempt,
  type WireEvent,
} from "@/modules/sync/protocol";

import { writeSyncAudit } from "./audit";
import { countChainRoots, selectHead, type HeadCandidate } from "./chain-head";
import {
  computeCanonicalEventTime,
  type CanonicalTimeResult,
} from "./canonical-time";
import { componentFaultReason } from "./component-fault";
import { currentAccountCursor, nextAccountCursor, type SyncTx } from "./cursor";
import { gradeObjectiveAttempt, gradeFlashcardAttempt } from "./grade";
import { payloadHash } from "./idempotency";
import {
  classifyLineage,
  classifyMergeLineage,
  type LineageClassification,
  mergeUnionContext,
} from "./lineage";
import { resolveReleaseForIngestion, type ReleaseLoadOptions } from "./release";
import {
  type ComponentMergeMark,
  type ComponentReplayEvent,
  replayComponent,
} from "./replay";
import { validateComponent } from "./validate-component";

/**
 * The SERVER-INTERNAL merge ingestion mode (Phase 17 §13). Its presence on
 * {@link IngestOptions} is what turns an ingest call into a guest→account
 * import; its absence is ordinary Phase 16 push, unchanged.
 *
 * §13 requires that "any merge-specific ingestion mode must be server-internal
 * and reachable only through the authenticated merge coordinator", so this is
 * deliberately NOT a wire field and NOT derivable from a request. `pushRequest
 * Schema` has no member that could produce one, and `app/api/sync/push/route.ts`
 * constructs its options literally (`{ nowMs, correlationId }`) rather than
 * spreading the decoded body, so there is no path by which a client can set it.
 * The only caller that may is the merge coordinator, which obtains `importId`
 * from the `guest_imports` row it holds — a row the server created against a
 * session-derived account.
 *
 * What it buys is EVENT-SCOPED provenance: every review event written under it
 * is stamped `imported_from_guest_import_id`, and that stamp — not the
 * component's `merged_at` — is what makes `classifyForEvent` judge the event by
 * the union rule. See the note on {@link classifyForEvent} for why the scope has
 * to be the event.
 *
 * ATTEMPTS ARE NOT STAMPED, deliberately. `study_attempts` has no provenance
 * column and this slice does not add one: the marker exists to select a LINEAGE
 * rule, and attempts have no lineage — they are flat history hanging off a
 * component, with no parent, no revision and nothing to classify. An import's
 * attempts are already recoverable through the events that reference them and
 * through `guest_imports` itself, so a column here would carry a fact nothing
 * reads, on the largest table the merge writes.
 */
export type GuestImportIngestion = {
  /** `guest_imports.id` — the import this history is arriving under. */
  importId: string;
};

export type IngestOptions = ReleaseLoadOptions & {
  /** Injected server-receipt clock (epoch ms) — never Date.now(). */
  nowMs: number;
  /** Correlation id for the request, recorded in audit rows. */
  correlationId?: string;
  /**
   * Present ONLY when the authenticated guest-merge coordinator is driving this
   * call (§13). See {@link GuestImportIngestion}: server-internal, never wire.
   */
  guestImport?: GuestImportIngestion;
  /**
   * Override the per-component pending-parent cap (EXT-F4). Defaults to
   * SYNC_BOUNDS.maxPendingPerComponent; injectable so operators can tune it and
   * tests can exercise the boundary without seeding hundreds of rows.
   */
  maxPendingPerComponent?: number;
  /**
   * Override the per-request pending-parent promotion budget. Defaults to
   * MAX_PENDING_REPROCESS; injectable for the same reason as the cap above — the
   * boundary is worth a test, and seeding a thousand held rows to reach it would
   * make that test slow enough that nobody would keep it.
   */
  maxPendingReprocess?: number;
};

export type IngestResult = {
  results: SyncItemResult[];
  /** The account cursor after ingestion (unchanged if nothing was accepted). */
  serverCursor: number;
};

const OBJECTIVE_MODES = new Set(["mc", "timed", "test", "timed_test"]);

/**
 * Upper bound on how many held `pending_parent` children a single request may
 * promote (§14.2, T9c). A very long held chain finishing all at once would make
 * one transaction do unbounded work; capping it keeps each request bounded, and
 * any remainder is promoted by the next request that touches the component. Set
 * well above any realistic held depth.
 */
const MAX_PENDING_REPROCESS = 1000;

/** A row loaded from review_events that we reason about during ingestion. */
type EventRow = typeof reviewEvents.$inferSelect;

function reject(
  item: { itemId: string; itemKind: SyncItemResult["itemKind"] },
  reasonCode: SyncReasonCode,
  extra: Partial<SyncItemResult> = {},
): SyncItemResult {
  return {
    itemId: item.itemId,
    itemKind: item.itemKind,
    status: "rejected",
    reasonCode,
    duplicate: false,
    recoverable: isRecoverableReason(reasonCode),
    ...extra,
  };
}

/**
 * In-memory view of a component's accepted chain, updated as events are accepted
 * within the same transaction so a second event parented on the first is
 * recognised as sequential (§14.1).
 */
type ChainState = {
  headEventId: string | null;
  headRevision: number;
  headCanonicalMs: number | null;
  acceptedEventIds: Set<string>;
  parentByEventId: Map<string, string | null>;
  pendingEventIds: Set<string>;
  /** Accepted scheduling events for replay (canonical fields). */
  accepted: ComponentReplayEvent[];
};

/**
 * Recompute the in-memory head after an acceptance, from the accepted set as it
 * now stands (Phase 17 §14).
 *
 * Phase 16 could assign `head = the event just accepted`, because an event was
 * only ever accepted for extending the head and carrying the next revision, so
 * it always WAS the new head. A merged component breaks that: an imported guest
 * event can be accepted while the account's later event remains the
 * chronological head, and taking the new arrival as head would then hand the
 * next client the wrong parent and reject the review it derives from it.
 *
 * So the head is re-derived through the shared shape-aware rule rather than
 * inferred from the acceptance. For a single-rooted component `selectHead` IS
 * the highest-revision event — the one just accepted — so this is Phase 16's
 * answer, arrived at without assuming it. Cost is linear in the component's
 * accepted events per acceptance, and both the batch and the component are
 * already bounded (SYNC_BOUNDS, MAX_PENDING_REPROCESS).
 */
/**
 * The accepted set reduced to what shape analysis needs. One mapping, used by
 * both head selection and root counting, so the two can never disagree about
 * which events they are looking at.
 */
function headCandidatesOf(
  accepted: readonly ComponentReplayEvent[],
): HeadCandidate[] {
  return accepted.map((event) => ({
    eventId: event.eventId,
    clientComponentRevision: event.clientComponentRevision,
    canonicalMs: event.occurredAtCanonical.getTime(),
    parentEventId: event.parentEventId,
  }));
}

function refreshChainHead(chain: ChainState): void {
  const head = selectHead(headCandidatesOf(chain.accepted));
  chain.headEventId = head?.eventId ?? null;
  chain.headCanonicalMs = head?.canonicalMs ?? null;
  // The HEAD'S OWN revision, not the union's maximum. Contiguity is enforced by
  // replay PER CHAIN — `partitionScheduling` requires a complete chain's
  // revisions to be exactly contiguous — so an event extending the head must be
  // one past the head, not one past the longest other history. Pairing it with
  // the union maximum makes the server accept an event that the very next replay
  // then throws on, because it leaves a gap in the head's own chain.
  chain.headRevision = head?.clientComponentRevision ?? 0;
}

/**
 * Which lineage rule THIS EVENT is judged by (Phase 17 §14).
 *
 * Scoped to the event, not to the component. `study_components.merged_at` grants
 * the right to REPLAY a union that already exists; it deliberately does not
 * decide how new arrivals are classified. Were it to, a component would become
 * permanently easier to write to the moment it was merged once: any device could
 * keep adding fresh roots to it through ordinary push, forever, with none of
 * Phase 16's stale-branch or fork rejection — and §14 says the merge behaviour
 * must not be available to ordinary sync requests. "Ordinary sync requests, on a
 * component that was merged once, for the rest of time" is not an exception to
 * that sentence.
 *
 * So `isImported` comes from the EVENT's own
 * `review_events.imported_from_guest_import_id`, written only by the merge
 * coordinator. An ordinary push carries no such marker and is judged by Phase
 * 16's rule whatever the component's history — while an imported event held
 * behind a non-head guest parent is still promotable, which is the case that
 * needed the union rule in the first place.
 *
 * The union context is rebuilt per call from `chain.accepted`, which is server
 * state — rows loaded under the transaction's lock plus events this transaction
 * has itself accepted. Nothing decoded from the request reaches it.
 */
function classifyForEvent(
  chain: ChainState,
  isImported: boolean,
  candidate: {
    eventId: string;
    parentEventId: string | null;
    clientComponentRevision: number;
  },
): LineageClassification {
  const acceptedChain = {
    headEventId: chain.headEventId,
    headRevision: chain.headRevision,
    acceptedEventIds: chain.acceptedEventIds,
  };
  const knownEvents = {
    parentByEventId: chain.parentByEventId,
    pendingEventIds: chain.pendingEventIds,
  };
  if (!isImported) {
    return classifyLineage(candidate, acceptedChain, knownEvents);
  }
  return classifyMergeLineage(
    candidate,
    acceptedChain,
    knownEvents,
    mergeUnionContext(chain.accepted),
  );
}

function buildChainState(rows: EventRow[]): ChainState {
  const acceptedEventIds = new Set<string>();
  const pendingEventIds = new Set<string>();
  const parentByEventId = new Map<string, string | null>();
  const accepted: ComponentReplayEvent[] = [];
  const headCandidates: HeadCandidate[] = [];

  for (const row of rows) {
    parentByEventId.set(row.eventId, row.parentEventId);
    if (row.status === "scheduling") {
      acceptedEventIds.add(row.eventId);
      accepted.push({
        eventId: row.eventId,
        status: "scheduling",
        rating: row.rating as ComponentReplayEvent["rating"],
        clientComponentRevision: row.clientComponentRevision,
        parentEventId: row.parentEventId,
        occurredAtCanonical: row.occurredAtCanonical,
        localDateAtEvent: row.localDateAtEvent,
      });
      headCandidates.push({
        eventId: row.eventId,
        clientComponentRevision: row.clientComponentRevision,
        canonicalMs: row.occurredAtCanonical.getTime(),
        parentEventId: row.parentEventId,
      });
    } else if (row.status === "pending_parent") {
      pendingEventIds.add(row.eventId);
    }
  }

  // Head selection is shape-aware (./chain-head.ts): an ordinary single-rooted
  // chain keeps Phase 16's structural highest-revision tip, and only a MERGED
  // (multi-rooted) component uses the chronological rule the client's
  // `chainHead` applies to a union.
  const head = selectHead(headCandidates);

  return {
    headEventId: head?.eventId ?? null,
    // What a new event extending the head must be one past: the HEAD'S OWN
    // revision. Not the union maximum — replay checks contiguity per chain, so
    // an event one past the longest OTHER history leaves a gap in the chain it
    // actually joins, and the next replay throws on it. See refreshChainHead.
    headRevision: head?.clientComponentRevision ?? 0,
    headCanonicalMs: head?.canonicalMs ?? null,
    acceptedEventIds,
    parentByEventId,
    pendingEventIds,
    accepted,
  };
}

/**
 * Find (or create, under the held advisory lock) the study_components row for a
 * validated component, returning its id and current revision.
 */
async function findOrCreateComponent(
  tx: SyncTx,
  userId: string,
  identity: {
    entryId: number;
    skillType: string;
    componentShape: string;
    sourceField: string | null;
    direction: string | null;
  },
): Promise<{ id: string; revision: number; mergedAt: Date | null }> {
  const [existing] = await tx
    .select({
      id: studyComponents.id,
      revision: studyComponents.revision,
      // Phase 17 §14: whether this component is permitted to hold a union. Read
      // under the same FOR UPDATE lock as the revision, so replay's tolerance
      // and the row it is about cannot be decided from different snapshots.
      mergedAt: studyComponents.mergedAt,
    })
    .from(studyComponents)
    .where(
      and(
        eq(studyComponents.userId, userId),
        eq(studyComponents.entryId, identity.entryId),
        eq(studyComponents.skillTypeId, identity.skillType),
        identity.sourceField === null
          ? sql`${studyComponents.sourceField} IS NULL`
          : eq(studyComponents.sourceField, identity.sourceField),
        identity.direction === null
          ? sql`${studyComponents.direction} IS NULL`
          : eq(studyComponents.direction, identity.direction),
      ),
    )
    .for("update");
  if (existing) return existing;

  const [created] = await tx
    .insert(studyComponents)
    .values({
      userId,
      entryId: identity.entryId,
      skillTypeId: identity.skillType,
      componentShape: identity.componentShape,
      sourceField: identity.sourceField,
      direction: identity.direction,
    })
    .returning({
      id: studyComponents.id,
      revision: studyComponents.revision,
      mergedAt: studyComponents.mergedAt,
    });
  if (!created)
    throw new Error("ingest: study_components insert returned no row");
  return created;
}

/** The client-immutable fields of an event, hashed for conflict detection. */
function eventPayload(ev: WireEvent): Record<string, unknown> {
  return {
    eventId: ev.eventId,
    studyComponentId: ev.studyComponentId,
    attemptId: ev.attemptId,
    parentEventId: ev.parentEventId,
    clientComponentRevision: ev.clientComponentRevision,
    baseServerRevision: ev.baseServerRevision,
    occurredAtClient: ev.occurredAtClient,
    deviceId: ev.deviceId,
    clientSequence: ev.clientSequence,
    releaseId: ev.releaseId,
    contentVersion: ev.contentVersion,
  };
}

/**
 * The client-immutable fields of an attempt, hashed for conflict detection.
 * Excludes `isCorrect`/`correctAnswerRef` — those are server-canonical (§8.1),
 * so a client changing its claim must NOT read as a payload change.
 */
function attemptPayload(att: WireAttempt): Record<string, unknown> {
  return {
    id: att.id,
    sessionId: att.sessionId,
    deviceId: att.deviceId,
    studyComponentId: att.studyComponentId,
    entryId: att.entryId,
    skillTypeId: att.skillTypeId,
    sourceField: att.sourceField,
    direction: att.direction,
    promptField: att.promptField,
    promptRef: att.promptRef,
    selectedAnswerRef: att.selectedAnswerRef,
    isFirstAttempt: att.isFirstAttempt,
    isReinforcement: att.isReinforcement,
    hintUsed: att.hintUsed,
    hintType: att.hintType,
    responseTimeMs: att.responseTimeMs,
    questionPosition: att.questionPosition,
    mode: att.mode,
    optionCount: att.optionCount,
    perQuestionLimitMs: att.perQuestionLimitMs,
    questionInstanceId: att.questionInstanceId,
    questionSeed: att.questionSeed,
    questionGeneratorVersion: att.questionGeneratorVersion,
    releaseId: att.releaseId,
    contentVersion: att.contentVersion,
    occurredAtUtc: att.occurredAtUtc,
    timezoneAtEvent: att.timezoneAtEvent,
    utcOffsetMinutesAtEvent: att.utcOffsetMinutesAtEvent,
    localDateAtEvent: att.localDateAtEvent,
    timezoneSource: att.timezoneSource,
  };
}

/**
 * Whether an attempt id already exists with a DIFFERENT immutable payload — a
 * reused id under a fresh event id (the event-level dedup would miss it). The
 * caller rejects the event as a payload_conflict + audits it.
 */
async function attemptPayloadConflicts(
  tx: SyncTx,
  attemptId: string,
  hash: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ hash: studyAttempts.idempotencyPayloadHash })
    .from(studyAttempts)
    .where(eq(studyAttempts.id, attemptId));
  return row !== undefined && row.hash !== hash;
}

/**
 * Ensure a minimal study_sessions row exists for the attempt's session id, so
 * the attempt's session_id FK resolves. Full session sync (aggregates) is not a
 * Phase 16 concern; this is an idempotent placeholder keyed by the client's
 * session id.
 */
async function ensureSession(
  tx: SyncTx,
  userId: string,
  att: WireAttempt,
  startedAt: Date,
): Promise<void> {
  await tx
    .insert(studySessions)
    .values({
      id: att.sessionId,
      userId,
      mode: att.mode,
      config: {},
      releaseId: att.releaseId,
      contentVersion: att.contentVersion,
      startedAt,
    })
    .onConflictDoNothing({ target: studySessions.id });
  // Defence in depth: a client-supplied session id that already exists under a
  // DIFFERENT account must never be linked to this user's attempt (the upsert
  // silently no-ops on conflict). Throwing here aborts the component tx and the
  // batch loop isolates it into a safe internal_error for the item.
  const [session] = await tx
    .select({ userId: studySessions.userId })
    .from(studySessions)
    .where(eq(studySessions.id, att.sessionId));
  if (session && session.userId !== userId) {
    throw new Error("ingest: session id belongs to a different account");
  }
}

/**
 * Persist the graded attempt with the server-canonical correctness/answer.
 *
 * PRECONDITION (R2-F4, CLEAN-001): call this ONLY after EVERY rejection path
 * for the item has passed — including the pending-branch global cross-parent
 * lookup and the per-component live-pending quota check. `study_attempts` is
 * NOT bounded by the pending cap, so persisting before those checks lets an
 * authenticated client grow the table without limit by pairing unique valid
 * attempts with quota-/cross-parent-rejected events. Both call sites are
 * positioned after their rejection paths; keep any new call site there too.
 */
async function persistAttempt(
  tx: SyncTx,
  userId: string,
  componentRowId: string,
  att: WireAttempt,
  canonical: { isCorrect: boolean; correctAnswerRef: unknown },
  canonicalTime: CanonicalTimeResult,
): Promise<void> {
  await ensureSession(
    tx,
    userId,
    att,
    new Date(canonicalTime.occurredAtCanonicalMs),
  );
  await tx
    .insert(studyAttempts)
    .values({
      id: att.id,
      userId,
      sessionId: att.sessionId,
      studyComponentId: componentRowId,
      entryId: att.entryId,
      skillTypeId: att.skillTypeId,
      sourceField: att.sourceField,
      direction: att.direction,
      promptField: att.promptField,
      promptRef: att.promptRef,
      selectedAnswerRef: att.selectedAnswerRef,
      // SERVER-CANONICAL correctness + correct answer (never the client claim).
      correctAnswerRef: canonical.correctAnswerRef,
      isCorrect: canonical.isCorrect,
      isFirstAttempt: att.isFirstAttempt,
      isReinforcement: att.isReinforcement,
      hintUsed: att.hintUsed,
      hintType: att.hintType,
      responseTimeMs: att.responseTimeMs,
      questionPosition: att.questionPosition,
      mode: att.mode,
      optionCount: att.optionCount,
      perQuestionLimitMs: att.perQuestionLimitMs,
      questionInstanceId: att.questionInstanceId,
      questionSeed: att.questionSeed,
      questionGeneratorVersion: att.questionGeneratorVersion,
      occurredAtUtc: new Date(att.occurredAtUtc),
      timezoneAtEvent: canonicalTime.timezoneAtEvent,
      utcOffsetMinutesAtEvent: canonicalTime.utcOffsetMinutesAtEvent,
      localDateAtEvent: canonicalTime.localDateAtEvent,
      timezoneSource: canonicalTime.timezoneSource,
      deviceId: att.deviceId,
      releaseId: att.releaseId,
      contentVersion: att.contentVersion,
      idempotencyPayloadHash: payloadHash(attemptPayload(att)),
    })
    // Duplicate attempt id (already stored) → keep the first canonical row.
    .onConflictDoNothing({ target: studyAttempts.id });
}

/**
 * Persist a review event with server-canonical rating/time and the given status.
 *
 * `importedFromGuestImportId` is the event's own merge provenance (§14): the id
 * of the import that wrote it, or null for every ordinary push. It is a REQUIRED
 * parameter rather than an optional one on purpose — a default would let a new
 * call site write an unprovenanced event by saying nothing, and this column is
 * what decides which lineage rule the event is later judged by.
 */
async function persistEvent(
  tx: SyncTx,
  userId: string,
  componentRowId: string,
  ev: WireEvent,
  rating: string,
  status: "scheduling" | "pending_parent",
  canonicalTime: CanonicalTimeResult,
  importedFromGuestImportId: string | null,
  // EXT-F4: when held as pending_parent, the instant this hold expires (never
  // promoted after, purgeable). Null for an accepted scheduling event.
  pendingExpiresAt: Date | null = null,
): Promise<void> {
  await tx.insert(reviewEvents).values({
    eventId: ev.eventId,
    userId,
    studyComponentId: componentRowId,
    attemptId: ev.attemptId,
    rating,
    status,
    pendingExpiresAt,
    baseServerRevision: ev.baseServerRevision,
    parentEventId: ev.parentEventId,
    clientComponentRevision: ev.clientComponentRevision,
    occurredAtClient: new Date(ev.occurredAtClient),
    occurredAtCanonical: new Date(canonicalTime.occurredAtCanonicalMs),
    deviceId: ev.deviceId,
    clientSequence: ev.clientSequence,
    sessionId: ev.sessionId,
    releaseId: ev.releaseId,
    contentVersion: ev.contentVersion,
    timezoneAtEvent: canonicalTime.timezoneAtEvent,
    utcOffsetMinutesAtEvent: canonicalTime.utcOffsetMinutesAtEvent,
    localDateAtEvent: canonicalTime.localDateAtEvent,
    timezoneSource: canonicalTime.timezoneSource,
    timezoneCorrected: canonicalTime.timezoneCorrected,
    clockSuspect: canonicalTime.clockSuspect,
    idempotencyPayloadHash: payloadHash(eventPayload(ev)),
    importedFromGuestImportId,
  });
}

/**
 * A release resolved for this batch: either the question context built from it,
 * or the reason it could not be used. The two are one value deliberately.
 *
 * Caching only the context and re-deriving the reason at each rejection site is
 * what let a revoked release be reported as `revoked_release` in one place and
 * `invalid_release` in another (T20): two independent recoveries of the same
 * fact drifted apart. Keeping the reason alongside the context makes the pair
 * impossible to disagree, and makes "resolved but unusable" unrepresentable.
 */
type ResolvedRelease =
  | { context: QuestionContext; reasonCode: null }
  | { context: null; reasonCode: SyncReasonCode };

/**
 * Resolve a release for this batch ONCE, keeping both halves of the outcome.
 * Shared by the event path and the reinforcement-attempt path so a batch never
 * re-reads or re-hashes the same release's artifacts (§30), and so every
 * rejection that follows names the same reason.
 */
async function resolveReleaseCached(
  cache: Map<string, ResolvedRelease>,
  releaseId: string,
  options: IngestOptions,
): Promise<ResolvedRelease> {
  const cached = cache.get(releaseId);
  if (cached) return cached;
  const resolved = await resolveReleaseForIngestion(releaseId, options);
  const entry: ResolvedRelease = resolved.ok
    ? {
        context: createQuestionContextFromRelease(resolved.release.learner),
        reasonCode: null,
      }
    : { context: null, reasonCode: resolved.reasonCode };
  cache.set(releaseId, entry);
  return entry;
}

/**
 * Process one component's scheduling events (sorted by revision) inside a single
 * advisory-locked transaction. Returns the per-item results; the account cursor
 * is bumped LAST if anything was accepted.
 */
async function processComponentGroup(
  db: Database,
  userId: string,
  componentKey: string,
  events: WireEvent[],
  attemptsById: Map<string, WireAttempt>,
  options: IngestOptions,
  contextCache: Map<string, ResolvedRelease>,
): Promise<SyncItemResult[]> {
  const sorted = [...events].sort(
    (a, b) => a.clientComponentRevision - b.clientComponentRevision,
  );

  // Whether the merge coordinator is driving this call (§13). Read ONCE, here,
  // from the server-internal option, and used for all three of: which lineage
  // rule each event is judged by, the provenance stamped on each written row,
  // and whether a union this transaction creates may be authorised. Deriving it
  // once means those three cannot disagree — an event judged by the union rule
  // is by construction an event written with an import id.
  const guestImportId = options.guestImport?.importId ?? null;
  const isImported = guestImportId !== null;

  function resolveRelease(
    tx: SyncTx,
    releaseId: string,
  ): Promise<ResolvedRelease> {
    void tx;
    return resolveReleaseCached(contextCache, releaseId, options);
  }

  return db.transaction(async (tx) => {
    // Serialise all online requests touching this component's chain.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${userId}:${componentKey}`}), 0)`,
    );

    // Validate the component identity from the first event's attempt.
    const firstAttempt = attemptsById.get(sorted[0]?.attemptId ?? "");
    if (!firstAttempt) {
      return sorted.map((ev) =>
        reject({ itemId: ev.eventId, itemKind: "event" }, "malformed_item"),
      );
    }
    const groupRelease = await resolveRelease(tx, firstAttempt.releaseId);
    if (!groupRelease.context) {
      const code = groupRelease.reasonCode;
      return Promise.all(
        sorted.map(async (ev) => {
          await writeSyncAudit(tx, {
            userId,
            itemKind: "event",
            itemId: ev.eventId,
            reasonCode: code,
            severity: "warning",
            releaseId: ev.releaseId,
            componentKey,
            correlationId: options.correlationId,
          });
          return reject({ itemId: ev.eventId, itemKind: "event" }, code);
        }),
      );
    }
    const context = groupRelease.context;
    const validation = validateComponent(context, {
      componentKey,
      entryId: firstAttempt.entryId,
      skillType: firstAttempt.skillTypeId,
      sourceField: firstAttempt.sourceField,
      direction: firstAttempt.direction,
    });
    if (!validation.ok) {
      return Promise.all(
        sorted.map(async (ev) => {
          await writeSyncAudit(tx, {
            userId,
            itemKind: "event",
            itemId: ev.eventId,
            reasonCode: validation.reasonCode,
            severity: "warning",
            releaseId: ev.releaseId,
            componentKey,
            correlationId: options.correlationId,
          });
          return reject(
            { itemId: ev.eventId, itemKind: "event" },
            validation.reasonCode,
          );
        }),
      );
    }
    const identity = validation.identity;

    const component = await findOrCreateComponent(tx, userId, {
      entryId: identity.entryId,
      skillType: identity.skillType,
      componentShape: identity.componentShape,
      sourceField: identity.sourceField,
      direction: identity.direction,
    });

    const existingRows = await tx
      .select()
      .from(reviewEvents)
      .where(eq(reviewEvents.studyComponentId, component.id));
    const rowById = new Map(existingRows.map((r) => [r.eventId, r]));
    const chain = buildChainState(existingRows);

    // EXT-F4 (REL-001): the pending cap counts only LIVE (non-expired) holds —
    // an expired row is never promoted and must not permanently consume a quota
    // slot (a purge job reclaims the row later). Seed from the stored non-expired
    // pending rows; increment as this batch adds new holds.
    const pendingCap =
      options.maxPendingPerComponent ?? SYNC_BOUNDS.maxPendingPerComponent;
    let livePendingCount = existingRows.filter(
      (r) =>
        r.status === "pending_parent" &&
        (r.pendingExpiresAt === null ||
          r.pendingExpiresAt.getTime() >= options.nowMs),
    ).length;

    const results: SyncItemResult[] = [];
    const acceptedThisBatch: string[] = [];
    let changed = false;

    for (const ev of sorted) {
      const att = attemptsById.get(ev.attemptId);
      if (!att) {
        results.push(
          reject({ itemId: ev.eventId, itemKind: "event" }, "malformed_item"),
        );
        continue;
      }

      // 1. Idempotency: a re-delivered event id is a duplicate if the payload
      //    matches, or a payload_conflict if it differs.
      const newHash = payloadHash(eventPayload(ev));
      const existing = rowById.get(ev.eventId);
      if (existing) {
        if (existing.idempotencyPayloadHash === newHash) {
          results.push({
            itemId: ev.eventId,
            itemKind: "event",
            status: "duplicate",
            reasonCode: "duplicate",
            duplicate: true,
            recoverable: false,
            componentKey,
            serverRevision: component.revision,
          });
        } else {
          await writeSyncAudit(tx, {
            userId,
            itemKind: "event",
            itemId: ev.eventId,
            reasonCode: "payload_conflict",
            severity: "critical",
            componentKey,
            correlationId: options.correlationId,
          });
          results.push(
            reject(
              { itemId: ev.eventId, itemKind: "event" },
              "payload_conflict",
            ),
          );
        }
        continue;
      }

      // 2. Grade (objective) or validate the flashcard rating.
      //
      // This item's OWN release, which need not be the one the group's context
      // came from. It carries its own reason code, so an item that happens not
      // to be first in its component group is not told "this release is
      // unknown" when the truth is "this release was withdrawn" — only one of
      // those tells an operator that a release they revoked is still arriving,
      // and only one is recoverable by shipping the artifacts again.
      const itemRelease = await resolveRelease(tx, att.releaseId);
      if (!itemRelease.context) {
        const code = itemRelease.reasonCode;
        await writeSyncAudit(tx, {
          userId,
          itemKind: "event",
          itemId: ev.eventId,
          reasonCode: code,
          severity: "warning",
          releaseId: ev.releaseId,
          componentKey,
          correlationId: options.correlationId,
        });
        results.push(reject({ itemId: ev.eventId, itemKind: "event" }, code));
        continue;
      }
      const ctx = itemRelease.context;

      // EXT-F5: validate THIS event/attempt pair independently. The group's
      // component identity was derived from the FIRST attempt only; every later
      // attempt must AGREE with its own event and re-derive the group component,
      // or a crafted multi-event batch could persist attempt/history rows whose
      // fields contradict the component they are attached to. First, the
      // immutable event/attempt fields must be equal (and the attempt's declared
      // component must be this group's):
      if (
        att.studyComponentId !== componentKey ||
        att.studyComponentId !== ev.studyComponentId ||
        att.sessionId !== ev.sessionId ||
        att.deviceId !== ev.deviceId ||
        att.releaseId !== ev.releaseId ||
        att.contentVersion !== ev.contentVersion
      ) {
        await writeSyncAudit(tx, {
          userId,
          itemKind: "event",
          itemId: ev.eventId,
          reasonCode: "malformed_item",
          severity: "warning",
          componentKey,
          correlationId: options.correlationId,
        });
        results.push(
          reject({ itemId: ev.eventId, itemKind: "event" }, "malformed_item"),
        );
        continue;
      }
      // Then the attempt's OWN natural key must derive this component against the
      // release manifest — not inherited from the first attempt's validation.
      const attemptValidation = validateComponent(ctx, {
        componentKey: att.studyComponentId,
        entryId: att.entryId,
        skillType: att.skillTypeId,
        sourceField: att.sourceField,
        direction: att.direction,
      });
      if (!attemptValidation.ok) {
        await writeSyncAudit(tx, {
          userId,
          itemKind: "event",
          itemId: ev.eventId,
          reasonCode: attemptValidation.reasonCode,
          severity: "warning",
          releaseId: ev.releaseId,
          componentKey,
          correlationId: options.correlationId,
        });
        results.push(
          reject(
            { itemId: ev.eventId, itemKind: "event" },
            attemptValidation.reasonCode,
          ),
        );
        continue;
      }

      let canonicalIsCorrect: boolean;
      let canonicalRating: string;
      let canonicalCorrectAnswer: unknown;
      let correctnessCorrected = false;

      if (att.mode === "flashcard") {
        // Flashcards are self-rated; the wire rating must be Again/Good (§11).
        if (ev.rating !== "again" && ev.rating !== "good") {
          await writeSyncAudit(tx, {
            userId,
            itemKind: "event",
            itemId: ev.eventId,
            reasonCode: "unsupported_rating",
            severity: "warning",
            componentKey,
            correlationId: options.correlationId,
          });
          results.push(
            reject(
              { itemId: ev.eventId, itemKind: "event" },
              "unsupported_rating",
            ),
          );
          continue;
        }
        canonicalIsCorrect = att.isCorrect;
        canonicalRating = gradeFlashcardAttempt(att.isCorrect).rating;
        canonicalCorrectAnswer = att.correctAnswerRef;
      } else if (OBJECTIVE_MODES.has(att.mode)) {
        const grade = gradeObjectiveAttempt(ctx, {
          identity,
          mode: att.mode as "mc" | "timed" | "test" | "timed_test",
          questionSeed: att.questionSeed,
          questionPosition: att.questionPosition,
          optionCount: att.optionCount,
          promptField: att.promptField,
          questionInstanceId: att.questionInstanceId,
          questionGeneratorVersion: att.questionGeneratorVersion,
          selectedAnswerRef: att.selectedAnswerRef,
          hintUsed: att.hintUsed,
          claimedIsCorrect: att.isCorrect,
        });
        if (!grade.ok) {
          await writeSyncAudit(tx, {
            userId,
            itemKind: "event",
            itemId: ev.eventId,
            reasonCode: grade.reasonCode,
            severity: "warning",
            releaseId: ev.releaseId,
            componentKey,
            correlationId: options.correlationId,
          });
          results.push(
            reject({ itemId: ev.eventId, itemKind: "event" }, grade.reasonCode),
          );
          continue;
        }
        canonicalIsCorrect = grade.isCorrect;
        canonicalRating = grade.rating;
        canonicalCorrectAnswer = grade.correctAnswerRef;
        correctnessCorrected = grade.correctnessCorrected;
      } else {
        results.push(
          reject({ itemId: ev.eventId, itemKind: "event" }, "malformed_item"),
        );
        continue;
      }

      // 3. Canonical event time (§13).
      const canonicalTime = computeCanonicalEventTime({
        occurredAtClient: ev.occurredAtClient,
        timezoneAtEvent: ev.timezoneAtEvent,
        utcOffsetMinutesAtEvent: ev.utcOffsetMinutesAtEvent,
        localDateAtEvent: ev.localDateAtEvent,
        timezoneSource: ev.timezoneSource,
        serverReceivedAtMs: options.nowMs,
        previousAcceptedCanonicalMs: chain.headCanonicalMs,
      });

      // 4. Lineage classification (§14). Judged by the union rule only when the
      // SERVER-INTERNAL merge mode is driving this call — which is exactly when
      // this event is about to be written with that import's provenance below.
      // An ordinary push has no `guestImport`, so it keeps Phase 16's rule on
      // every component, merged or not.
      const lineage = classifyForEvent(chain, isImported, {
        eventId: ev.eventId,
        parentEventId: ev.parentEventId,
        clientComponentRevision: ev.clientComponentRevision,
      });

      if (lineage.decision === "reject") {
        await writeSyncAudit(tx, {
          userId,
          itemKind: "event",
          itemId: ev.eventId,
          reasonCode: lineage.reasonCode,
          severity: "warning",
          componentKey,
          correlationId: options.correlationId,
        });
        results.push(
          reject(
            { itemId: ev.eventId, itemKind: "event" },
            lineage.reasonCode,
            { canonicalOccurredAt: canonicalTime.occurredAtCanonical },
          ),
        );
        continue;
      }

      // A reused attempt id under a fresh event id with a different immutable
      // payload is a conflict (the event dedup above would miss it) — reject +
      // audit, mirroring the event payload_conflict path (§8.5).
      if (
        await attemptPayloadConflicts(
          tx,
          att.id,
          payloadHash(attemptPayload(att)),
        )
      ) {
        await writeSyncAudit(tx, {
          userId,
          itemKind: "attempt",
          itemId: att.id,
          reasonCode: "payload_conflict",
          severity: "critical",
          componentKey,
          correlationId: options.correlationId,
        });
        results.push(
          reject({ itemId: ev.eventId, itemKind: "event" }, "payload_conflict"),
        );
        continue;
      }

      // R2-F4: for a PENDING event, run every rejection check (global parent
      // existence + per-component pending quota) BEFORE persisting the attempt.
      // Otherwise a rejected pending event leaves its attempt row committed —
      // and the attempt table, unlike the event table, is NOT bounded by the
      // pending cap, so an authenticated client could grow it without limit by
      // pairing unique valid attempts with quota-/cross-parent-rejected events.
      // The attempt is persisted only once the event is guaranteed to be
      // accepted or legitimately held.
      if (lineage.decision === "pending") {
        // EXT-F4: the parent is unknown WITHIN this component. Look it up
        // globally to distinguish a genuinely-nonexistent parent (legitimately
        // held) from one that EXISTS but belongs to another component or user —
        // the latter is never a valid parent and must be rejected, not held
        // forever (classifyLineage cannot see it, because ingest only loads the
        // current component's events).
        if (ev.parentEventId !== null) {
          const [parentRow] = await tx
            .select({
              ownerId: reviewEvents.userId,
              componentRowId: reviewEvents.studyComponentId,
            })
            .from(reviewEvents)
            .where(eq(reviewEvents.eventId, ev.parentEventId))
            .limit(1);
          if (
            parentRow &&
            (parentRow.ownerId !== userId ||
              parentRow.componentRowId !== component.id)
          ) {
            const crossCode: SyncReasonCode =
              parentRow.ownerId !== userId
                ? "cross_user_parent"
                : "cross_component_parent";
            await writeSyncAudit(tx, {
              userId,
              itemKind: "event",
              itemId: ev.eventId,
              reasonCode: crossCode,
              severity: "warning",
              componentKey,
              correlationId: options.correlationId,
            });
            results.push(
              reject({ itemId: ev.eventId, itemKind: "event" }, crossCode),
            );
            continue;
          }
          // else: the parent genuinely does not exist yet, or is itself a
          // pending row in THIS component — a legitimate hold; fall through.
        }

        // EXT-F4: bound the per-component LIVE pending backlog. Once it reaches
        // the cap, refuse to pin more storage with events whose parents may
        // never arrive (expired holds don't count — see livePendingCount).
        if (livePendingCount >= pendingCap) {
          await writeSyncAudit(tx, {
            userId,
            itemKind: "event",
            itemId: ev.eventId,
            reasonCode: "pending_quota_exceeded",
            severity: "warning",
            componentKey,
            correlationId: options.correlationId,
          });
          results.push(
            reject(
              { itemId: ev.eventId, itemKind: "event" },
              "pending_quota_exceeded",
            ),
          );
          continue;
        }
      }

      // Persist the attempt with the server-canonical correctness/answer. Only
      // reached once every rejection path above — INCLUDING the pending-branch
      // parent/quota checks — has passed, so a rejected event never leaves a
      // committed attempt (R2-F4).
      await persistAttempt(
        tx,
        userId,
        component.id,
        att,
        {
          isCorrect: canonicalIsCorrect,
          correctAnswerRef: canonicalCorrectAnswer,
        },
        canonicalTime,
      );

      if (lineage.decision === "pending") {
        await persistEvent(
          tx,
          userId,
          component.id,
          ev,
          canonicalRating,
          "pending_parent",
          canonicalTime,
          guestImportId,
          // EXT-F4: stamp the expiry so a never-arriving parent's hold can be
          // purged and is never promoted after it lapses.
          new Date(options.nowMs + SYNC_BOUNDS.pendingTtlMs),
        );
        chain.pendingEventIds.add(ev.eventId);
        chain.parentByEventId.set(ev.eventId, ev.parentEventId);
        livePendingCount += 1; // this new hold is live (just-stamped expiry)
        results.push({
          itemId: ev.eventId,
          itemKind: "event",
          status: "pending",
          reasonCode: "pending_parent",
          duplicate: false,
          recoverable: true,
          componentKey,
          clockSuspect: canonicalTime.clockSuspect,
          canonicalOccurredAt: canonicalTime.occurredAtCanonical,
        });
        continue;
      }

      // Accept: persist the scheduling event and extend the in-memory chain.
      await persistEvent(
        tx,
        userId,
        component.id,
        ev,
        canonicalRating,
        "scheduling",
        canonicalTime,
        guestImportId,
      );
      chain.acceptedEventIds.add(ev.eventId);
      chain.parentByEventId.set(ev.eventId, ev.parentEventId);
      chain.accepted.push({
        eventId: ev.eventId,
        status: "scheduling",
        rating: canonicalRating as ComponentReplayEvent["rating"],
        clientComponentRevision: ev.clientComponentRevision,
        parentEventId: ev.parentEventId,
        occurredAtCanonical: new Date(canonicalTime.occurredAtCanonicalMs),
        localDateAtEvent: canonicalTime.localDateAtEvent,
      });
      refreshChainHead(chain);
      acceptedThisBatch.push(ev.eventId);
      changed = true;

      if (correctnessCorrected) {
        await writeSyncAudit(tx, {
          userId,
          itemKind: "event",
          itemId: ev.eventId,
          reasonCode: "correctness_corrected",
          severity: "warning",
          componentKey,
          correlationId: options.correlationId,
        });
      }

      results.push({
        itemId: ev.eventId,
        itemKind: "event",
        status: correctnessCorrected ? "corrected" : "accepted",
        reasonCode: correctnessCorrected ? "correctness_corrected" : "accepted",
        duplicate: false,
        recoverable: false,
        componentKey,
        clockSuspect: canonicalTime.clockSuspect,
        canonicalOccurredAt: canonicalTime.occurredAtCanonical,
      });
    }

    // T9c (§14.2): promote children held `pending_parent` from an EARLIER batch
    // whose parent is now accepted. Only a child whose parent is the CURRENT head
    // with the contiguous NEXT revision can accept (classifyLineage rejects a
    // stale branch off a non-head parent), so instead of re-classifying every
    // held sibling we walk the chain FORWARD from the head via an O(1)
    // parent+revision index. This keeps per-request work bounded by the number of
    // PROMOTIONS regardless of how many stale/held siblings accumulated — a
    // malicious client cannot force unbounded classification work (SEC-T9c-001).
    // Held rows always carry a non-null parent (a root is never held pending).
    const heldByParentRev = new Map<string, Map<number, EventRow>>();
    for (const row of existingRows) {
      if (row.status !== "pending_parent" || row.parentEventId === null)
        continue;
      // EXT-F4: an expired hold is never promoted (it is purgeable dead weight).
      if (
        row.pendingExpiresAt !== null &&
        row.pendingExpiresAt.getTime() < options.nowMs
      )
        continue;
      const byRevision =
        heldByParentRev.get(row.parentEventId) ?? new Map<number, EventRow>();
      // A fork sharing (parent, revision) is a competing branch; keep the
      // lexicographically-smallest event id for a deterministic winner and hold
      // the other (Stage A holds competing branches for pull/rebase).
      const incumbent = byRevision.get(row.clientComponentRevision);
      if (!incumbent || row.eventId < incumbent.eventId) {
        byRevision.set(row.clientComponentRevision, row);
      }
      heldByParentRev.set(row.parentEventId, byRevision);
    }
    if (heldByParentRev.size > 0) {
      const promotedIds: string[] = [];
      let budget = options.maxPendingReprocess ?? MAX_PENDING_REPROCESS;
      // Walk forward from every event this transaction accepted, not from the
      // head (Phase 17 §14). Phase 16 could key on (head, headRevision + 1)
      // because the head was the only parent a held child could legally extend.
      // Under a union that is no longer true: a held guest child's revision is
      // one past ITS OWN parent's, which for the guest's chain is unrelated to
      // the account's — possibly much higher — maximum. Keyed on the head, such
      // a child is never looked up, is never promoted, and sits as
      // `pending_parent` until the TTL purges it: a guest review lost with no
      // rejection ever reported to anyone.
      //
      // Still O(1) per lookup and still bounded by `budget`, so the
      // unbounded-reprocessing property SEC-T9c-001 asked for is unchanged; what
      // widens is only WHICH parents are asked about.
      const revisionOf = new Map(
        chain.accepted.map((e) => [e.eventId, e.clientComponentRevision]),
      );
      // Seeded with every ACCEPTED event that some held child claims as its
      // parent — not with the events accepted in this batch. A child can be
      // waiting behind a parent accepted in an earlier request (Phase 16 reached
      // those because that parent was the head), and it can be waiting behind a
      // parent that is not the head at all (only a union produces those). Taking
      // the parents the held rows actually name covers both without asking about
      // parents nobody is waiting on.
      // Pop order does not affect WHICH children end up promoted: a child is
      // promoted only when its own parent is accepted and its revision is
      // exactly one past that parent's, and neither fact depends on the order
      // its parent was visited in. Order affects only which promotions a
      // budget-exhausted request gets to first, and the remainder is promoted by
      // the next request that touches the component.
      const frontier = [...heldByParentRev.keys()].filter((parentId) =>
        chain.acceptedEventIds.has(parentId),
      );
      while (budget > 0 && frontier.length > 0) {
        const parentId = frontier.pop() as string;
        const parentRevision = revisionOf.get(parentId);
        if (parentRevision === undefined) continue;
        const child = heldByParentRev.get(parentId)?.get(parentRevision + 1);
        if (!child) continue;
        // Structural safety net (cycle/contiguity/fork) via the same classifier
        // the main loop uses — belt-and-suspenders on top of the parent+revision
        // key. A merged component is judged by the merge rule, or an imported
        // child extending a non-head guest event would be read as a stale branch
        // and stay held forever; an unmerged one keeps Phase 16's rule exactly.
        const lineage = classifyForEvent(
          chain,
          child.importedFromGuestImportId !== null,
          {
            eventId: child.eventId,
            parentEventId: child.parentEventId,
            clientComponentRevision: child.clientComponentRevision,
          },
        );
        if (lineage.decision !== "accept") continue;

        chain.acceptedEventIds.add(child.eventId);
        chain.pendingEventIds.delete(child.eventId);
        chain.accepted.push({
          eventId: child.eventId,
          status: "scheduling",
          rating: child.rating as ComponentReplayEvent["rating"],
          clientComponentRevision: child.clientComponentRevision,
          parentEventId: child.parentEventId,
          occurredAtCanonical: child.occurredAtCanonical,
          localDateAtEvent: child.localDateAtEvent,
        });
        chain.parentByEventId.set(child.eventId, child.parentEventId);
        refreshChainHead(chain);
        revisionOf.set(child.eventId, child.clientComponentRevision);
        // A promoted child may itself have a held child waiting behind it.
        frontier.push(child.eventId);
        acceptedThisBatch.push(child.eventId);
        promotedIds.push(child.eventId);
        budget -= 1;
      }
      if (promotedIds.length > 0) {
        // ONE batched status flip (not one round trip per child) so the advisory
        // lock is not held across N sequential updates.
        await tx
          .update(reviewEvents)
          .set({ status: "scheduling" })
          .where(inArray(reviewEvents.eventId, promotedIds));
        changed = true;
      }
      if (budget <= 0) {
        console.warn(
          `[sync] ingest: pending-parent reprocess hit the ${MAX_PENDING_REPROCESS} cap for component ${component.id}; remainder promotes on the next request`,
        );
      }
    }

    if (!changed) return results;

    // --- REL-005: a union and its authorisation are the SAME write ------------
    //
    // The stamp is derived from the accepted set this transaction is holding —
    // `countChainRoots` over the very events about to be replayed — and never
    // from anything the caller said about them. So "is this a union?" is
    // answered by the data, and "is it allowed to be one?" by whether the
    // server-internal merge mode is driving the call.
    //
    // Both answers then feed ONE update, below, alongside the replayed state.
    // There is deliberately no path that writes the union first and the stamp
    // afterwards: the events, the scheduling state derived from them and the
    // permission to hold them commit together or not at all. A partial commit
    // is the state REL-006 punishes — an unmarked multi-rooted component throws
    // at every read path, so it would take out this account's pull as well.
    //
    // Note the two cases that produce NO stamp, both correct:
    //  - a merge import that lands on a component with no account history: one
    //    root, no union, nothing to authorise;
    //  - an ORDINARY push that somehow produced a multi-rooted set: no
    //    `guestImport`, so no stamp, so `replayComponent` refuses it below and
    //    the whole component transaction rolls back. That is the canary
    //    `merged_at` exists to keep alive (see db/schema/learning.ts), and it
    //    must stay loud rather than be quietly repaired here.
    const becameUnion = countChainRoots(headCandidatesOf(chain.accepted)) > 1;
    const authorisesUnion = becameUnion && isImported;
    // Stamp only the null → union transition. A component that was already
    // merged keeps its ORIGINAL `merged_at` and provenance: that pair records
    // when this component first became a union and which import made it one,
    // which is the question an incident investigation asks. Re-stamping on
    // every later import would overwrite the answer with the most recent one.
    const mergeMark: ComponentMergeMark = {
      mergedAt:
        component.mergedAt ??
        (authorisesUnion ? new Date(options.nowMs) : null),
    };
    const stampsMergeNow = component.mergedAt === null && authorisesUnion;

    // Deterministic replay → authoritative state. A ChainError means the
    // accepted chain is non-contiguous — an integrity violation that lineage
    // (T8) should already prevent. It is FATAL for this component: log it and
    // rethrow to abort (roll back) the whole component transaction rather than
    // persist a corrupt chain. The batch loop isolates this into a per-item
    // internal_error (with an out-of-band audit) so it never crashes the
    // request or silently drops the component's events without a trace.
    let replayed;
    try {
      // The mark is the one derived just above: the component's existing stamp
      // if it had one, or the stamp THIS transaction is about to write. Passing
      // the pre-transaction `component.mergedAt` instead would make the very
      // transaction that creates a union fail to replay it — the union would be
      // authorised and unreplayable in the same breath.
      //
      // An unmarked component that has somehow become multi-rooted still throws
      // here, which is the point: that shape is corruption unless a merge
      // coordinator recorded that it is not.
      replayed = replayComponent(chain.accepted, options.nowMs, mergeMark);
    } catch (error) {
      if (error instanceof ChainError) {
        console.error(
          `[sync] ingest: replay ChainError for component ${component.id}`,
          error,
        );
      }
      throw error;
    }

    // Bump the account cursor LAST (after every row lock) to avoid lock-order
    // deadlocks, then stamp the changed rows with it.
    const serverCursor = await nextAccountCursor(tx, userId);
    const newRevision = component.revision + acceptedThisBatch.length;

    await tx
      .update(studyComponents)
      .set({
        stability: replayed.stability,
        difficulty: replayed.difficulty,
        dueAt: replayed.dueAt,
        fsrsState: replayed.fsrsState,
        reps: replayed.reps,
        lapses: replayed.lapses,
        lastReviewAt: replayed.lastReviewAt,
        learnerState: replayed.learnerState,
        revision: newRevision,
        lastSyncSeq: serverCursor,
        // REL-005: the union's authorisation rides in the SAME statement as the
        // state derived from it. Both columns or neither — the
        // `study_components_merge_provenance_check` constraint enforces it,
        // so a future edit that writes one of them alone fails at the database
        // rather than producing a half-written merge record.
        ...(stampsMergeNow
          ? {
              mergedAt: mergeMark.mergedAt,
              mergedFromGuestImportId: guestImportId,
            }
          : {}),
      })
      .where(eq(studyComponents.id, component.id));

    // Stamp every accepted event's cursor in one statement (not N round trips).
    await tx
      .update(reviewEvents)
      .set({ lastSyncSeq: serverCursor })
      .where(inArray(reviewEvents.eventId, acceptedThisBatch));

    // Attach the reconciled server revision to the accepted results.
    for (const result of results) {
      if (result.status === "accepted" || result.status === "corrected") {
        result.serverRevision = newRevision;
      }
    }

    return results;
  });
}

/**
 * Ingest the batch's REINFORCEMENT-ONLY attempts — attempts with no scheduling
 * event (§12, ledger T9b). They persist as authoritative history/analytics with
 * server-canonical correctness, but NEVER advance FSRS: no review event is
 * written, the component revision is unchanged, and the account cursor is not
 * bumped (they carry no scheduling change to pull). Same per-component advisory
 * lock as the event path, so a reinforcement attempt and a scheduling event for
 * one component still serialise.
 */
async function processReinforcementAttempts(
  db: Database,
  userId: string,
  componentKey: string,
  attempts: WireAttempt[],
  options: IngestOptions,
  contextCache: Map<string, ResolvedRelease>,
): Promise<SyncItemResult[]> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${userId}:${componentKey}`}), 0)`,
    );

    const first = attempts[0]!;
    const resolved = await resolveReleaseCached(
      contextCache,
      first.releaseId,
      options,
    );
    const context = resolved.context;
    if (!context) {
      const code = resolved.reasonCode;
      return Promise.all(
        attempts.map(async (att) => {
          await writeSyncAudit(tx, {
            userId,
            itemKind: "attempt",
            itemId: att.id,
            reasonCode: code,
            severity: "warning",
            releaseId: att.releaseId,
            componentKey,
            correlationId: options.correlationId,
          });
          return reject({ itemId: att.id, itemKind: "attempt" }, code);
        }),
      );
    }

    const validation = validateComponent(context, {
      componentKey,
      entryId: first.entryId,
      skillType: first.skillTypeId,
      sourceField: first.sourceField,
      direction: first.direction,
    });
    if (!validation.ok) {
      return Promise.all(
        attempts.map(async (att) => {
          await writeSyncAudit(tx, {
            userId,
            itemKind: "attempt",
            itemId: att.id,
            reasonCode: validation.reasonCode,
            severity: "warning",
            releaseId: att.releaseId,
            componentKey,
            correlationId: options.correlationId,
          });
          return reject(
            { itemId: att.id, itemKind: "attempt" },
            validation.reasonCode,
          );
        }),
      );
    }
    const identity = validation.identity;
    const component = await findOrCreateComponent(tx, userId, {
      entryId: identity.entryId,
      skillType: identity.skillType,
      componentShape: identity.componentShape,
      sourceField: identity.sourceField,
      direction: identity.direction,
    });

    // The chain head only supplies the clock-suspect baseline; a reinforcement
    // attempt never extends the chain, so nothing here is written back to it.
    const existingRows = await tx
      .select()
      .from(reviewEvents)
      .where(eq(reviewEvents.studyComponentId, component.id));
    const chain = buildChainState(existingRows);

    const results: SyncItemResult[] = [];
    for (const att of attempts) {
      // A no-event attempt that does not declare itself reinforcement is
      // inconsistent (a scheduling attempt must carry its event) — reject it
      // rather than silently persist a non-scheduling "first attempt".
      if (!att.isReinforcement) {
        await writeSyncAudit(tx, {
          userId,
          itemKind: "attempt",
          itemId: att.id,
          reasonCode: "malformed_item",
          severity: "warning",
          componentKey,
          correlationId: options.correlationId,
        });
        results.push(
          reject({ itemId: att.id, itemKind: "attempt" }, "malformed_item"),
        );
        continue;
      }

      // EXT-F5 (sibling path): the group identity + release context were derived
      // from the FIRST attempt only; re-validate EVERY reinforcement attempt, or
      // a crafted batch could persist a row whose declared
      // entry/skill/field/direction contradict (or reference quiz-ineligible
      // content different from) the component it is attached to and graded
      // against. Reinforcement attempts carry no event, so we require each to
      // agree with the group on component + release + content version (so the
      // shared release context is the correct manifest for it), then re-validate
      // its own natural key against that manifest.
      if (
        att.studyComponentId !== componentKey ||
        att.releaseId !== first.releaseId ||
        att.contentVersion !== first.contentVersion
      ) {
        await writeSyncAudit(tx, {
          userId,
          itemKind: "attempt",
          itemId: att.id,
          reasonCode: "malformed_item",
          severity: "warning",
          componentKey,
          correlationId: options.correlationId,
        });
        results.push(
          reject({ itemId: att.id, itemKind: "attempt" }, "malformed_item"),
        );
        continue;
      }
      const attemptValidation = validateComponent(context, {
        componentKey: att.studyComponentId,
        entryId: att.entryId,
        skillType: att.skillTypeId,
        sourceField: att.sourceField,
        direction: att.direction,
      });
      if (!attemptValidation.ok) {
        await writeSyncAudit(tx, {
          userId,
          itemKind: "attempt",
          itemId: att.id,
          reasonCode: attemptValidation.reasonCode,
          severity: "warning",
          releaseId: att.releaseId,
          componentKey,
          correlationId: options.correlationId,
        });
        results.push(
          reject(
            { itemId: att.id, itemKind: "attempt" },
            attemptValidation.reasonCode,
          ),
        );
        continue;
      }

      // Idempotency: a re-delivered attempt id is a duplicate if its immutable
      // payload matches, or a payload_conflict if it differs.
      const hash = payloadHash(attemptPayload(att));
      const [existing] = await tx
        .select({ hash: studyAttempts.idempotencyPayloadHash })
        .from(studyAttempts)
        .where(eq(studyAttempts.id, att.id));
      if (existing) {
        if (existing.hash === hash) {
          results.push({
            itemId: att.id,
            itemKind: "attempt",
            status: "duplicate",
            reasonCode: "duplicate",
            duplicate: true,
            recoverable: false,
            componentKey,
          });
        } else {
          await writeSyncAudit(tx, {
            userId,
            itemKind: "attempt",
            itemId: att.id,
            reasonCode: "payload_conflict",
            severity: "critical",
            componentKey,
            correlationId: options.correlationId,
          });
          results.push(
            reject({ itemId: att.id, itemKind: "attempt" }, "payload_conflict"),
          );
        }
        continue;
      }

      // Server-canonical correctness (never the client claim). Flashcards are
      // self-rated (no objective answer to grade); objective modes are graded.
      let canonicalIsCorrect: boolean;
      let canonicalCorrectAnswer: unknown;
      let correctnessCorrected = false;
      if (att.mode === "flashcard") {
        canonicalIsCorrect = att.isCorrect;
        canonicalCorrectAnswer = att.correctAnswerRef;
      } else if (OBJECTIVE_MODES.has(att.mode)) {
        const grade = gradeObjectiveAttempt(context, {
          identity,
          mode: att.mode as "mc" | "timed" | "test" | "timed_test",
          questionSeed: att.questionSeed,
          questionPosition: att.questionPosition,
          optionCount: att.optionCount,
          promptField: att.promptField,
          questionInstanceId: att.questionInstanceId,
          questionGeneratorVersion: att.questionGeneratorVersion,
          selectedAnswerRef: att.selectedAnswerRef,
          hintUsed: att.hintUsed,
          claimedIsCorrect: att.isCorrect,
        });
        if (!grade.ok) {
          await writeSyncAudit(tx, {
            userId,
            itemKind: "attempt",
            itemId: att.id,
            reasonCode: grade.reasonCode,
            severity: "warning",
            releaseId: att.releaseId,
            componentKey,
            correlationId: options.correlationId,
          });
          results.push(
            reject({ itemId: att.id, itemKind: "attempt" }, grade.reasonCode),
          );
          continue;
        }
        canonicalIsCorrect = grade.isCorrect;
        canonicalCorrectAnswer = grade.correctAnswerRef;
        correctnessCorrected = grade.correctnessCorrected;
      } else {
        results.push(
          reject({ itemId: att.id, itemKind: "attempt" }, "malformed_item"),
        );
        continue;
      }

      // Each reinforcement attempt is clamped against the component's SCHEDULING
      // chain head (its clock-suspect floor is "not before the last accepted
      // scheduling event, not in the future"). It is deliberately NOT chained to
      // the OTHER reinforcement attempts in this batch: reinforcement attempts
      // are independent practice events with no causal lineage or revision order
      // (unlike scheduling events, which advance the chain head as they accept),
      // so their intra-batch relative ordering is not an enforced invariant. This
      // has no scheduling consequence, and day-level analytics/streaks key off
      // localDateAtEvent (the day), not sub-day ordering, so it is not a
      // correctness gap — see the reliability review of ledger T9b.
      const canonicalTime = computeCanonicalEventTime({
        // The attempt's own client instant (attempts carry occurredAtUtc; the
        // occurredAtClient name is event-only).
        occurredAtClient: att.occurredAtUtc,
        timezoneAtEvent: att.timezoneAtEvent,
        utcOffsetMinutesAtEvent: att.utcOffsetMinutesAtEvent,
        localDateAtEvent: att.localDateAtEvent,
        timezoneSource: att.timezoneSource,
        serverReceivedAtMs: options.nowMs,
        previousAcceptedCanonicalMs: chain.headCanonicalMs,
      });

      // Persist as history only — no event, no replay, no revision/cursor bump.
      await persistAttempt(
        tx,
        userId,
        component.id,
        att,
        {
          isCorrect: canonicalIsCorrect,
          correctAnswerRef: canonicalCorrectAnswer,
        },
        canonicalTime,
      );
      if (correctnessCorrected) {
        await writeSyncAudit(tx, {
          userId,
          itemKind: "attempt",
          itemId: att.id,
          reasonCode: "correctness_corrected",
          severity: "warning",
          componentKey,
          correlationId: options.correlationId,
        });
      }
      results.push({
        itemId: att.id,
        itemKind: "attempt",
        status: correctnessCorrected ? "corrected" : "accepted",
        reasonCode: correctnessCorrected ? "correctness_corrected" : "accepted",
        duplicate: false,
        recoverable: false,
        componentKey,
        clockSuspect: canonicalTime.clockSuspect,
        canonicalOccurredAt: canonicalTime.occurredAtCanonical,
      });
    }
    return results;
  });
}

/**
 * Ingest a batch of scheduling events (with their attempts) AND any
 * reinforcement-only attempts (no scheduling event, §12/T9b). Groups events by
 * component and processes each component in its own advisory-locked transaction;
 * then processes the reinforcement-only attempts the same way. Returns a
 * per-item result for every event and every reinforcement attempt, plus the
 * resulting account cursor.
 *
 * The bounded cross-batch pending-parent reprocessor (§14.2, ledger T9c) is a
 * tracked follow-up task within this phase.
 */
export async function ingestSchedulingBatch(
  userId: string,
  events: WireEvent[],
  attempts: WireAttempt[],
  options: IngestOptions,
): Promise<IngestResult> {
  const db = getDb();
  const attemptsById = new Map(attempts.map((a) => [a.id, a]));
  const contextCache = new Map<string, ResolvedRelease>();

  const byComponent = new Map<string, WireEvent[]>();
  for (const ev of events) {
    const group = byComponent.get(ev.studyComponentId) ?? [];
    group.push(ev);
    byComponent.set(ev.studyComponentId, group);
  }

  const results: SyncItemResult[] = [];
  for (const [componentKey, group] of byComponent) {
    try {
      const groupResults = await processComponentGroup(
        db,
        userId,
        componentKey,
        group,
        attemptsById,
        options,
        contextCache,
      );
      results.push(...groupResults);
    } catch (error) {
      // One component's transaction aborting (e.g. an integrity ChainError or an
      // unexpected DB error) must NOT crash the whole request or discard the
      // other components. Isolate it: log, write an out-of-band audit (the
      // component transaction rolled back, so the audit must use `db`, not the
      // dead tx), and reject each of its events. REL-006: a ChainError here is
      // a PERMANENT structural condition, not the transient fault
      // `internal_error` implies, so it gets its own non-recoverable code —
      // otherwise the client retries stored corruption forever.
      console.error(`[sync] ingest: component ${componentKey} aborted`, error);
      const reasonCode = componentFaultReason(error);
      for (const ev of group) {
        try {
          await writeSyncAudit(db, {
            userId,
            itemKind: "event",
            itemId: ev.eventId,
            reasonCode,
            severity: "critical",
            componentKey,
            correlationId: options.correlationId,
          });
        } catch {
          // Never let audit failure mask the original error handling.
        }
        results.push(
          reject({ itemId: ev.eventId, itemKind: "event" }, reasonCode),
        );
      }
    }
  }

  // Reinforcement-only attempts (§12/T9b): every attempt NOT referenced by a
  // scheduling event in this batch. Grouped by component and processed with the
  // same per-component isolation as events.
  const referencedByEvent = new Set(events.map((ev) => ev.attemptId));
  const reinforcementByComponent = new Map<string, WireAttempt[]>();
  for (const att of attempts) {
    if (referencedByEvent.has(att.id)) continue;
    const group = reinforcementByComponent.get(att.studyComponentId) ?? [];
    group.push(att);
    reinforcementByComponent.set(att.studyComponentId, group);
  }
  for (const [componentKey, group] of reinforcementByComponent) {
    try {
      const groupResults = await processReinforcementAttempts(
        db,
        userId,
        componentKey,
        group,
        options,
        contextCache,
      );
      results.push(...groupResults);
    } catch (error) {
      // Isolate one component's failure exactly as the event loop does.
      console.error(
        `[sync] ingest: reinforcement component ${componentKey} aborted`,
        error,
      );
      const reasonCode = componentFaultReason(error);
      for (const att of group) {
        try {
          await writeSyncAudit(db, {
            userId,
            itemKind: "attempt",
            itemId: att.id,
            reasonCode,
            severity: "critical",
            componentKey,
            correlationId: options.correlationId,
          });
        } catch {
          // Never let audit failure mask the original error handling.
        }
        results.push(
          reject({ itemId: att.id, itemKind: "attempt" }, reasonCode),
        );
      }
    }
  }

  const serverCursor = await currentAccountCursor(db, userId);
  return { results, serverCursor };
}

export { OBJECTIVE_MODES, eventPayload };
