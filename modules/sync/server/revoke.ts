/**
 * Phase 16 — post-sync undo / revocation (§16, design decision D2).
 *
 * A learner undoing an already-accepted scheduling event sends a revocation
 * mutation. The server authenticates ownership, validates that the target is
 * the scheduling-authoritative CHAIN HEAD, marks it revoked (history preserved
 * — the event row is kept and its attempts are untouched), replays the
 * component WITHOUT it, and bumps the component revision + account cursor.
 *
 * Each component's revocations run in ONE transaction under the SAME
 * per-component advisory lock ingestion uses (`${userId}:${componentKey}`), so
 * a revocation can never race an ingestion of the same chain.
 *
 * Stage A rule for descendants (D2): a scheduling event may be revoked ONLY if
 * it is the current head (no accepted scheduling child). Revoking a non-head
 * event is a RECOVERABLE rejection (`revocation_has_descendants`) telling the
 * client to revoke descendants first or pull/rebase — never silently producing
 * a broken chain or inventing Phase 19 chain demotion.
 *
 * Idempotent: re-revoking an already-revoked event is a benign `duplicate`
 * no-op (no re-bump). Ownership is enforced by scoping the event lookup to the
 * session user, so a cross-account event id is indistinguishable from an
 * unknown one (`revocation_unknown_event`) — enumeration-safe.
 *
 * `server-only`.
 */
import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { getDb, type Database } from "@/db/client";
import { reviewEvents, studyComponents } from "@/db/schema";
import type {
  ComponentShape,
  Direction,
  SkillType,
  SourceQuizFormField,
} from "@/modules/content/constants";
import { buildComponentKey } from "@/modules/study-engine";
import {
  isRecoverableReason,
  type SyncItemResult,
  type SyncReasonCode,
  type WireRevocation,
} from "@/modules/sync/protocol";

import { writeSyncAudit } from "./audit";
import { currentAccountCursor, nextAccountCursor } from "./cursor";
import { type ComponentReplayEvent, replayComponent } from "./replay";

export type RevokeOptions = {
  /** Injected server-receipt clock (epoch ms) — never Date.now(). */
  nowMs: number;
  /** Correlation id for the request, recorded in audit rows. */
  correlationId?: string;
};

export type RevokeResult = {
  results: SyncItemResult[];
  /** The account cursor after revocation (unchanged if nothing was revoked). */
  serverCursor: number;
};

type EventRow = typeof reviewEvents.$inferSelect;
type ComponentRow = typeof studyComponents.$inferSelect;

function reject(
  rev: WireRevocation,
  reasonCode: SyncReasonCode,
  extra: Partial<SyncItemResult> = {},
): SyncItemResult {
  return {
    itemId: rev.revocationId,
    itemKind: "revocation",
    status: "rejected",
    reasonCode,
    duplicate: false,
    recoverable: isRecoverableReason(reasonCode),
    ...extra,
  };
}

/** Map a stored scheduling row to the pure replay event shape. */
function toReplayEvent(row: EventRow): ComponentReplayEvent {
  return {
    eventId: row.eventId,
    status: row.status as ComponentReplayEvent["status"],
    rating: row.rating as ComponentReplayEvent["rating"],
    clientComponentRevision: row.clientComponentRevision,
    parentEventId: row.parentEventId,
    occurredAtCanonical: row.occurredAtCanonical,
    localDateAtEvent: row.localDateAtEvent,
  };
}

/**
 * The component's true natural key, rebuilt from its stored identity. Returns
 * `null` if the stored identity is somehow invalid (it never is for a row the
 * ingest path created, but the builder throws defensively).
 */
function trueComponentKey(component: ComponentRow): string | null {
  try {
    return buildComponentKey({
      entryId: component.entryId,
      skillType: component.skillTypeId as SkillType,
      componentShape: component.componentShape as ComponentShape,
      sourceField: component.sourceField as SourceQuizFormField | null,
      direction: component.direction as Direction | null,
    });
  } catch {
    return null;
  }
}

/** A `duplicate` (idempotent no-op) result for an already-revoked event. */
function alreadyRevoked(
  rev: WireRevocation,
  componentKey: string,
  serverRevision: number,
): SyncItemResult {
  return {
    itemId: rev.revocationId,
    itemKind: "revocation",
    status: "duplicate",
    reasonCode: "revocation_already_revoked",
    duplicate: true,
    recoverable: false,
    componentKey,
    serverRevision,
  };
}

/**
 * Process one component's revocations inside a single advisory-locked
 * transaction, mirroring ingest.ts's discipline: every touched row is locked
 * (`FOR UPDATE`) BEFORE the account cursor is bumped, and the cursor is bumped
 * exactly ONCE — LAST — with a single terminal write block, so the account
 * revision/state can't be lost by a concurrent writer and the lock-acquisition
 * order (component rows → account cursor) is identical across both mutation
 * paths (no AB-BA lock-order inversion).
 *
 * Head-only rule (D2) is evaluated in-memory HEAD-FIRST, so a well-formed
 * multi-item "undo a run" batch is accepted in a single pass regardless of the
 * submitted order.
 */
async function processComponentRevocations(
  db: Database,
  userId: string,
  componentKey: string,
  revocations: WireRevocation[],
  options: RevokeOptions,
): Promise<SyncItemResult[]> {
  return db.transaction(async (tx) => {
    // Serialise against ingestion of the same chain (identical lock domain).
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${userId}:${componentKey}`}), 0)`,
    );

    // Result accumulator keyed by revocation id; assembled in submitted order.
    const resultByRev = new Map<string, SyncItemResult>();
    async function auditReject(
      rev: WireRevocation,
      reasonCode: SyncReasonCode,
      extra: Partial<SyncItemResult> = {},
      metadata: Record<string, unknown> = { eventId: rev.eventId },
    ): Promise<void> {
      await writeSyncAudit(tx, {
        userId,
        itemKind: "revocation",
        itemId: rev.revocationId,
        reasonCode,
        severity: "warning",
        componentKey,
        correlationId: options.correlationId,
        metadata,
      });
      resultByRev.set(rev.revocationId, reject(rev, reasonCode, extra));
    }

    // 1. Load every targeted event scoped to this account, LOCKED (FOR UPDATE):
    //    a cross-account id reads as unknown (enumeration-safe), and locking the
    //    row before the cursor bump both prevents a lost update and matches
    //    ingest.ts's row-lock-then-cursor order.
    const eventIds = revocations.map((rev) => rev.eventId);
    const targetRows = eventIds.length
      ? await tx
          .select()
          .from(reviewEvents)
          .where(
            and(
              inArray(reviewEvents.eventId, eventIds),
              eq(reviewEvents.userId, userId),
            ),
          )
          .for("update")
      : [];
    const targetById = new Map(targetRows.map((row) => [row.eventId, row]));

    // 2. Load + lock the components those events belong to. The group's accepted
    //    items all belong to the one whose true natural key equals the
    //    client-claimed componentKey (so the advisory lock we took is correct on
    //    every path that WRITES — a mismatch only ever rejects).
    const componentIds = [
      ...new Set(targetRows.map((row) => row.studyComponentId)),
    ];
    const componentRows = componentIds.length
      ? await tx
          .select()
          .from(studyComponents)
          .where(inArray(studyComponents.id, componentIds))
          .for("update")
      : [];
    const componentById = new Map(componentRows.map((row) => [row.id, row]));
    const component =
      componentRows.find((row) => trueComponentKey(row) === componentKey) ??
      null;

    // 3. The component's chain view (accepted scheduling events) for the
    //    head-only descendant check + replay.
    const schedulingEvents = component
      ? (
          await tx
            .select()
            .from(reviewEvents)
            .where(eq(reviewEvents.studyComponentId, component.id))
        ).filter((row) => row.status === "scheduling")
      : [];

    // 4. Classify each revocation. Invalid ones get their result now; valid
    //    scheduling targets become accept-candidates.
    type Candidate = { rev: WireRevocation; target: EventRow };
    const candidates: Candidate[] = [];
    for (const rev of revocations) {
      const target = targetById.get(rev.eventId);
      if (!target) {
        await auditReject(rev, "revocation_unknown_event");
        continue;
      }
      const comp = componentById.get(target.studyComponentId);
      if (!comp || trueComponentKey(comp) !== componentKey) {
        await auditReject(rev, "revocation_unknown_event");
        continue;
      }
      if (target.status === "revoked" || target.revokedAt !== null) {
        resultByRev.set(
          rev.revocationId,
          alreadyRevoked(rev, componentKey, comp.revision),
        );
        continue;
      }
      if (target.status !== "scheduling") {
        await auditReject(
          rev,
          "not_scheduling_authoritative",
          { componentKey },
          { eventId: rev.eventId, status: target.status },
        );
        continue;
      }
      candidates.push({ rev, target });
    }

    // 5. Head-only rule (D2), evaluated HEAD-FIRST (deepest revision first) so a
    //    batch undoing a run of reviews accepts in one pass: revoking the head
    //    makes its parent the new head for the next candidate.
    const revokedInBatch = new Set<string>();
    const accepted: WireRevocation[] = [];
    const ordered = [...candidates].sort(
      (a, b) =>
        b.target.clientComponentRevision - a.target.clientComponentRevision,
    );
    for (const { rev, target } of ordered) {
      // A second revocation of the same event within this batch is a no-op.
      if (revokedInBatch.has(target.eventId)) {
        resultByRev.set(
          rev.revocationId,
          alreadyRevoked(rev, componentKey, component?.revision ?? 0),
        );
        continue;
      }
      const hasSchedulingChild = schedulingEvents.some(
        (row) =>
          row.parentEventId === target.eventId &&
          !revokedInBatch.has(row.eventId),
      );
      if (hasSchedulingChild) {
        await auditReject(rev, "revocation_has_descendants", { componentKey });
        continue;
      }
      revokedInBatch.add(target.eventId);
      accepted.push(rev);
    }

    // 6. Terminal write block: cursor bumped LAST (after the FOR UPDATE row
    //    locks), once per transaction. Nothing accepted → no authoritative
    //    change, no cursor/revision bump. (`component` is non-null whenever
    //    `accepted` is non-empty, since a candidate requires the matched key.)
    if (component && accepted.length > 0) {
      const serverCursor = await nextAccountCursor(tx, userId);
      await tx
        .update(reviewEvents)
        .set({
          status: "revoked",
          revokedAt: new Date(options.nowMs),
          lastSyncSeq: serverCursor,
        })
        .where(inArray(reviewEvents.eventId, [...revokedInBatch]));

      // Remaining accepted scheduling events (in-memory: exclude those revoked
      // in this batch) replayed into authoritative state.
      const remaining = schedulingEvents.filter(
        (row) => !revokedInBatch.has(row.eventId),
      );
      const replayed = replayComponent(
        remaining.map(toReplayEvent),
        options.nowMs,
      );
      const newRevision = component.revision + accepted.length;
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

      for (const rev of accepted) {
        resultByRev.set(rev.revocationId, {
          itemId: rev.revocationId,
          itemKind: "revocation",
          status: "accepted",
          reasonCode: "accepted",
          duplicate: false,
          recoverable: false,
          componentKey,
          serverRevision: newRevision,
        });
      }
    }

    // Assemble results in the submitted order (one per revocation).
    return revocations.map(
      (rev) =>
        resultByRev.get(rev.revocationId) ??
        reject(rev, "internal_error", { componentKey }),
    );
  });
}

/**
 * Revoke a batch of already-accepted scheduling events. Groups revocations by
 * component and processes each component in its own advisory-locked
 * transaction, isolating a component failure into a recoverable
 * `internal_error` for its items (mirroring ingestion). Returns a per-item
 * result for every revocation and the resulting account cursor.
 */
export async function revokeEventsBatch(
  userId: string,
  revocations: WireRevocation[],
  options: RevokeOptions,
): Promise<RevokeResult> {
  const db = getDb();

  const byComponent = new Map<string, WireRevocation[]>();
  for (const rev of revocations) {
    const group = byComponent.get(rev.studyComponentId) ?? [];
    group.push(rev);
    byComponent.set(rev.studyComponentId, group);
  }

  const results: SyncItemResult[] = [];
  for (const [componentKey, group] of byComponent) {
    try {
      const groupResults = await processComponentRevocations(
        db,
        userId,
        componentKey,
        group,
        options,
      );
      results.push(...groupResults);
    } catch (error) {
      // One component's transaction aborting must not crash the request or
      // discard the other components. Isolate it: log, write an out-of-band
      // audit (the tx rolled back, so use `db`), and return a recoverable
      // internal_error for each of its revocations.
      console.error(`[sync] revoke: component ${componentKey} aborted`, error);
      for (const rev of group) {
        try {
          await writeSyncAudit(db, {
            userId,
            itemKind: "revocation",
            itemId: rev.revocationId,
            reasonCode: "internal_error",
            severity: "critical",
            componentKey,
            correlationId: options.correlationId,
            metadata: { eventId: rev.eventId },
          });
        } catch {
          // Never let audit failure mask the original error handling.
        }
        results.push(reject(rev, "internal_error", { componentKey }));
      }
    }
  }

  const serverCursor = await currentAccountCursor(db, userId);
  return { results, serverCursor };
}
