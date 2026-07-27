import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SafwaDb } from "@/modules/content/db";
import { newDeviceProfile } from "@/modules/profile/device";
import type { AttemptRecord } from "@/modules/study-engine";
import {
  readSchedulingSnapshot,
  recordGradedAttempt,
  SupersededUndoError,
  undoGradedAttempt,
} from "@/modules/study-session/persistence";

import { makeAttempt } from "../scheduler/fixtures";

const COMPONENT =
  "entry:1:skill:meaning_recognition:field:madi:direction:arabic_to_english";

/** A flashcard attempt on a translation component (mode = flashcard). */
function flashcardAttempt(
  overrides: Partial<AttemptRecord> = {},
): AttemptRecord {
  return makeAttempt({
    studyComponentId: COMPONENT,
    entryId: 1,
    skillTypeId: "meaning_recognition",
    sourceField: "madi",
    direction: "arabic_to_english",
    promptField: "madi",
    promptRef: { entryId: 1, field: "madi" },
    selectedAnswerRef: null,
    correctAnswerRef: { entryId: 1, field: "meaning" },
    mode: "flashcard",
    ...overrides,
  });
}

let dbCounter = 0;
let db: SafwaDb;

beforeEach(() => {
  dbCounter += 1;
  db = new SafwaDb(`safwa-session-test-${dbCounter}`);
});

afterEach(async () => {
  await db.delete();
});

describe("recordGradedAttempt", () => {
  it("persists an attempt, a scheduling event and the projected card for a first 'I know'", async () => {
    const attempt = flashcardAttempt({ id: "a1", isCorrect: true });
    const persisted = await recordGradedAttempt(db, attempt, {
      eventId: "e1",
      now: 1000,
    });

    expect(persisted).toEqual({
      attemptId: "a1",
      componentKey: COMPONENT,
      eventId: "e1",
      // No bindProfile passed, so the attempt's own device id is echoed back.
      deviceId: "device-1",
    });

    const storedAttempt = await db.studyAttempts.get("a1");
    expect(storedAttempt?.componentKey).toBe(COMPONENT);
    expect(storedAttempt?.attempt).toEqual(attempt);

    const event = await db.reviewEvents.get("e1");
    expect(event?.rating).toBe("good");
    expect(event?.status).toBe("scheduling");
    expect(event?.parentEventId).toBeNull();
    expect(event?.clientComponentRevision).toBe(1);
    expect(event?.attemptId).toBe("a1");

    const component = await db.studyComponents.get(COMPONENT);
    expect(component?.entryId).toBe(1);
    expect(component?.revision).toBe(1);
    expect(component?.fsrs).toBeDefined();
    // A clean first success has begun learning.
    expect(component?.learnerState).toBe("learning");

    const session = await db.sessions.get(attempt.sessionId);
    expect(session).toBeDefined();
  });

  it("records the session start time (not the first-grade time) on the session row", async () => {
    await recordGradedAttempt(
      db,
      flashcardAttempt({ id: "a1", sessionId: "s1", isCorrect: true }),
      { eventId: "e1", now: 1000, sessionStartedAt: 400 },
    );
    expect((await db.sessions.get("s1"))?.startedAt).toBe(400);
  });

  it("maps 'I don't know' to an Again event", async () => {
    const attempt = flashcardAttempt({ id: "a1", isCorrect: false });
    await recordGradedAttempt(db, attempt, { eventId: "e1", now: 1000 });
    const event = await db.reviewEvents.get("e1");
    expect(event?.rating).toBe("again");
    // An Again with no clean success has not started learning.
    const component = await db.studyComponents.get(COMPONENT);
    expect(component?.learnerState).toBe("not_started");
  });

  it("extends the pulled lineage anchor when there are no local events (R2-F2)", async () => {
    // A fresh device / post-logout: the pull left an authoritative component
    // with an anchor but no local review_events.
    await db.studyComponents.put({
      componentKey: COMPONENT,
      entryId: 1,
      userId: "user-1",
      revision: 5,
      learnerState: "needs_review",
      syncedHeadEventId: "head-ev",
      syncedHeadClientRevision: 3,
    });

    await recordGradedAttempt(
      db,
      flashcardAttempt({ id: "a1", userId: "user-1", isCorrect: true }),
      { eventId: "e-new", now: 1000 },
    );

    const event = await db.reviewEvents.get("e-new");
    // Parents on the accepted server head rather than rooting a stale branch.
    expect(event?.parentEventId).toBe("head-ev");
    expect(event?.clientComponentRevision).toBe(4); // headClientRevision + 1
    expect(event?.baseServerRevision).toBe(5); // the component's server revision
    expect(event?.userId).toBe("user-1");

    // The bootstrapped component's pulled card is server-authoritative: it is
    // NOT locally re-projected (the pure replay needs the whole chain from
    // revision 1, which this device lacks). It stands until the event syncs and
    // the next pull returns the advanced authoritative card (R2-F2, Stage A).
    const component = await db.studyComponents.get(COMPONENT);
    expect(component?.revision).toBe(5);
    expect(component?.learnerState).toBe("needs_review");
  });

  it("roots a new chain when there is neither a local head nor an anchor (R2-F2)", async () => {
    await recordGradedAttempt(
      db,
      flashcardAttempt({ id: "a1", userId: "user-1", isCorrect: true }),
      { eventId: "e1", now: 1000 },
    );
    const event = await db.reviewEvents.get("e1");
    expect(event?.parentEventId).toBeNull();
    expect(event?.clientComponentRevision).toBe(1);
  });

  it("ignores ANOTHER owner's anchor and roots its own chain (R2-F3 scoping)", async () => {
    // A guest-owned component anchor must not be extended by the account.
    await db.studyComponents.put({
      componentKey: COMPONENT,
      entryId: 1,
      userId: null, // guest
      revision: 5,
      syncedHeadEventId: "guest-head",
      syncedHeadClientRevision: 3,
    });

    await recordGradedAttempt(
      db,
      flashcardAttempt({ id: "a1", userId: "user-1", isCorrect: true }),
      { eventId: "e-new", now: 1000 },
    );

    const event = await db.reviewEvents.get("e-new");
    expect(event?.parentEventId).toBeNull(); // ignored the guest anchor
    expect(event?.clientComponentRevision).toBe(1);
  });

  it("writes an attempt but NO event for a reinforcement recovery", async () => {
    // First attempt (wrong) creates the event.
    await recordGradedAttempt(
      db,
      flashcardAttempt({ id: "a1", isCorrect: false }),
      { eventId: "e1", now: 1000 },
    );
    // In-session reinforcement recovery: not a first attempt, flagged
    // reinforcement — creates no second event.
    const recovery = flashcardAttempt({
      id: "a2",
      isCorrect: true,
      isFirstAttempt: false,
      isReinforcement: true,
    });
    const persisted = await recordGradedAttempt(db, recovery, {
      eventId: "e2",
      now: 2000,
    });

    expect(persisted.eventId).toBeNull();
    expect(await db.studyAttempts.get("a2")).toBeDefined();
    expect(await db.reviewEvents.get("e2")).toBeUndefined();
    // Exactly one event for the component.
    expect(
      await db.reviewEvents.where("componentKey").equals(COMPONENT).count(),
    ).toBe(1);
  });

  it("links a sequential chain across sessions with monotonic revisions", async () => {
    await recordGradedAttempt(
      db,
      flashcardAttempt({ id: "a1", sessionId: "s1", isCorrect: true }),
      { eventId: "e1", now: 1000 },
    );
    await recordGradedAttempt(
      db,
      flashcardAttempt({
        id: "a2",
        sessionId: "s2",
        isCorrect: true,
        occurredAtUtc: "2026-07-18T09:30:00.000Z",
      }),
      { eventId: "e2", now: 2000 },
    );

    const second = await db.reviewEvents.get("e2");
    expect(second?.parentEventId).toBe("e1");
    expect(second?.clientComponentRevision).toBe(2);
    expect(second?.clientSequence).toBe(2);

    const component = await db.studyComponents.get(COMPONENT);
    expect(component?.revision).toBe(2);
  });
});

describe("undoGradedAttempt", () => {
  it("removes the attempt, its event and the component when it was the only one", async () => {
    const persisted = await recordGradedAttempt(
      db,
      flashcardAttempt({ id: "a1", isCorrect: true }),
      { eventId: "e1", now: 1000 },
    );

    await undoGradedAttempt(db, persisted, 1500);

    expect(await db.studyAttempts.get("a1")).toBeUndefined();
    expect(await db.reviewEvents.get("e1")).toBeUndefined();
    // No scheduling events remain, so the card row is cleared.
    expect(await db.studyComponents.get(COMPONENT)).toBeUndefined();
  });

  it("restores the prior card when undoing the latest of a chain", async () => {
    await recordGradedAttempt(
      db,
      flashcardAttempt({ id: "a1", sessionId: "s1", isCorrect: true }),
      { eventId: "e1", now: 1000 },
    );
    const second = await recordGradedAttempt(
      db,
      flashcardAttempt({
        id: "a2",
        sessionId: "s2",
        isCorrect: true,
        occurredAtUtc: "2026-07-18T09:30:00.000Z",
      }),
      { eventId: "e2", now: 2000 },
    );

    await undoGradedAttempt(db, second, 2500);

    expect(await db.studyAttempts.get("a2")).toBeUndefined();
    expect(await db.reviewEvents.get("e2")).toBeUndefined();
    // The first event survives; the component reverts to revision 1.
    expect(await db.reviewEvents.get("e1")).toBeDefined();
    const component = await db.studyComponents.get(COMPONENT);
    expect(component?.revision).toBe(1);
  });

  it("rejects undo of a superseded (non-head) event, leaving both rows intact", async () => {
    // e1 then e2 (child of e1) — as if the same component were graded again in
    // another tab sharing this IndexedDB before the first action's undo.
    const first = await recordGradedAttempt(
      db,
      flashcardAttempt({ id: "a1", sessionId: "s1", isCorrect: true }),
      { eventId: "e1", now: 1000 },
    );
    await recordGradedAttempt(
      db,
      flashcardAttempt({
        id: "a2",
        sessionId: "s2",
        isCorrect: true,
        occurredAtUtc: "2026-07-18T09:30:00.000Z",
      }),
      { eventId: "e2", now: 2000 },
    );

    // Undoing e1 is rejected (e2 still depends on it) and rolls back atomically.
    await expect(undoGradedAttempt(db, first, 2500)).rejects.toBeInstanceOf(
      SupersededUndoError,
    );

    // Nothing changed: the attempt row AND both events remain, chain intact.
    expect(await db.studyAttempts.get("a1")).toBeDefined();
    expect(await db.reviewEvents.get("e1")).toBeDefined();
    expect(await db.reviewEvents.get("e2")).toBeDefined();
    const component = await db.studyComponents.get(COMPONENT);
    expect(component?.revision).toBe(2);
  });

  it("removes only the attempt for a reinforcement recovery (no event to undo)", async () => {
    await recordGradedAttempt(
      db,
      flashcardAttempt({ id: "a1", isCorrect: false }),
      { eventId: "e1", now: 1000 },
    );
    const recovery = await recordGradedAttempt(
      db,
      flashcardAttempt({
        id: "a2",
        isCorrect: true,
        isFirstAttempt: false,
        isReinforcement: true,
      }),
      { eventId: "e2", now: 2000 },
    );

    await undoGradedAttempt(db, recovery, 2500);

    expect(await db.studyAttempts.get("a2")).toBeUndefined();
    // The first attempt's event is untouched.
    expect(await db.reviewEvents.get("e1")).toBeDefined();
    const component = await db.studyComponents.get(COMPONENT);
    expect(component?.revision).toBe(1);
  });
});

describe("recordGradedAttempt device-profile binding", () => {
  it("creates the device profile atomically with the first attempt", async () => {
    const persisted = await recordGradedAttempt(
      db,
      flashcardAttempt({ id: "a1", deviceId: "prov-1", isCorrect: true }),
      {
        eventId: "e1",
        now: 1000,
        bindProfile: newDeviceProfile("prov-1", 1000),
      },
    );

    expect(persisted.deviceId).toBe("prov-1");
    const profile = await db.profile.get("device");
    expect(profile?.deviceId).toBe("prov-1");
    // The attempt and its event are stamped with the committed device id.
    expect((await db.studyAttempts.get("a1"))?.attempt?.deviceId).toBe(
      "prov-1",
    );
    expect((await db.reviewEvents.get("e1"))?.deviceId).toBe("prov-1");
  });

  it("reuses an already-bound profile id, ignoring the provisional one", async () => {
    await db.profile.add(newDeviceProfile("existing", 500));

    const persisted = await recordGradedAttempt(
      db,
      flashcardAttempt({ id: "a1", deviceId: "prov-1", isCorrect: true }),
      {
        eventId: "e1",
        now: 1000,
        bindProfile: newDeviceProfile("prov-1", 1000),
      },
    );

    // The existing durable id wins; the rows are stamped with it, not "prov-1".
    expect(persisted.deviceId).toBe("existing");
    expect((await db.profile.get("device"))?.deviceId).toBe("existing");
    expect((await db.studyAttempts.get("a1"))?.attempt?.deviceId).toBe(
      "existing",
    );
    expect((await db.reviewEvents.get("e1"))?.deviceId).toBe("existing");
  });

  it("leaves NO profile, attempt or event when the write fails (atomic)", async () => {
    // A malformed scheduling event for this component makes the chain read throw
    // mid-transaction, forcing a rollback of the whole write.
    await db.reviewEvents.add({
      eventId: "bad",
      componentKey: COMPONENT,
      parentEventId: null,
      clientComponentRevision: 1,
      syncStatus: "local",
      createdAt: 0,
      status: "scheduling",
    });

    await expect(
      recordGradedAttempt(
        db,
        flashcardAttempt({ id: "a1", deviceId: "prov-1", isCorrect: true }),
        {
          eventId: "e1",
          now: 1000,
          bindProfile: newDeviceProfile("prov-1", 1000),
        },
      ),
    ).rejects.toBeTruthy();

    // The first-progress profile was never committed, and neither was the write.
    expect(await db.profile.get("device")).toBeUndefined();
    expect(await db.studyAttempts.get("a1")).toBeUndefined();
    expect(await db.reviewEvents.get("e1")).toBeUndefined();
  });
});

describe("readSchedulingSnapshot owner scoping (R2-F3)", () => {
  const ACCOUNT = "user-1";

  it("returns only the owner's own components + events", async () => {
    // A guest component/event (owner null) and an account one (owner ACCOUNT)
    // coexist in the store before a logout wipe.
    await db.studyComponents.add({
      componentKey: "entry:1:guest",
      entryId: 1,
      userId: null,
      learnerState: "learning",
    });
    await db.studyComponents.add({
      componentKey: "entry:2:account",
      entryId: 2,
      userId: ACCOUNT,
      learnerState: "needs_review",
    });
    await db.reviewEvents.add({
      eventId: "ev-guest",
      componentKey: "entry:1:guest",
      parentEventId: null,
      clientComponentRevision: 1,
      syncStatus: "local",
      createdAt: 1,
      status: "scheduling",
      userId: null,
    });
    await db.reviewEvents.add({
      eventId: "ev-account",
      componentKey: "entry:2:account",
      parentEventId: null,
      clientComponentRevision: 1,
      syncStatus: "local",
      createdAt: 2,
      status: "scheduling",
      userId: ACCOUNT,
    });

    const asAccount = await readSchedulingSnapshot(db, ACCOUNT);
    expect(asAccount.components.map((c) => c.componentKey)).toEqual([
      "entry:2:account",
    ]);
    expect(asAccount.events.map((e) => e.componentKey)).toEqual([
      "entry:2:account",
    ]);

    const asGuest = await readSchedulingSnapshot(db, null);
    expect(asGuest.components.map((c) => c.componentKey)).toEqual([
      "entry:1:guest",
    ]);
    expect(asGuest.events.map((e) => e.componentKey)).toEqual([
      "entry:1:guest",
    ]);
  });
});
