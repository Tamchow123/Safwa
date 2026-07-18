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
  ReviewEventRecord,
  SafwaDb,
  StudyComponentRecord,
} from "@/modules/content/db";
import { DEVICE_PROFILE_KEY } from "@/modules/profile/device";
import type { AttemptRecord } from "@/modules/study-engine/attempts";
import {
  chainHead,
  createReviewEvent,
  deriveLineage,
  projectComponent,
  shouldCreateEvent,
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

/** Map a scheduler `ReviewEvent` to its durable Dexie record. */
function toEventRecord(event: ReviewEvent, now: number): ReviewEventRecord {
  return {
    eventId: event.eventId,
    componentKey: event.studyComponentId,
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

/** All `scheduling` review events stored for a component, as scheduler events. */
async function readComponentEvents(
  db: SafwaDb,
  componentKey: string,
): Promise<ReviewEvent[]> {
  const records = await db.reviewEvents
    .where("componentKey")
    .equals(componentKey)
    .toArray();
  return records
    .filter((record) => record.status === "scheduling")
    .map(eventFromRecord);
}

/** Settings key holding the device's last-issued client sequence (monotonic). */
const CLIENT_SEQUENCE_KEY = "study:client-sequence";

/**
 * The next monotonic per-device client sequence. The last-issued value is kept
 * in an additive `settings` row so allocation is O(1) per event rather than a
 * full `review_events` scan. The counter only ever advances (never reused, even
 * across an undo), which is exactly the total-ordering guarantee the sync
 * pipeline expects. A one-time max scan seeds the counter for any pre-existing
 * events; a fresh Phase-8 database starts at 0. Must run inside a transaction
 * that includes `db.settings`.
 */
async function nextClientSequence(db: SafwaDb, now: number): Promise<number> {
  const record = await db.settings.get(CLIENT_SEQUENCE_KEY);
  let last = typeof record?.value === "number" ? record.value : undefined;
  if (last === undefined) {
    last = 0;
    await db.reviewEvents.each((event) => {
      if (typeof event.clientSequence === "number") {
        last = Math.max(last as number, event.clientSequence);
      }
    });
  }
  const next = last + 1;
  await db.settings.put({
    key: CLIENT_SEQUENCE_KEY,
    value: next,
    updatedAt: now,
  });
  return next;
}

/** Project and write a component's card + learner state from its full chain. */
async function writeComponentProjection(
  db: SafwaDb,
  componentKey: string,
  entryId: number,
  events: readonly ReviewEvent[],
  now: number,
): Promise<void> {
  if (events.length === 0) {
    // No scheduling events remain (e.g. after undoing the only one): the
    // component reverts to never-reviewed — remove the stale card row.
    await db.studyComponents.delete(componentKey);
    return;
  }
  const projection = projectComponent(events, now);
  const head = chainHead(events);
  const record: StudyComponentRecord = {
    componentKey,
    entryId,
    fsrs: projection.card ?? undefined,
    learnerState: projection.state,
    revision: head?.clientComponentRevision ?? 0,
  };
  await db.studyComponents.put(record);
}

/**
 * Persist one graded flashcard attempt. Writes the attempt row (and lazily the
 * session row); when the attempt is scheduling-relevant it also derives the next
 * chain event, writes it, and updates the component's replayed card + state.
 * On first progress (`context.bindProfile`) the device profile is created in the
 * SAME transaction, so device identity is atomic with the write — a failure
 * leaves no orphaned profile. Everything commits in one read-write transaction.
 * Returns the undo unit plus the effective (committed) device id.
 */
export async function recordFlashcardAttempt(
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
      db.settings,
      db.profile,
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

      if ((await db.sessions.get(boundAttempt.sessionId)) === undefined) {
        await db.sessions.add({
          id: boundAttempt.sessionId,
          startedAt: context.sessionStartedAt ?? context.now,
        });
      }
      await db.studyAttempts.put({
        id: boundAttempt.id,
        componentKey,
        sessionId: boundAttempt.sessionId,
        attemptedAt: context.now,
        attempt: boundAttempt,
      });

      if (!shouldCreateEvent(boundAttempt)) {
        return {
          attemptId: boundAttempt.id,
          componentKey,
          eventId: null,
          deviceId,
        };
      }

      const existing = await readComponentEvents(db, componentKey);
      const lineage = deriveLineage(chainHead(existing), {
        eventId: context.eventId,
        clientSequence: await nextClientSequence(db, context.now),
      });
      const event = createReviewEvent(boundAttempt, lineage);
      await db.reviewEvents.put(toEventRecord(event, context.now));
      await writeComponentProjection(
        db,
        componentKey,
        boundAttempt.entryId,
        [...existing, event],
        context.now,
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
 * Reverse exactly one recorded attempt (single-step undo), atomically. For an
 * attempt that created a scheduling event, the attempt row and the event row are
 * removed TOGETHER and the chain re-replayed — but only while the event is still
 * the chain head. If a later review already extends it (its eventId is another
 * event's parent — e.g. the same component graded again in another tab sharing
 * this IndexedDB), the undo is REJECTED: the transaction throws
 * `SupersededUndoError`, rolling back so both rows stay intact and consistent
 * (rebasing a superseded branch is Phase 19). A reinforcement-recovery attempt
 * (no event) always undoes. Idempotent on an already-undone attempt.
 */
export async function undoFlashcardAttempt(
  db: SafwaDb,
  persisted: PersistedAttempt,
  now: number,
): Promise<void> {
  await db.transaction(
    "rw",
    [db.studyAttempts, db.reviewEvents, db.studyComponents],
    async () => {
      if (persisted.eventId !== null) {
        const componentKey = persisted.componentKey;
        const chain = await readComponentEvents(db, componentKey);
        // A later event depending on this one means it is no longer the head;
        // reject before deleting anything so attempt + event remain consistent.
        const superseded = chain.some(
          (event) => event.parentEventId === persisted.eventId,
        );
        if (superseded) {
          throw new SupersededUndoError(
            `event ${persisted.eventId} was superseded by a later review and can no longer be undone`,
          );
        }
        await db.reviewEvents.delete(persisted.eventId);
        const remaining = chain.filter(
          (event) => event.eventId !== persisted.eventId,
        );
        await writeComponentProjection(
          db,
          componentKey,
          entryIdFromComponentKey(componentKey),
          remaining,
          now,
        );
      }
      await db.studyAttempts.delete(persisted.attemptId);
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
