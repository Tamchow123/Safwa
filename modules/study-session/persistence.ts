/**
 * Study-session persistence adapter (impure) — the thin Dexie wiring between the
 * pure engine (`modules/study-engine`), the pure scheduler
 * (`modules/scheduler`) and the local learner-state stores
 * (`modules/content/db`). The engine and scheduler stay pure (no DB imports);
 * this module is the ONE place that turns their outputs into durable rows.
 *
 * A graded attempt is persisted atomically: the attempt row always, and — for a
 * scheduling-relevant attempt (the first attempt of a component in a session;
 * NOT a within-session reinforcement recovery) — a `review_events` row plus the
 * replayed FSRS card + learner-state on the component. Undo is single-step and
 * reverses exactly one recorded action (delete the attempt, delete its event if
 * any, re-replay the remaining chain, restore/clear the component).
 *
 * Determinism lives in the pure modules; the impure inputs (UUIDs, wall clock)
 * are INJECTED by the caller so this adapter never invents identity or time.
 *
 * BROWSER-ONLY at runtime (IndexedDB); tests use fake-indexeddb.
 */
import type {
  DeviceProfileRecord,
  LocalOwnerId,
  ReviewEventRecord,
  SafwaDb,
  StudyComponentRecord,
} from "@/modules/content/db";
import { uuidv7 } from "@/lib/uuid";
import { toOwnerKey, tryParseOwnerKey } from "@/modules/content/owner-key";
import { ownedKey, readOwnedRows } from "@/modules/content/owner-scope";
import { DEVICE_PROFILE_KEY } from "@/modules/profile/device";
import type { AttemptRecord } from "@/modules/study-engine/attempts";
import { toWireAttempt } from "@/modules/sync/client/local-selection";
import {
  enqueueReinforcementMutation,
  enqueueRevocationMutation,
} from "@/modules/sync/client/mutation-queue";
import type {
  SchedulingEventSummary,
  StoredComponentState,
} from "@/modules/study-session/mixed";
import {
  createReviewEvent,
  deriveLineage,
  deriveNextLineage,
  learnerStateFromReplay,
  replayChain,
  shouldCreateEvent,
  type EventLineage,
  type ReviewEvent,
} from "@/modules/scheduler";

/** A record of exactly what one graded attempt persisted — the undo unit. */
export type PersistedAttempt = {
  attemptId: string;
  componentKey: string;
  /** The scheduling event created, or null for a reinforcement recovery. */
  eventId: string | null;
  /**
   * The durable device id the rows were written under (the existing profile's id
   * if one was already bound, else the provisional id, now committed). The caller
   * reconciles its in-memory session with this.
   */
  deviceId: string;
};

/**
 * Thrown when an undo cannot proceed because a later review already extends the
 * event (it is no longer the chain head) — e.g. the same component was graded
 * again in another tab sharing this IndexedDB. The undo is rejected atomically
 * (attempt AND event both left intact) rather than orphaning the attempt or
 * breaking the causal chain; the caller surfaces this to the learner.
 */
export class SupersededUndoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupersededUndoError";
  }
}

/**
 * Thrown when a scheduling event cannot be undone YET because the server is
 * still holding it as `pending` (sent but not yet authoritative — e.g. an
 * unknown-parent hold). Revoking it now would be rejected non-recoverably and
 * silently lost, then a later pull would resurrect it (EXT-F3). The undo is
 * TRANSIENT-rejected so the caller keeps the undo affordance and can retry once
 * the event resolves to accepted; unlike `SupersededUndoError` it is recoverable.
 */
export class UndoNotYetSyncedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UndoNotYetSyncedError";
  }
}

/** Injected identity + clock for one recorded attempt. */
export type RecordAttemptContext = {
  /** Client event id (a UUID from the caller) — used only when an event is created. */
  eventId: string;
  /** Wall-clock instant (epoch ms) for the local row timestamps. */
  now: number;
  /**
   * When the study session began (epoch ms) — used for the session row's
   * `startedAt` on lazy creation, so it reflects session open time rather than
   * first-grade time. Defaults to `now` when omitted.
   */
  sessionStartedAt?: number;
  /**
   * On the FIRST durable write (first-progress binding), the provisional device
   * profile to create if none exists yet. Creating it INSIDE this transaction
   * makes device identity atomic with the attempt/event — a failed write leaves
   * no orphaned profile (Phase-5 lazy-identity boundary). Omitted once the
   * device is already bound.
   */
  bindProfile?: DeviceProfileRecord;
};

/**
 * Map a scheduler `ReviewEvent` to its durable Dexie record, stamping the OWNER
 * so scheduling selection and chain reads scope to the identity that produced
 * it. The owner key is a real, indexable value for a guest as much as for an
 * account (schema v7), so both are served by the same `[ownerKey+syncStatus]`
 * and `[ownerKey+componentKey]` indexes — no in-memory owner filtering remains.
 */
function toEventRecord(
  event: ReviewEvent,
  now: number,
  owner: LocalOwnerId,
): ReviewEventRecord {
  return {
    eventId: event.eventId,
    componentKey: event.studyComponentId,
    ownerKey: toOwnerKey(owner),
    parentEventId: event.parentEventId,
    clientComponentRevision: event.clientComponentRevision,
    syncStatus: "local",
    createdAt: now,
    attemptId: event.attemptId,
    rating: event.rating,
    status: event.status,
    baseServerRevision: event.baseServerRevision,
    clientSequence: event.clientSequence,
    occurredAtClient: event.occurredAtClient,
    deviceId: event.deviceId,
    sessionId: event.sessionId,
    releaseId: event.releaseId,
    contentVersion: event.contentVersion,
    timezoneAtEvent: event.timezoneAtEvent,
    utcOffsetMinutesAtEvent: event.utcOffsetMinutesAtEvent,
    localDateAtEvent: event.localDateAtEvent,
    timezoneSource: event.timezoneSource,
  };
}

/**
 * Reconstruct a scheduler `ReviewEvent` from its stored record. Every field the
 * scheduler needs is required — a record missing one is corrupt (never written
 * by this adapter), so we fail loudly rather than replay a partial chain.
 */
function eventFromRecord(record: ReviewEventRecord): ReviewEvent {
  const required = {
    attemptId: record.attemptId,
    rating: record.rating,
    status: record.status,
    baseServerRevision: record.baseServerRevision,
    clientSequence: record.clientSequence,
    occurredAtClient: record.occurredAtClient,
    deviceId: record.deviceId,
    sessionId: record.sessionId,
    releaseId: record.releaseId,
    contentVersion: record.contentVersion,
    timezoneAtEvent: record.timezoneAtEvent,
    utcOffsetMinutesAtEvent: record.utcOffsetMinutesAtEvent,
    localDateAtEvent: record.localDateAtEvent,
    timezoneSource: record.timezoneSource,
  };
  for (const [key, value] of Object.entries(required)) {
    if (value === undefined) {
      throw new Error(
        `review event ${record.eventId} is missing required scheduler field ${key}`,
      );
    }
  }
  return {
    eventId: record.eventId,
    studyComponentId: record.componentKey,
    attemptId: required.attemptId!,
    rating: required.rating!,
    status: required.status!,
    baseServerRevision: required.baseServerRevision!,
    parentEventId: record.parentEventId,
    clientComponentRevision: record.clientComponentRevision,
    clientSequence: required.clientSequence!,
    occurredAtClient: required.occurredAtClient!,
    deviceId: required.deviceId!,
    sessionId: required.sessionId!,
    releaseId: required.releaseId!,
    contentVersion: required.contentVersion!,
    timezoneAtEvent: required.timezoneAtEvent!,
    utcOffsetMinutesAtEvent: required.utcOffsetMinutesAtEvent!,
    localDateAtEvent: required.localDateAtEvent!,
    timezoneSource: required.timezoneSource!,
  };
}

/**
 * All `scheduling` review events stored for a component AND OWNED BY `owner`, as
 * scheduler events (R2-F3). Scoping by owner is what stops a signed-in account's
 * new review from parenting a guest's (or another account's) event for the same
 * natural key — that guest event is never uploaded, so parenting it would strand
 * the account event as unknown-parent forever server-side. The owner filter is
 * in memory (over the small per-component chain) because IndexedDB cannot index
 * a null/guest owner.
 */
async function readComponentEvents(
  db: SafwaDb,
  componentKey: string,
  owner: LocalOwnerId,
): Promise<ReviewEvent[]> {
  const records = await db.reviewEvents
    .where("[ownerKey+componentKey]")
    .equals(ownedKey(owner, componentKey))
    .toArray();
  return records
    .filter((record) => record.status === "scheduling")
    .map(eventFromRecord);
}

/**
 * Derive the lineage for a NEW event when this account has no local events for
 * the component but a server pull left a lineage anchor (R2-F2). Returns a
 * lineage parented on the accepted server head so the event extends the server
 * chain (not a stale-branch root the server rejects), or null when there is no
 * usable anchor (fall back to a fresh root). The anchor is only trusted when the
 * component row is owned by this account.
 */
async function anchorLineage(
  db: SafwaDb,
  componentKey: string,
  owner: LocalOwnerId,
  ids: { eventId: string; clientSequence: number },
): Promise<EventLineage | null> {
  const component = await db.studyComponents.get(ownedKey(owner, componentKey));
  if (
    !component ||
    !component.syncedHeadEventId ||
    component.syncedHeadClientRevision == null
  ) {
    return null;
  }
  return {
    eventId: ids.eventId,
    parentEventId: component.syncedHeadEventId,
    // The head was accepted at the component's current server revision.
    baseServerRevision: component.revision ?? 0,
    clientComponentRevision: component.syncedHeadClientRevision + 1,
    clientSequence: ids.clientSequence,
  };
}

/**
 * The next monotonic per-device client sequence. The last-issued value lives on
 * the DEVICE PROFILE (schema v7) so allocation is O(1) per event rather than a
 * full `review_events` scan. The counter only ever advances (never reused, even
 * across an undo), which is exactly the total-ordering guarantee the sync
 * pipeline expects — and the device profile is the only home that can promise
 * that across identities, since it survives a sign-out and a merge that removes
 * the guest's rows, whereas an owner-keyed settings row would not.
 *
 * A one-time max scan over the existing events seeds the counter (covering a
 * database whose profile predates the field); a fresh database starts at 0. Must
 * run inside a transaction that includes `db.profile` and `db.reviewEvents`. If
 * no profile row exists yet — the device has never made a durable write — the
 * value cannot be persisted, so the scan repeats next time; the numbers issued
 * are still monotonic.
 */
async function nextClientSequence(db: SafwaDb): Promise<number> {
  const profile = await db.profile.get(DEVICE_PROFILE_KEY);
  let last = profile?.lastClientSequence;
  if (typeof last !== "number") {
    last = 0;
    await db.reviewEvents.each((event) => {
      if (typeof event.clientSequence === "number") {
        last = Math.max(last as number, event.clientSequence);
      }
    });
  }
  const next = last + 1;
  if (profile) {
    await db.profile.update(DEVICE_PROFILE_KEY, { lastClientSequence: next });
  }
  return next;
}

/**
 * Replay options for every LOCAL chain read (Phase 17 §14). After a guest→account
 * merge the account's local events for a component are a UNION of the two
 * imported histories, so the local paths must accept that shape — deliberately,
 * via the shared scheduler's explicit opt-in, rather than by weakening the
 * default that keeps ordinary sync failing loudly on an unexpected second root.
 */
const LOCAL_REPLAY_OPTIONS = { allowMergeUnion: true } as const;

/**
 * Project and write a component's card + learner state from its full chain, for
 * the OWNER whose events these are. The `events` passed in are already
 * owner-scoped (from `readComponentEvents`), so an empty set means THIS owner has
 * no remaining scheduling events for the component — revert it to never-reviewed.
 * Since schema v7 the row's identity is `[ownerKey+componentKey]`, so writing an
 * account's card can no longer replace a guest's card for the same component:
 * both coexist until the guest's rows are merged or explicitly removed.
 */
async function writeComponentProjection(
  db: SafwaDb,
  componentKey: string,
  entryId: number,
  events: readonly ReviewEvent[],
  now: number,
  owner: LocalOwnerId,
): Promise<void> {
  if (events.length === 0) {
    // No scheduling events remain (e.g. after undoing the only one): the
    // component reverts to never-reviewed — remove the stale card row.
    await db.studyComponents.delete(ownedKey(owner, componentKey));
    return;
  }
  const replay = replayChain(events, LOCAL_REPLAY_OPTIONS);
  const record: StudyComponentRecord = {
    ownerKey: toOwnerKey(owner),
    componentKey,
    entryId,
    fsrs: replay.card ?? undefined,
    learnerState: learnerStateFromReplay(replay, now),
    // The union's HIGHEST revision, which a new review must exceed — equal to
    // the head's own revision for an ordinary single chain (§14).
    revision: replay.headRevision,
  };
  await db.studyComponents.put(record);
}

/**
 * Re-project a component's local card from `chain`, but ONLY when the chain
 * contains its own whole history (the shared scheduler's `complete`). A
 * bootstrapped / anchor-managed component (R2-F2) is SERVER-authoritative: the
 * replay would start from a fresh card partway through a real history, so its
 * pulled card stands and the next pull delivers the advanced authoritative state.
 * An empty chain reverts a genuine local component to never-reviewed, but LEAVES
 * a bootstrapped component's pulled card intact (its authoritative state is not
 * local work to erase).
 */
async function reprojectLocalChain(
  db: SafwaDb,
  componentKey: string,
  entryId: number,
  chain: readonly ReviewEvent[],
  now: number,
  owner: LocalOwnerId,
): Promise<void> {
  if (chain.length === 0) {
    const component = await db.studyComponents.get(
      ownedKey(owner, componentKey),
    );
    if (!component?.syncedHeadEventId) {
      await db.studyComponents.delete(ownedKey(owner, componentKey));
    }
    return;
  }
  // Anchor-managed / partial history: the pulled card stands.
  if (!replayChain(chain, LOCAL_REPLAY_OPTIONS).complete) return;
  await writeComponentProjection(db, componentKey, entryId, chain, now, owner);
}

/**
 * Persist one graded study attempt (flashcard OR multiple-choice — the wiring is
 * identical in every mode). Writes the attempt row (and lazily the session row);
 * when the attempt is scheduling-relevant it also derives the next chain event,
 * writes it, and updates the component's replayed card + state. On first progress
 * (`context.bindProfile`) the device profile is created in the SAME transaction,
 * so device identity is atomic with the write — a failure leaves no orphaned
 * profile. Everything commits in one read-write transaction. Returns the undo
 * unit plus the effective (committed) device id.
 */
export async function recordGradedAttempt(
  db: SafwaDb,
  attempt: AttemptRecord,
  context: RecordAttemptContext,
): Promise<PersistedAttempt> {
  const componentKey = attempt.studyComponentId;
  return db.transaction(
    "rw",
    [
      db.studyAttempts,
      db.reviewEvents,
      db.studyComponents,
      db.sessions,
      db.profile,
      db.mutationQueue,
    ],
    async () => {
      // Bind the device identity atomically with this write (first progress):
      // reuse an already-bound profile, else create the provisional one here so
      // a rollback leaves NO orphaned identity. The rows are stamped with the
      // effective (committed) device id.
      let deviceId = attempt.deviceId;
      if (context.bindProfile) {
        const existingProfile = await db.profile.get(DEVICE_PROFILE_KEY);
        if (existingProfile) {
          deviceId = existingProfile.deviceId;
        } else {
          await db.profile.add(context.bindProfile);
          deviceId = context.bindProfile.deviceId;
        }
      }
      const boundAttempt: AttemptRecord =
        deviceId === attempt.deviceId ? attempt : { ...attempt, deviceId };

      // The attempt's own owner keys the session, the attempt row and — below —
      // its scheduling event, so every row this write produces belongs to one
      // identity and none of them can replace another identity's rows.
      const ownerKey = toOwnerKey(boundAttempt.userId);
      if ((await db.sessions.get(boundAttempt.sessionId)) === undefined) {
        await db.sessions.add({
          id: boundAttempt.sessionId,
          ownerKey,
          startedAt: context.sessionStartedAt ?? context.now,
        });
      }
      await db.studyAttempts.put({
        id: boundAttempt.id,
        ownerKey,
        componentKey,
        sessionId: boundAttempt.sessionId,
        attemptedAt: context.now,
        attempt: boundAttempt,
      });

      if (!shouldCreateEvent(boundAttempt)) {
        // Reinforcement-only attempt (no scheduling event): history that must
        // still sync (§11, EXT-F2) but never advances FSRS. A signed-in
        // account's reinforcement attempt is enqueued to the sync outbox
        // (owner from the attempt itself, matching EXT-F1 scheduling ownership);
        // a guest's (userId null) is not — it syncs on the Phase-17 merge.
        if (boundAttempt.userId) {
          const wire = toWireAttempt(boundAttempt);
          if (wire) {
            await enqueueReinforcementMutation(db, {
              userId: boundAttempt.userId,
              attempt: wire,
              now: context.now,
            });
          }
        }
        return {
          attemptId: boundAttempt.id,
          componentKey,
          eventId: null,
          deviceId,
        };
      }

      // Owner (R2-F3): the attempt carries the account id (null = guest). The
      // event + component projection are stamped with it, and the chain read is
      // scoped to it, so a signed-in review only ever extends this account's
      // own chain — never a guest's leftover local chain for the same key.
      const owner = boundAttempt.userId;
      const existing = await readComponentEvents(db, componentKey, owner);
      const ids = {
        eventId: context.eventId,
        clientSequence: await nextClientSequence(db),
      };
      // Extend the OWNED local chain if there is one — deriveNextLineage parents
      // on its chronological head and takes the revision from the set's maximum,
      // so a component whose history was MERGED continues correctly from both
      // imported chains (§14). Otherwise, on a fresh device / post-logout, extend
      // the server chain via the pulled anchor (R2-F2); only with neither does
      // the event root a new chain.
      const lineage =
        existing.length > 0
          ? deriveNextLineage(existing, ids, 0, LOCAL_REPLAY_OPTIONS)
          : ((await anchorLineage(db, componentKey, owner, ids)) ??
            deriveLineage(null, ids));
      const event = createReviewEvent(boundAttempt, lineage);
      await db.reviewEvents.put(toEventRecord(event, context.now, owner));
      // Re-project only a complete local chain; a bootstrapped/anchor-managed
      // component keeps its pulled authoritative card (R2-F2, see helper).
      await reprojectLocalChain(
        db,
        componentKey,
        boundAttempt.entryId,
        [...existing, event],
        context.now,
        owner,
      );
      return {
        attemptId: boundAttempt.id,
        componentKey,
        eventId: event.eventId,
        deviceId,
      };
    },
  );
}

/**
 * Reverse exactly one recorded attempt (single-step undo), atomically — but only
 * while the reversed event is still the chain HEAD. If a later review already
 * extends it (its eventId is another event's parent — e.g. the same component
 * graded again in another tab sharing this IndexedDB), the undo is REJECTED: the
 * transaction throws `SupersededUndoError`, rolling back so everything stays
 * consistent (rebasing a superseded branch is Phase 19).
 *
 * DURABLE POST-SYNC UNDO (EXT-F3, §16). How a scheduling event is reversed
 * depends on whether the SERVER has it:
 *   - `syncStatus === "local"` (never sent): the server never saw it, so the
 *     event row and its attempt are physically deleted together and the chain
 *     re-replayed — a clean local reversal.
 *   - otherwise (accepted/pushed/…): a physical delete would DIVERGE from the
 *     server, which would keep replaying the event. Instead we queue a
 *     revocation mutation (pushed + replayed server-side), mark the event
 *     `revoked` locally (the projection filters non-`scheduling` events, so FSRS
 *     reflects the undo immediately), and KEEP the event + its attempt as history
 *     — revocation affects the scheduling effect and replay, not the historical
 *     existence of the attempt (§16). The undo only reports success once that
 *     revocation is durably queued (this transaction commits).
 *
 * A reinforcement-recovery attempt (no event) always undoes (and retracts any
 * queued reinforcement mutation). Idempotent on an already-undone attempt.
 * Mode-agnostic — the undo unit is the same for flashcards and multiple choice.
 */
export async function undoGradedAttempt(
  db: SafwaDb,
  persisted: PersistedAttempt,
  now: number,
): Promise<void> {
  await db.transaction(
    "rw",
    [db.studyAttempts, db.reviewEvents, db.studyComponents, db.mutationQueue],
    async () => {
      if (persisted.eventId !== null) {
        const componentKey = persisted.componentKey;
        // Owner: scope the chain read + reprojection to the attempt ROW's owner
        // so undo never reads or rewrites another identity's chain. The row's
        // `ownerKey` — not the embedded payload's `userId` — is authoritative:
        // a merge re-keys imported rows to the account while deliberately
        // leaving the immutable engine payload (and its original guest owner)
        // untouched as history.
        // An absent row (already undone) or an unreadable owner key both fall
        // back to the guest owner, exactly as before — the paths below then
        // find no owned chain and no server-known event to revoke.
        const owner =
          tryParseOwnerKey(
            (await db.studyAttempts.get(persisted.attemptId))?.ownerKey,
          ) ?? null;
        const chain = await readComponentEvents(db, componentKey, owner);
        // A later event depending on this one means it is no longer the head;
        // reject before touching anything so the chain stays consistent.
        const superseded = chain.some(
          (event) => event.parentEventId === persisted.eventId,
        );
        if (superseded) {
          throw new SupersededUndoError(
            `event ${persisted.eventId} was superseded by a later review and can no longer be undone`,
          );
        }
        const record = await db.reviewEvents.get(persisted.eventId);
        // Idempotent: an already-undone (revoked) event is a no-op — never
        // enqueue a second revocation (REL-002/ARCH-002). A revoked event is
        // already excluded from `chain` (readComponentEvents filters
        // `scheduling`), so this is the direct check.
        if (record?.status === "revoked") return;
        // A `pushed` event is still HELD server-side (pending, not yet
        // authoritative). Revoking it now would be rejected non-recoverably and
        // silently lost, and a later pull would resurrect it — so defer the undo
        // transiently rather than lose it (REL-001). The caller keeps the undo
        // affordance and retries once it resolves to `accepted`.
        if (record?.syncStatus === "pushed") {
          throw new UndoNotYetSyncedError(
            `event ${persisted.eventId} is still syncing and cannot be undone yet`,
          );
        }
        // The server holds the event AUTHORITATIVELY only when accepted/demoted;
        // `local` (never sent) and `rejected` (server refused it) are not
        // server-authoritative, so they take the safe physical-delete path below.
        const serverKnown =
          record != null &&
          (record.syncStatus === "accepted" || record.syncStatus === "demoted");
        if (serverKnown) {
          // Durable post-sync undo: queue a revocation, mark the event revoked,
          // keep it + its attempt, and reproject with it excluded (the
          // projection ignores non-`scheduling` events). Owner from the attempt
          // (resolved above, R2-F3).
          if (!owner) {
            // Invariant: only owned events are ever pushed (selectUnsyncedScheduling
            // gates on attempt.userId), so a server-known event always resolves an
            // owner. Refuse rather than mark revoked with NO durable revocation —
            // that would be exactly the silent divergence EXT-F3 removes (ARCH-001).
            throw new Error(
              `server-known event ${persisted.eventId} has no resolvable owner; refusing to revoke without a durable revocation`,
            );
          }
          await enqueueRevocationMutation(db, {
            userId: owner,
            revocation: {
              revocationId: uuidv7(now),
              eventId: persisted.eventId,
              studyComponentId: componentKey,
              deviceId: record.deviceId ?? persisted.deviceId,
              occurredAtClient: new Date(now).toISOString(),
            },
            now,
          });
          await db.reviewEvents.update(persisted.eventId, {
            status: "revoked",
          });
          // Reproject from the chain WITHOUT the revoked head — the SAME input
          // shape as the delete path (scheduling-only events), so an empty
          // result correctly reverts the component to never-reviewed. The event
          // ROW is kept (marked `revoked`) and is excluded from every future read
          // (readComponentEvents filters `status === "scheduling"`).
          const remaining = chain.filter(
            (event) => event.eventId !== persisted.eventId,
          );
          await reprojectLocalChain(
            db,
            componentKey,
            entryIdFromComponentKey(componentKey),
            remaining,
            now,
            owner,
          );
          // KEEP the attempt (history) — do not fall through to the delete.
          return;
        }
        // Unsynced (local) event: the server never saw it — safe physical delete.
        await db.reviewEvents.delete(persisted.eventId);
        const remaining = chain.filter(
          (event) => event.eventId !== persisted.eventId,
        );
        await reprojectLocalChain(
          db,
          componentKey,
          entryIdFromComponentKey(componentKey),
          remaining,
          now,
          owner,
        );
      } else {
        // A reinforcement-only attempt (no scheduling event) may have been
        // enqueued to the sync outbox (EXT-F2). Undoing it removes that queued
        // row so the server never records an attempt the user reversed
        // (REL-001). A `local` row was never transmitted, so this fully retracts
        // it. A `pushed` row was already sent once and the server replied
        // `pending` (still processing) — deleting it cancels any RESEND but
        // cannot recall the in-flight copy; that residual resolves under the
        // accepted Stage-A eventual-consistency posture (reinforcement is
        // analytics history, not authoritative scheduling, and has no revocation
        // path). Once the server has ACCEPTED the attempt the queued row is
        // already gone (acked + deleted), so there is nothing here to remove.
        const queued = await db.mutationQueue
          .where("idempotencyKey")
          .equals(`reinforcement:${persisted.attemptId}`)
          .first();
        if (queued?.seq !== undefined) {
          await db.mutationQueue.delete(queued.seq);
        }
      }
      await db.studyAttempts.delete(persisted.attemptId);
    },
  );
}

/** The stored scheduling inputs the mixed-revision planner consumes. */
export type SchedulingSnapshot = {
  components: StoredComponentState[];
  /** Scheduling review events, for the daily-target accounting. */
  events: SchedulingEventSummary[];
};

/**
 * Read the mixed-revision planning inputs in one consistent view: every
 * stored component's scheduling state, and the review-event slices the
 * daily-target accounting consumes. Both stores are read inside a single
 * read transaction so a concurrent grade in another tab can never yield a
 * view that disagrees with itself — WITHIN this snapshot's own two fields.
 *
 * As of Phase 13, weakness scores come from `modules/analytics/weakness.ts`
 * via `modules/analytics/weakness-persistence.ts`'s `loadWeaknessView` (the
 * one authoritative weakness pipeline, shared with Weak Areas and the Custom
 * Session weak filter) — this snapshot no longer reads `study_attempts` at
 * all, retiring the Phase 10 v1 weak-item heuristic's independent attempt
 * scan. Callers (mixed-session.tsx, custom-session.tsx) therefore now
 * compose this read with a SEPARATE `loadWeaknessView` call: the combined
 * view is no longer atomic end to end — a grade landing in the gap between
 * the two reads (a genuinely rare cross-tab race, bounded to one event's
 * worth of skew) could pair this snapshot's card/state for a component with
 * a weakness score computed from a slightly different moment. Accepted:
 * `loadWeaknessView` is read-only (§14.4-style, via
 * `readAnalyticsRawSnapshot` — no cache write), so the only cost is this
 * narrowed consistency window, never a lost or corrupted write.
 */
export async function readSchedulingSnapshot(
  db: SafwaDb,
  owner: LocalOwnerId,
): Promise<SchedulingSnapshot> {
  return db.transaction(
    "r",
    [db.studyComponents, db.reviewEvents],
    async () => {
      // Owner-scoped (R2-F3): a signed-in account's scheduling plan considers
      // only its own components/events, never a pre-login guest's rows that
      // share the store before the logout wipe.
      const componentRecords = await readOwnedRows(db.studyComponents, owner);
      const eventRows = await readOwnedRows(db.reviewEvents, owner);
      const components: StoredComponentState[] = componentRecords.map(
        (record: StudyComponentRecord) => ({
          componentKey: record.componentKey,
          fsrs: record.fsrs,
          learnerState: record.learnerState,
        }),
      );
      const events: SchedulingEventSummary[] = eventRows.map(
        (record: ReviewEventRecord) => ({
          componentKey: record.componentKey,
          parentEventId: record.parentEventId,
          status: record.status ?? null,
          localDateAtEvent: record.localDateAtEvent ?? null,
        }),
      );
      return { components, events };
    },
  );
}

/** Extract the numeric entry id from a component key (`entry:{id}:...`). */
function entryIdFromComponentKey(componentKey: string): number {
  const match = /^entry:([1-9][0-9]*):/.exec(componentKey);
  if (!match) {
    throw new Error(`malformed component key ${JSON.stringify(componentKey)}`);
  }
  return Number(match[1]);
}
