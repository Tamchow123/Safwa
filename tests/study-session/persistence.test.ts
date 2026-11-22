import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SafwaDb } from "@/modules/content/db";
import { newDeviceProfile } from "@/modules/profile/device";
import type { AttemptRecord } from "@/modules/study-engine";
import {
  readComponentsSchedulingState,
  readSchedulingSnapshot,
  recordGradedAttempt,
  type PersistedAttempt,
  SupersededUndoError,
  undoGradedAttempt,
} from "@/modules/study-session/persistence";

import { makeAttempt } from "../scheduler/fixtures";
import { GUEST_OWNER_KEY, toOwnerKey } from "@/modules/content/owner-key";

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

    const component = await db.studyComponents.get([
      GUEST_OWNER_KEY,
      COMPONENT,
    ]);
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
    const component = await db.studyComponents.get([
      GUEST_OWNER_KEY,
      COMPONENT,
    ]);
    expect(component?.learnerState).toBe("not_started");
  });

  it("extends the pulled lineage anchor when there are no local events (R2-F2)", async () => {
    // A fresh device / post-logout: the pull left an authoritative component
    // with an anchor but no local review_events.
    await db.studyComponents.put({
      ownerKey: toOwnerKey("user-1"),
      componentKey: COMPONENT,
      entryId: 1,

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
    expect(event?.ownerKey).toBe(toOwnerKey("user-1"));

    // The bootstrapped component's pulled card is server-authoritative: it is
    // NOT locally re-projected (the pure replay needs the whole chain from
    // revision 1, which this device lacks). It stands until the event syncs and
    // the next pull returns the advanced authoritative card (R2-F2, Stage A).
    const component = await db.studyComponents.get([
      toOwnerKey("user-1"),
      COMPONENT,
    ]);
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
      ownerKey: toOwnerKey(null), // guest
      componentKey: COMPONENT,
      entryId: 1,
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

    const component = await db.studyComponents.get([
      GUEST_OWNER_KEY,
      COMPONENT,
    ]);
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
    expect(
      await db.studyComponents.get([GUEST_OWNER_KEY, COMPONENT]),
    ).toBeUndefined();
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
    const component = await db.studyComponents.get([
      GUEST_OWNER_KEY,
      COMPONENT,
    ]);
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
    const component = await db.studyComponents.get([
      GUEST_OWNER_KEY,
      COMPONENT,
    ]);
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
    const component = await db.studyComponents.get([
      GUEST_OWNER_KEY,
      COMPONENT,
    ]);
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
      ownerKey: GUEST_OWNER_KEY,
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
      ownerKey: toOwnerKey(null),
      componentKey: "entry:1:guest",
      entryId: 1,

      learnerState: "learning",
    });
    await db.studyComponents.add({
      ownerKey: toOwnerKey(ACCOUNT),
      componentKey: "entry:2:account",
      entryId: 2,

      learnerState: "needs_review",
    });
    await db.reviewEvents.add({
      ownerKey: toOwnerKey(null),
      eventId: "ev-guest",
      componentKey: "entry:1:guest",
      parentEventId: null,
      clientComponentRevision: 1,
      syncStatus: "local",
      createdAt: 1,
      status: "scheduling",
    });
    await db.reviewEvents.add({
      ownerKey: toOwnerKey(ACCOUNT),
      eventId: "ev-account",
      componentKey: "entry:2:account",
      parentEventId: null,
      clientComponentRevision: 1,
      syncStatus: "local",
      createdAt: 2,
      status: "scheduling",
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

describe("readSchedulingSnapshot qualifiesForNextSkill (Phase 18.5)", () => {
  // makeAttempt's default component: the bāb of entry 1 (objective, so a hint
  // downgrades a correct answer to Hard).
  const BAB = "entry:1:skill:bab_identification";
  const ACCOUNT = "user-1";
  let answers = 0;

  /** One scheduling answer on `day` (its own session, so it always schedules). */
  async function answer(
    day: string,
    correct: boolean,
    options: { hinted?: boolean; owner?: string | null; time?: string } = {},
  ): Promise<PersistedAttempt> {
    answers += 1;
    const occurredAtUtc = `${day}T${options.time ?? "09:30:00.000"}Z`;
    return recordGradedAttempt(
      db,
      makeAttempt({
        id: `q-${answers}`,
        sessionId: `s-${answers}`,
        userId: options.owner ?? null,
        isCorrect: correct,
        hintUsed: options.hinted ?? false,
        hintType: options.hinted ? "first_letter" : null,
        occurredAtUtc,
        localDateAtEvent: day,
      }),
      { eventId: `ev-${answers}`, now: Date.parse(occurredAtUtc) + 1000 },
    );
  }

  async function qualifies(owner: string | null = null) {
    const snapshot = await readSchedulingSnapshot(db, owner);
    return snapshot.components.find((c) => c.componentKey === BAB)
      ?.qualifiesForNextSkill;
  }

  it("two correct answers on the SAME day do not qualify", async () => {
    await answer("2026-07-17", true);
    await answer("2026-07-17", true, { time: "10:00:00.000" });
    expect(await qualifies()).toBe(false);
  });

  it("correct on two separate days qualifies", async () => {
    await answer("2026-07-17", true);
    expect(await qualifies()).toBe(false);
    await answer("2026-07-18", true);
    expect(await qualifies()).toBe(true);
  });

  it("a hinted correct answer is still correct", async () => {
    await answer("2026-07-17", true);
    await answer("2026-07-19", true, { hinted: true });
    const events = await db.reviewEvents.toArray();
    expect(events.map((e) => e.rating)).toEqual(["good", "hard"]);
    expect(await qualifies()).toBe(true);
  });

  it("a wrong latest answer withholds the unlock until it is right again", async () => {
    await answer("2026-07-17", true);
    await answer("2026-07-18", true);
    await answer("2026-07-19", false);
    expect(await qualifies()).toBe(false);
    await answer("2026-07-20", true);
    expect(await qualifies()).toBe(true);
  });

  it("a wrong answer is not a correct day", async () => {
    await answer("2026-07-17", false);
    await answer("2026-07-18", true);
    expect(await qualifies()).toBe(false);
  });

  it("undoing an answer re-evaluates from what remains", async () => {
    await answer("2026-07-17", true);
    const second = await answer("2026-07-18", true);
    expect(await qualifies()).toBe(true);
    await undoGradedAttempt(db, second, Date.parse("2026-07-18T09:40:00.000Z"));
    expect(await qualifies()).toBe(false);
  });

  it("a stored answer whose rating is not a rating is not a correct day, and withholds as the latest", async () => {
    await answer("2026-07-17", true);
    await answer("2026-07-18", true);
    expect(await qualifies()).toBe(true);
    // An unreadable row on a third day (legacy/corrupt: not one of the four
    // ratings) is the latest answer — it must not count, and must not pass as
    // "not wrong" either.
    await db.reviewEvents.add({
      ownerKey: GUEST_OWNER_KEY,
      eventId: "ev-corrupt",
      componentKey: BAB,
      parentEventId: `ev-${answers}`,
      clientComponentRevision: 3,
      syncStatus: "local",
      createdAt: 3,
      status: "scheduling",
      rating: "correct" as never,
      occurredAtClient: "2026-07-19T09:30:00.000Z",
      localDateAtEvent: "2026-07-19",
    });
    expect(await qualifies()).toBe(false);
  });

  it("counts every genuine answer once whatever the chain's shape (two roots)", async () => {
    // One correct answer under the normal chain, then a second ROOT on a later
    // day (as a guest→account merge union leaves) — two correct days.
    await answer("2026-07-17", true);
    await db.reviewEvents.add({
      ownerKey: GUEST_OWNER_KEY,
      eventId: "ev-second-root",
      componentKey: BAB,
      parentEventId: null,
      clientComponentRevision: 1,
      syncStatus: "local",
      createdAt: 2,
      status: "scheduling",
      rating: "good",
      occurredAtClient: "2026-07-18T09:30:00.000Z",
      localDateAtEvent: "2026-07-18",
    });
    expect(await qualifies()).toBe(true);
  });

  describe("history this device does not hold (an account's pulled rows)", () => {
    async function pulledRow(fields: {
      masteryDates?: string[];
      learnerState: "learning" | "mastered" | "needs_review";
    }) {
      await db.studyComponents.put({
        ownerKey: toOwnerKey(ACCOUNT),
        componentKey: BAB,
        entryId: 1,
        revision: 4,
        learnerState: fields.learnerState,
        masteryDates: fields.masteryDates,
        syncedHeadEventId: "head-ev",
        syncedHeadClientRevision: 3,
      });
    }

    it("one server mastery date qualifies an anchor-only component", async () => {
      await pulledRow({
        masteryDates: ["2026-07-20"],
        learnerState: "learning",
      });
      expect(await qualifies(ACCOUNT)).toBe(true);
    });

    it("no server mastery date and a learning state does not", async () => {
      await pulledRow({ masteryDates: [], learnerState: "learning" });
      expect(await qualifies(ACCOUNT)).toBe(false);
    });

    it("a row pulled before mastery dates were stored falls back to its state", async () => {
      await pulledRow({ learnerState: "mastered" });
      expect(await qualifies(ACCOUNT)).toBe(true);
      await pulledRow({ learnerState: "needs_review" });
      expect(await qualifies(ACCOUNT)).toBe(true);
      await pulledRow({ learnerState: "learning" });
      expect(await qualifies(ACCOUNT)).toBe(false);
    });

    it("a wrong local answer on top of the server history still withholds it", async () => {
      await pulledRow({
        masteryDates: ["2026-07-20"],
        learnerState: "learning",
      });
      await answer("2026-07-25", false, { owner: ACCOUNT });
      expect(await qualifies(ACCOUNT)).toBe(false);
    });
  });

  it("is owner-scoped: a guest's answers never qualify an account's component", async () => {
    await answer("2026-07-17", true);
    await answer("2026-07-18", true);
    await db.studyComponents.put({
      ownerKey: toOwnerKey(ACCOUNT),
      componentKey: BAB,
      entryId: 1,
      revision: 1,
      learnerState: "learning",
    });
    expect(await qualifies(null)).toBe(true);
    expect(await qualifies(ACCOUNT)).toBe(false);
  });
});

describe("readComponentsSchedulingState (Phase 18.5)", () => {
  // makeAttempt's default component: the bāb of entry 1.
  const BAB = "entry:1:skill:bab_identification";
  const ROOT = "entry:1:skill:root_identification";
  const OTHER_WORD = "entry:2:skill:bab_identification";
  const ACCOUNT = "user-1";

  async function answerBab(day: string, n: number, owner: string | null) {
    const occurredAtUtc = `${day}T09:30:00.000Z`;
    await recordGradedAttempt(
      db,
      makeAttempt({
        id: `r-${n}`,
        sessionId: `rs-${n}`,
        userId: owner,
        isCorrect: true,
        occurredAtUtc,
        localDateAtEvent: day,
      }),
      { eventId: `rev-${n}`, now: Date.parse(occurredAtUtc) + 1000 },
    );
  }

  it("is the full snapshot's state for exactly the requested components", async () => {
    await answerBab("2026-07-17", 1, null);
    await answerBab("2026-07-18", 2, null);
    await db.studyComponents.put({
      ownerKey: GUEST_OWNER_KEY,
      componentKey: OTHER_WORD,
      entryId: 2,
      revision: 1,
      learnerState: "learning",
    });

    const scoped = await readComponentsSchedulingState(db, null, [BAB, ROOT]);
    const full = await readSchedulingSnapshot(db, null);
    // The same mapper: identical state, unlock signal included.
    expect(scoped).toEqual(
      full.components.filter((component) => component.componentKey === BAB),
    );
    expect(scoped[0].qualifiesForNextSkill).toBe(true);
    // Another word's row is never read; a key with no row is simply absent.
    expect(full.components.map((c) => c.componentKey)).toContain(OTHER_WORD);
    expect(scoped.map((c) => c.componentKey)).toEqual([BAB]);
  });

  it("is owner-scoped: another owner's rows and answers are invisible", async () => {
    await answerBab("2026-07-17", 1, null);
    await answerBab("2026-07-18", 2, null);
    await db.studyComponents.put({
      ownerKey: toOwnerKey(ACCOUNT),
      componentKey: BAB,
      entryId: 1,
      revision: 1,
      learnerState: "learning",
    });

    const asGuest = await readComponentsSchedulingState(db, null, [BAB]);
    const asAccount = await readComponentsSchedulingState(db, ACCOUNT, [BAB]);
    expect(asGuest[0].qualifiesForNextSkill).toBe(true);
    // The account's row, and none of the guest's answers.
    expect(asAccount).toEqual([
      {
        componentKey: BAB,
        fsrs: undefined,
        learnerState: "learning",
        qualifiesForNextSkill: false,
      },
    ]);
    expect(await readComponentsSchedulingState(db, "user-2", [BAB])).toEqual(
      [],
    );
  });
});
