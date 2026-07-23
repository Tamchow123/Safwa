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
  type SyncItemResult,
  type SyncReasonCode,
  type WireAttempt,
  type WireEvent,
} from "@/modules/sync/protocol";

import { writeSyncAudit } from "./audit";
import {
  computeCanonicalEventTime,
  type CanonicalTimeResult,
} from "./canonical-time";
import { currentAccountCursor, nextAccountCursor, type SyncTx } from "./cursor";
import { gradeObjectiveAttempt, gradeFlashcardAttempt } from "./grade";
import { payloadHash } from "./idempotency";
import { classifyLineage } from "./lineage";
import { resolveReleaseForIngestion, type ReleaseLoadOptions } from "./release";
import { type ComponentReplayEvent, replayComponent } from "./replay";
import { validateComponent } from "./validate-component";

export type IngestOptions = ReleaseLoadOptions & {
  /** Injected server-receipt clock (epoch ms) — never Date.now(). */
  nowMs: number;
  /** Correlation id for the request, recorded in audit rows. */
  correlationId?: string;
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

function buildChainState(rows: EventRow[]): ChainState {
  const acceptedEventIds = new Set<string>();
  const pendingEventIds = new Set<string>();
  const parentByEventId = new Map<string, string | null>();
  const accepted: ComponentReplayEvent[] = [];
  let headEventId: string | null = null;
  let headRevision = 0;
  let headCanonicalMs: number | null = null;

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
      if (row.clientComponentRevision > headRevision) {
        headRevision = row.clientComponentRevision;
        headEventId = row.eventId;
        headCanonicalMs = row.occurredAtCanonical.getTime();
      }
    } else if (row.status === "pending_parent") {
      pendingEventIds.add(row.eventId);
    }
  }
  return {
    headEventId,
    headRevision,
    headCanonicalMs,
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
): Promise<{ id: string; revision: number }> {
  const [existing] = await tx
    .select({ id: studyComponents.id, revision: studyComponents.revision })
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
    .returning({ id: studyComponents.id, revision: studyComponents.revision });
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

/** Persist the graded attempt with the server-canonical correctness/answer. */
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

/** Persist a review event with server-canonical rating/time and the given status. */
async function persistEvent(
  tx: SyncTx,
  userId: string,
  componentRowId: string,
  ev: WireEvent,
  rating: string,
  status: "scheduling" | "pending_parent",
  canonicalTime: CanonicalTimeResult,
): Promise<void> {
  await tx.insert(reviewEvents).values({
    eventId: ev.eventId,
    userId,
    studyComponentId: componentRowId,
    attemptId: ev.attemptId,
    rating,
    status,
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
  });
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
  contextCache: Map<string, QuestionContext | null>,
): Promise<SyncItemResult[]> {
  const sorted = [...events].sort(
    (a, b) => a.clientComponentRevision - b.clientComponentRevision,
  );

  async function resolveContext(
    tx: SyncTx,
    releaseId: string,
  ): Promise<QuestionContext | null> {
    void tx;
    if (contextCache.has(releaseId)) return contextCache.get(releaseId) ?? null;
    const resolved = await resolveReleaseForIngestion(releaseId, options);
    const ctx = resolved.ok
      ? createQuestionContextFromRelease(resolved.release.learner)
      : null;
    contextCache.set(releaseId, ctx);
    return ctx;
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
    const context = await resolveContext(tx, firstAttempt.releaseId);
    if (!context) {
      const resolved = await resolveReleaseForIngestion(
        firstAttempt.releaseId,
        options,
      );
      const code: SyncReasonCode = resolved.ok
        ? "invalid_release"
        : resolved.reasonCode;
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
      const ctx = await resolveContext(tx, att.releaseId);
      if (!ctx) {
        await writeSyncAudit(tx, {
          userId,
          itemKind: "event",
          itemId: ev.eventId,
          reasonCode: "invalid_release",
          severity: "warning",
          releaseId: ev.releaseId,
          componentKey,
          correlationId: options.correlationId,
        });
        results.push(
          reject({ itemId: ev.eventId, itemKind: "event" }, "invalid_release"),
        );
        continue;
      }

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

      // 4. Lineage classification (§14).
      const lineage = classifyLineage(
        {
          eventId: ev.eventId,
          parentEventId: ev.parentEventId,
          clientComponentRevision: ev.clientComponentRevision,
        },
        {
          headEventId: chain.headEventId,
          headRevision: chain.headRevision,
          acceptedEventIds: chain.acceptedEventIds,
        },
        {
          parentByEventId: chain.parentByEventId,
          pendingEventIds: chain.pendingEventIds,
        },
      );

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

      // Persist the attempt with the server-canonical correctness/answer.
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
        );
        chain.pendingEventIds.add(ev.eventId);
        chain.parentByEventId.set(ev.eventId, ev.parentEventId);
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
      chain.headEventId = ev.eventId;
      chain.headRevision = ev.clientComponentRevision;
      chain.headCanonicalMs = canonicalTime.occurredAtCanonicalMs;
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
      let budget = MAX_PENDING_REPROCESS;
      while (budget > 0 && chain.headEventId !== null) {
        const child = heldByParentRev
          .get(chain.headEventId)
          ?.get(chain.headRevision + 1);
        if (!child) break;
        // Structural safety net (cycle/contiguity) via the same classifier the
        // main loop uses — belt-and-suspenders on top of the parent+revision key.
        const lineage = classifyLineage(
          {
            eventId: child.eventId,
            parentEventId: child.parentEventId,
            clientComponentRevision: child.clientComponentRevision,
          },
          {
            headEventId: chain.headEventId,
            headRevision: chain.headRevision,
            acceptedEventIds: chain.acceptedEventIds,
          },
          {
            parentByEventId: chain.parentByEventId,
            pendingEventIds: chain.pendingEventIds,
          },
        );
        if (lineage.decision !== "accept") break;

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
        chain.headEventId = child.eventId;
        chain.headRevision = child.clientComponentRevision;
        chain.headCanonicalMs = child.occurredAtCanonical.getTime();
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

    // Deterministic replay → authoritative state. A ChainError means the
    // accepted chain is non-contiguous — an integrity violation that lineage
    // (T8) should already prevent. It is FATAL for this component: log it and
    // rethrow to abort (roll back) the whole component transaction rather than
    // persist a corrupt chain. The batch loop isolates this into a per-item
    // internal_error (with an out-of-band audit) so it never crashes the
    // request or silently drops the component's events without a trace.
    let replayed;
    try {
      replayed = replayComponent(chain.accepted, options.nowMs);
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
  contextCache: Map<string, QuestionContext | null>,
): Promise<SyncItemResult[]> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${userId}:${componentKey}`}), 0)`,
    );

    const first = attempts[0]!;
    const resolved = await resolveReleaseForIngestion(first.releaseId, options);
    if (contextCache.has(first.releaseId) === false) {
      contextCache.set(
        first.releaseId,
        resolved.ok
          ? createQuestionContextFromRelease(resolved.release.learner)
          : null,
      );
    }
    const context = contextCache.get(first.releaseId) ?? null;
    if (!context) {
      const code: SyncReasonCode = resolved.ok
        ? "invalid_release"
        : resolved.reasonCode;
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
  const contextCache = new Map<string, QuestionContext | null>();

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
      // dead tx), and return a recoverable internal_error for each of its events.
      console.error(`[sync] ingest: component ${componentKey} aborted`, error);
      for (const ev of group) {
        try {
          await writeSyncAudit(db, {
            userId,
            itemKind: "event",
            itemId: ev.eventId,
            reasonCode: "internal_error",
            severity: "critical",
            componentKey,
            correlationId: options.correlationId,
          });
        } catch {
          // Never let audit failure mask the original error handling.
        }
        results.push(
          reject({ itemId: ev.eventId, itemKind: "event" }, "internal_error"),
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
      for (const att of group) {
        try {
          await writeSyncAudit(db, {
            userId,
            itemKind: "attempt",
            itemId: att.id,
            reasonCode: "internal_error",
            severity: "critical",
            componentKey,
            correlationId: options.correlationId,
          });
        } catch {
          // Never let audit failure mask the original error handling.
        }
        results.push(
          reject({ itemId: att.id, itemKind: "attempt" }, "internal_error"),
        );
      }
    }
  }

  const serverCursor = await currentAccountCursor(db, userId);
  return { results, serverCursor };
}

export { OBJECTIVE_MODES, eventPayload };
