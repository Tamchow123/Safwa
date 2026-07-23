import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/db/client";
import { registerContent } from "@/db/register-content";
import {
  reviewEvents,
  studyAttempts,
  studyComponents,
  studySessions,
  syncAuditLog,
} from "@/db/schema";
import type { AnswerReference } from "@/modules/content/answer-reference";
import { loadVerifiedReleaseCached } from "@/modules/content/server-release-registry";
import {
  buildComponentKey,
  resolveComponentIdentity,
  type ResolvedComponentIdentity,
} from "@/modules/study-engine";
import {
  createQuestionContextFromRelease,
  generateQuestion,
  type QuestionContext,
  type QuestionInstance,
} from "@/modules/study-engine/generator";
import { ingestSchedulingBatch } from "@/modules/sync/server/ingest";
import { replayComponent } from "@/modules/sync/server/replay";
import type { WireAttempt, WireEvent } from "@/modules/sync/protocol";
import { createTestUser } from "@/tests/integration/helpers/users";

const SEED = "ingest-test-seed";
const NOW = Date.parse("2026-07-20T10:01:00.000Z");
const OCCURRED = "2026-07-20T10:00:00.000Z";

type Component = {
  identity: ResolvedComponentIdentity;
  instance: QuestionInstance;
};

let releaseId: string;
let context: QuestionContext;
let comp1: Component;
let comp2: Component;

beforeAll(async () => {
  // Register the real active release so review_events.release_id FKs resolve and
  // resolveReleaseForIngestion can load its manifests.
  const { registered } = await registerContent(getDb());
  releaseId = registered[0]!;
  const verified = await loadVerifiedReleaseCached(releaseId);
  context = createQuestionContextFromRelease(verified.learner);
  const found: Component[] = [];
  for (const entry of context.entries) {
    try {
      const candidate = resolveComponentIdentity({
        entryId: entry.id,
        skillType: "meaning_recognition",
        sourceField: "madi",
        direction: "arabic_to_english",
      });
      const inst = generateQuestion(context, {
        identity: candidate,
        deliveryMode: "mc",
        questionSeed: SEED,
        position: 0,
      });
      found.push({ identity: candidate, instance: inst });
      if (found.length === 2) break;
    } catch {
      // next entry
    }
  }
  if (found.length < 2) throw new Error("need two generatable components");
  [comp1, comp2] = found as [Component, Component];
});

function attempt(
  overrides: Partial<WireAttempt> = {},
  comp: Component = comp1,
): WireAttempt {
  const { identity, instance } = comp;
  return {
    id: randomUUID(),
    sessionId: randomUUID(),
    deviceId: "device-1",
    studyComponentId: buildComponentKey(identity),
    entryId: identity.entryId,
    skillTypeId: "meaning_recognition",
    sourceField: "madi",
    direction: "arabic_to_english",
    promptField: instance.promptField,
    promptRef: instance.promptRef,
    selectedAnswerRef: instance.correctAnswerRef,
    correctAnswerRef: instance.correctAnswerRef,
    isCorrect: true,
    isFirstAttempt: true,
    isReinforcement: false,
    hintUsed: false,
    hintType: null,
    responseTimeMs: 3000,
    questionPosition: 0,
    mode: "mc",
    optionCount: instance.optionCount,
    perQuestionLimitMs: null,
    questionInstanceId: instance.questionInstanceId,
    questionSeed: SEED,
    questionGeneratorVersion: "1",
    releaseId,
    contentVersion: context.contentVersion,
    occurredAtUtc: OCCURRED,
    timezoneAtEvent: "UTC",
    utcOffsetMinutesAtEvent: 0,
    localDateAtEvent: "2026-07-20",
    timezoneSource: "browser_detected",
    ...overrides,
  };
}

function event(
  att: WireAttempt,
  overrides: Partial<WireEvent> = {},
): WireEvent {
  return {
    eventId: randomUUID(),
    studyComponentId: att.studyComponentId,
    attemptId: att.id,
    rating: "good",
    status: "scheduling",
    baseServerRevision: 0,
    parentEventId: null,
    clientComponentRevision: 1,
    clientSequence: 1,
    occurredAtClient: OCCURRED,
    deviceId: "device-1",
    sessionId: att.sessionId,
    releaseId,
    contentVersion: context.contentVersion,
    timezoneAtEvent: "UTC",
    utcOffsetMinutesAtEvent: 0,
    localDateAtEvent: "2026-07-20",
    timezoneSource: "browser_detected",
    ...overrides,
  };
}

function aDistractor(comp: Component = comp1): AnswerReference {
  const { instance } = comp;
  const wrong = instance.allowedAnswerRefs.find(
    (r) =>
      r.entryId !== instance.correctAnswerRef.entryId ||
      r.field !== instance.correctAnswerRef.field,
  );
  if (!wrong) throw new Error("no distractor");
  return wrong;
}

describe("ingestSchedulingBatch", () => {
  it("accepts a new-item objective event and persists authoritative state", async () => {
    const userId = await createTestUser();
    const att = attempt();
    const ev = event(att);
    const { results, serverCursor } = await ingestSchedulingBatch(
      userId,
      [ev],
      [att],
      { nowMs: NOW },
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "accepted", serverRevision: 1 });
    expect(serverCursor).toBe(1);

    const db = getDb();
    const [component] = await db
      .select()
      .from(studyComponents)
      .where(eq(studyComponents.userId, userId));
    expect(component?.revision).toBe(1);
    expect(component?.reps).toBe(1);
    expect(component?.lastSyncSeq).toBe(1);
    const storedEvents = await db
      .select()
      .from(reviewEvents)
      .where(eq(reviewEvents.userId, userId));
    expect(storedEvents).toHaveLength(1);
    expect(storedEvents[0]?.status).toBe("scheduling");
  });

  it("is idempotent — a duplicate event id is stored once and does not re-bump", async () => {
    const userId = await createTestUser();
    const att = attempt();
    const ev = event(att);
    await ingestSchedulingBatch(userId, [ev], [att], { nowMs: NOW });
    const second = await ingestSchedulingBatch(userId, [ev], [att], {
      nowMs: NOW,
    });
    expect(second.results[0]).toMatchObject({
      status: "duplicate",
      duplicate: true,
    });
    const db = getDb();
    const storedEvents = await db
      .select()
      .from(reviewEvents)
      .where(eq(reviewEvents.userId, userId));
    expect(storedEvents).toHaveLength(1);
    const [component] = await db
      .select()
      .from(studyComponents)
      .where(eq(studyComponents.userId, userId));
    expect(component?.revision).toBe(1); // not bumped twice
  });

  it("corrects a false is_correct claim on a wrong answer and audits it (§10)", async () => {
    const userId = await createTestUser();
    // Client selected a distractor but claims correct + Good.
    const att = attempt({ selectedAnswerRef: aDistractor(), isCorrect: true });
    const ev = event(att, { rating: "good" });
    const { results } = await ingestSchedulingBatch(userId, [ev], [att], {
      nowMs: NOW,
    });
    expect(results[0]?.status).toBe("corrected");

    const db = getDb();
    const [storedAttempt] = await db
      .select()
      .from(studyAttempts)
      .where(eq(studyAttempts.userId, userId));
    expect(storedAttempt?.isCorrect).toBe(false); // server-derived, not the claim
    const [storedEvent] = await db
      .select()
      .from(reviewEvents)
      .where(eq(reviewEvents.userId, userId));
    expect(storedEvent?.rating).toBe("again"); // a wrong answer is Again
    const audits = await db
      .select()
      .from(syncAuditLog)
      .where(eq(syncAuditLog.userId, userId));
    expect(audits.some((a) => a.reasonCode === "correctness_corrected")).toBe(
      true,
    );
  });

  it("accepts a sequential two-event chain (both parented, §14.1)", async () => {
    const userId = await createTestUser();
    const a1 = attempt();
    const e1 = event(a1, { clientComponentRevision: 1, parentEventId: null });
    const a2 = attempt();
    const e2 = event(a2, {
      clientComponentRevision: 2,
      parentEventId: e1.eventId,
    });
    const { results } = await ingestSchedulingBatch(
      userId,
      [e1, e2],
      [a1, a2],
      { nowMs: NOW },
    );
    expect(results.every((r) => r.status === "accepted")).toBe(true);
    const db = getDb();
    const [component] = await db
      .select()
      .from(studyComponents)
      .where(eq(studyComponents.userId, userId));
    expect(component?.revision).toBe(2);
    expect(component?.reps).toBe(2);
  });

  it("holds an unknown-parent event as pending without affecting FSRS", async () => {
    const userId = await createTestUser();
    const att = attempt();
    const ev = event(att, {
      clientComponentRevision: 3,
      parentEventId: randomUUID(), // parent never seen
    });
    const { results } = await ingestSchedulingBatch(userId, [ev], [att], {
      nowMs: NOW,
    });
    expect(results[0]).toMatchObject({
      status: "pending",
      reasonCode: "pending_parent",
    });
    const db = getDb();
    const [component] = await db
      .select()
      .from(studyComponents)
      .where(eq(studyComponents.userId, userId));
    // Component created but no scheduling state advanced.
    expect(component?.revision).toBe(0);
    expect(component?.reps).toBe(0);
    const [storedEvent] = await db
      .select()
      .from(reviewEvents)
      .where(eq(reviewEvents.userId, userId));
    expect(storedEvent?.status).toBe("pending_parent");
  });

  it("rejects an unsupported flashcard rating", async () => {
    const userId = await createTestUser();
    const att = attempt({ mode: "flashcard", selectedAnswerRef: null });
    const ev = event(att, { rating: "hard" });
    const { results } = await ingestSchedulingBatch(userId, [ev], [att], {
      nowMs: NOW,
    });
    expect(results[0]).toMatchObject({
      status: "rejected",
      reasonCode: "unsupported_rating",
    });
  });

  it("rejects a reused attempt id with a different payload (§8.5)", async () => {
    const userId = await createTestUser();
    const att = attempt();
    const e1 = event(att);
    await ingestSchedulingBatch(userId, [e1], [att], { nowMs: NOW });
    // A NEW, lineage-valid sequential event (parent = e1) that reuses the same
    // attempt id but with a different immutable payload (a distractor).
    const att2 = { ...att, selectedAnswerRef: aDistractor() };
    const e2 = event(att2, {
      clientComponentRevision: 2,
      parentEventId: e1.eventId,
    });
    const { results } = await ingestSchedulingBatch(userId, [e2], [att2], {
      nowMs: NOW,
    });
    expect(results[0]).toMatchObject({
      status: "rejected",
      reasonCode: "payload_conflict",
    });
    const db = getDb();
    const audits = await db
      .select()
      .from(syncAuditLog)
      .where(eq(syncAuditLog.userId, userId));
    expect(audits.some((a) => a.reasonCode === "payload_conflict")).toBe(true);
  });

  it("rejects a later event whose attempt's immutable fields contradict the event (EXT-F5)", async () => {
    const userId = await createTestUser();
    const a1 = attempt();
    const e1 = event(a1, { clientComponentRevision: 1, parentEventId: null });
    // A crafted second attempt in the SAME component batch whose deviceId does
    // not match its event — only the first attempt was used for group identity,
    // so without per-pair validation this contradictory row would persist.
    const a2 = attempt({ deviceId: "device-2" });
    const e2 = event(a2, {
      clientComponentRevision: 2,
      parentEventId: e1.eventId,
      deviceId: "device-1",
    });
    const { results } = await ingestSchedulingBatch(
      userId,
      [e1, e2],
      [a1, a2],
      { nowMs: NOW },
    );
    expect(results.find((r) => r.itemId === e1.eventId)?.status).toBe(
      "accepted",
    );
    expect(results.find((r) => r.itemId === e2.eventId)).toMatchObject({
      status: "rejected",
      reasonCode: "malformed_item",
    });
    const db = getDb();
    const [component] = await db
      .select()
      .from(studyComponents)
      .where(eq(studyComponents.userId, userId));
    expect(component?.revision).toBe(1); // only the first event was accepted
    // The contradictory second attempt was NOT persisted.
    const attempts = await db
      .select()
      .from(studyAttempts)
      .where(eq(studyAttempts.userId, userId));
    expect(attempts).toHaveLength(1);
  });

  it("rejects a later event whose attempt claims a different natural key (EXT-F5)", async () => {
    const userId = await createTestUser();
    const a1 = attempt(); // comp1
    const e1 = event(a1, { clientComponentRevision: 1, parentEventId: null });
    // a2 keeps comp1's component key on its event but the attempt claims comp2's
    // entry — its natural key no longer derives the declared component.
    const a2 = attempt({ entryId: comp2.identity.entryId });
    const e2 = event(a2, {
      clientComponentRevision: 2,
      parentEventId: e1.eventId,
    });
    const { results } = await ingestSchedulingBatch(
      userId,
      [e1, e2],
      [a1, a2],
      { nowMs: NOW },
    );
    expect(results.find((r) => r.itemId === e1.eventId)?.status).toBe(
      "accepted",
    );
    expect(results.find((r) => r.itemId === e2.eventId)?.status).toBe(
      "rejected",
    );
    const db = getDb();
    const [component] = await db
      .select()
      .from(studyComponents)
      .where(eq(studyComponents.userId, userId));
    expect(component?.revision).toBe(1);
  });

  it("isolates a failing component so the rest of the batch still commits", async () => {
    const userId = await createTestUser();
    // Component A (comp1): a valid event. Component B (comp2, a DISTINCT
    // component → its own transaction): an attempt whose session is pre-owned by
    // another account, forcing ensureSession to throw and abort B's transaction.
    const other = await createTestUser();
    const attB = attempt({}, comp2);
    const db = getDb();
    await db.insert(studySessions).values({
      id: attB.sessionId,
      userId: other, // pre-owned by a different account
      mode: "mc",
      config: {},
      releaseId,
      contentVersion: context.contentVersion,
      startedAt: new Date(NOW),
    });
    const attA = attempt();
    const evA = event(attA);
    const evB = event(attB);
    const { results } = await ingestSchedulingBatch(
      userId,
      [evA, evB],
      [attA, attB],
      { nowMs: NOW },
    );
    const byId = new Map(results.map((r) => [r.itemId, r]));
    expect(byId.get(evA.eventId)?.status).toBe("accepted");
    expect(byId.get(evB.eventId)).toMatchObject({
      status: "rejected",
      reasonCode: "internal_error",
    });
    // Component A committed despite B failing.
    const componentsA = await db
      .select()
      .from(reviewEvents)
      .where(eq(reviewEvents.userId, userId));
    expect(componentsA.some((r) => r.eventId === evA.eventId)).toBe(true);
  });

  it("does not deadlock under two concurrent batches for the same account", async () => {
    const userId = await createTestUser();
    // Two concurrent first-events on the same component: the advisory lock
    // serialises them (component row → cursor, consistent order), so both
    // resolve without a deadlock — one is accepted, the other is a stale branch.
    const a1 = attempt();
    const a2 = attempt();
    const [r1, r2] = await Promise.all([
      ingestSchedulingBatch(userId, [event(a1)], [a1], { nowMs: NOW }),
      ingestSchedulingBatch(userId, [event(a2)], [a2], { nowMs: NOW }),
    ]);
    const statuses = [r1.results[0]?.status, r2.results[0]?.status].sort();
    expect(statuses).toEqual(["accepted", "rejected"]);
    const db = getDb();
    const stored = await db
      .select()
      .from(reviewEvents)
      .where(eq(reviewEvents.userId, userId));
    expect(stored).toHaveLength(1); // only the accepted one persists
  });

  it("persisted component state equals a fresh replay (replay invariant, §15)", async () => {
    const userId = await createTestUser();
    const a1 = attempt();
    const e1 = event(a1, { clientComponentRevision: 1, parentEventId: null });
    const a2 = attempt();
    const e2 = event(a2, {
      clientComponentRevision: 2,
      parentEventId: e1.eventId,
    });
    await ingestSchedulingBatch(userId, [e1, e2], [a1, a2], { nowMs: NOW });

    const db = getDb();
    const [component] = await db
      .select()
      .from(studyComponents)
      .where(eq(studyComponents.userId, userId));
    const stored = await db
      .select()
      .from(reviewEvents)
      .where(eq(reviewEvents.userId, userId));
    const fresh = replayComponent(
      stored.map((r) => ({
        eventId: r.eventId,
        status: r.status as "scheduling",
        rating: r.rating as "good",
        clientComponentRevision: r.clientComponentRevision,
        parentEventId: r.parentEventId,
        occurredAtCanonical: r.occurredAtCanonical,
        localDateAtEvent: r.localDateAtEvent,
      })),
      NOW,
    );
    expect(component?.reps).toBe(fresh.reps);
    expect(component?.stability).toBeCloseTo(fresh.stability ?? 0, 6);
    expect(component?.learnerState).toBe(fresh.learnerState);
  });

  describe("reinforcement-only attempts (T9b, §12)", () => {
    it("persists a reinforcement attempt as history without advancing FSRS", async () => {
      const userId = await createTestUser();
      const att = attempt({ isReinforcement: true, isFirstAttempt: false });
      const { results, serverCursor } = await ingestSchedulingBatch(
        userId,
        [], // no scheduling event
        [att],
        { nowMs: NOW },
      );
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        itemId: att.id,
        itemKind: "attempt",
        status: "accepted",
      });
      // No scheduling change → the account cursor does not move.
      expect(serverCursor).toBe(0);

      const db = getDb();
      const storedAttempts = await db
        .select()
        .from(studyAttempts)
        .where(eq(studyAttempts.userId, userId));
      expect(storedAttempts).toHaveLength(1);
      expect(storedAttempts[0]?.isReinforcement).toBe(true);
      // NO review event and NO FSRS advance.
      const storedEvents = await db
        .select()
        .from(reviewEvents)
        .where(eq(reviewEvents.userId, userId));
      expect(storedEvents).toHaveLength(0);
      const [component] = await db
        .select()
        .from(studyComponents)
        .where(eq(studyComponents.userId, userId));
      expect(component?.revision).toBe(0);
      expect(component?.reps).toBe(0);
    });

    it("is idempotent — a duplicate reinforcement attempt id is stored once", async () => {
      const userId = await createTestUser();
      const att = attempt({ isReinforcement: true, isFirstAttempt: false });
      await ingestSchedulingBatch(userId, [], [att], { nowMs: NOW });
      const second = await ingestSchedulingBatch(userId, [], [att], {
        nowMs: NOW,
      });
      expect(second.results[0]).toMatchObject({
        itemKind: "attempt",
        status: "duplicate",
        duplicate: true,
      });
      const db = getDb();
      const storedAttempts = await db
        .select()
        .from(studyAttempts)
        .where(eq(studyAttempts.userId, userId));
      expect(storedAttempts).toHaveLength(1);
    });

    it("corrects a false is_correct claim on a reinforcement attempt (server-canonical)", async () => {
      const userId = await createTestUser();
      const att = attempt({
        isReinforcement: true,
        isFirstAttempt: false,
        selectedAnswerRef: aDistractor(),
        isCorrect: true, // client claim overridden
      });
      const { results } = await ingestSchedulingBatch(userId, [], [att], {
        nowMs: NOW,
      });
      expect(results[0]?.status).toBe("corrected");

      const db = getDb();
      const [stored] = await db
        .select()
        .from(studyAttempts)
        .where(eq(studyAttempts.userId, userId));
      expect(stored?.isCorrect).toBe(false); // server-derived, not the claim
      const audits = await db
        .select()
        .from(syncAuditLog)
        .where(eq(syncAuditLog.userId, userId));
      expect(audits.some((a) => a.reasonCode === "correctness_corrected")).toBe(
        true,
      );
    });

    it("rejects a no-event attempt that is not marked reinforcement (malformed_item)", async () => {
      const userId = await createTestUser();
      const att = attempt({ isReinforcement: false }); // no event, not reinforcement
      const { results } = await ingestSchedulingBatch(userId, [], [att], {
        nowMs: NOW,
      });
      expect(results[0]).toMatchObject({
        itemKind: "attempt",
        status: "rejected",
        reasonCode: "malformed_item",
      });
      const db = getDb();
      const storedAttempts = await db
        .select()
        .from(studyAttempts)
        .where(eq(studyAttempts.userId, userId));
      expect(storedAttempts).toHaveLength(0);
    });

    it("rejects a reinforcement attempt whose natural key contradicts the component (EXT-F5)", async () => {
      const userId = await createTestUser();
      const a1 = attempt({ isReinforcement: true, isFirstAttempt: false });
      // Same component key, but the second reinforcement attempt claims a
      // different entry — its natural key no longer derives the component.
      const a2 = attempt({
        isReinforcement: true,
        isFirstAttempt: false,
        entryId: comp2.identity.entryId,
      });
      const { results } = await ingestSchedulingBatch(userId, [], [a1, a2], {
        nowMs: NOW,
      });
      expect(results.find((r) => r.itemId === a1.id)?.status).toBe("accepted");
      expect(results.find((r) => r.itemId === a2.id)?.status).toBe("rejected");
      const db = getDb();
      const stored = await db
        .select()
        .from(studyAttempts)
        .where(eq(studyAttempts.userId, userId));
      expect(stored).toHaveLength(1); // only the valid reinforcement attempt
    });

    it("a reinforcement attempt never bumps a scheduled component's revision or the cursor", async () => {
      const userId = await createTestUser();
      // First a real scheduling event → revision 1, cursor 1.
      const a1 = attempt();
      const e1 = event(a1);
      await ingestSchedulingBatch(userId, [e1], [a1], { nowMs: NOW });

      // Then a reinforcement attempt for the SAME component.
      const a2 = attempt({ isReinforcement: true, isFirstAttempt: false });
      const { results, serverCursor } = await ingestSchedulingBatch(
        userId,
        [],
        [a2],
        { nowMs: NOW },
      );
      expect(results[0]?.status).toBe("accepted");
      expect(serverCursor).toBe(1); // unchanged by the reinforcement attempt

      const db = getDb();
      const [component] = await db
        .select()
        .from(studyComponents)
        .where(eq(studyComponents.userId, userId));
      expect(component?.revision).toBe(1); // still just the one scheduling event
      const storedEvents = await db
        .select()
        .from(reviewEvents)
        .where(eq(reviewEvents.userId, userId));
      expect(storedEvents).toHaveLength(1); // no new event from the reinforcement
      const storedAttempts = await db
        .select()
        .from(studyAttempts)
        .where(eq(studyAttempts.userId, userId));
      expect(storedAttempts).toHaveLength(2); // both attempts stored as history
    });
  });

  describe("pending-parent reprocessor (T9c, §14.2)", () => {
    it("promotes a held child when its parent arrives in a later batch", async () => {
      const userId = await createTestUser();
      const attP = attempt();
      const pid = randomUUID();
      const p = event(attP, {
        eventId: pid,
        clientComponentRevision: 1,
        parentEventId: null,
      });
      const attC = attempt();
      const c = event(attC, { clientComponentRevision: 2, parentEventId: pid });

      // Batch 1: the child arrives before its parent → held pending.
      const first = await ingestSchedulingBatch(userId, [c], [attC], {
        nowMs: NOW,
      });
      expect(first.results[0]).toMatchObject({
        status: "pending",
        reasonCode: "pending_parent",
      });
      const db = getDb();
      let [component] = await db
        .select()
        .from(studyComponents)
        .where(eq(studyComponents.userId, userId));
      expect(component?.revision).toBe(0); // a pending child does not advance the chain

      // Batch 2: the parent arrives → parent accepted AND the held child promoted.
      const second = await ingestSchedulingBatch(userId, [p], [attP], {
        nowMs: NOW,
      });
      expect(second.results[0]).toMatchObject({ status: "accepted" });
      const events = await db
        .select()
        .from(reviewEvents)
        .where(eq(reviewEvents.userId, userId));
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.status === "scheduling")).toBe(true);
      [component] = await db
        .select()
        .from(studyComponents)
        .where(eq(studyComponents.userId, userId));
      expect(component?.revision).toBe(2); // parent + promoted child
      expect(component?.reps).toBe(2); // FSRS advanced by both, via replay
      // The promoted child's cursor is stamped (pullable to other devices).
      expect(second.serverCursor).toBeGreaterThan(0);
    });

    it("promotes a transitive held chain when the root arrives", async () => {
      const userId = await createTestUser();
      const aid = randomUUID();
      const bid = randomUUID();
      const attA = attempt();
      const a = event(attA, {
        eventId: aid,
        clientComponentRevision: 1,
        parentEventId: null,
      });
      const attB = attempt();
      const b = event(attB, {
        eventId: bid,
        clientComponentRevision: 2,
        parentEventId: aid,
      });
      const attC = attempt();
      const c = event(attC, { clientComponentRevision: 3, parentEventId: bid });

      // Batch 1: B and C arrive before the root A → both held.
      await ingestSchedulingBatch(userId, [b, c], [attB, attC], { nowMs: NOW });
      const db = getDb();
      let events = await db
        .select()
        .from(reviewEvents)
        .where(eq(reviewEvents.userId, userId));
      expect(events.filter((e) => e.status === "pending_parent")).toHaveLength(
        2,
      );

      // Batch 2: A arrives → A accepted, then B and C promote transitively.
      await ingestSchedulingBatch(userId, [a], [attA], { nowMs: NOW });
      events = await db
        .select()
        .from(reviewEvents)
        .where(eq(reviewEvents.userId, userId));
      expect(events).toHaveLength(3);
      expect(events.every((e) => e.status === "scheduling")).toBe(true);
      const [component] = await db
        .select()
        .from(studyComponents)
        .where(eq(studyComponents.userId, userId));
      expect(component?.revision).toBe(3);
      expect(component?.reps).toBe(3);
    });

    it("leaves a held child pending when a non-parent event arrives", async () => {
      const userId = await createTestUser();
      const missingParent = randomUUID();
      const attC = attempt();
      const c = event(attC, {
        clientComponentRevision: 2,
        parentEventId: missingParent,
      });
      await ingestSchedulingBatch(userId, [c], [attC], { nowMs: NOW });

      // An unrelated NEW root arrives — it does not satisfy the held child's
      // (different) missing parent, so the child stays pending.
      const attRoot = attempt();
      const root = event(attRoot, {
        clientComponentRevision: 1,
        parentEventId: null,
      });
      await ingestSchedulingBatch(userId, [root], [attRoot], { nowMs: NOW });

      const db = getDb();
      const events = await db
        .select()
        .from(reviewEvents)
        .where(eq(reviewEvents.userId, userId));
      const held = events.find((e) => e.eventId === c.eventId);
      expect(held?.status).toBe("pending_parent"); // still held
    });

    it("promotes only the contiguous child among many held siblings of one parent (bounded)", async () => {
      const userId = await createTestUser();
      const pid = randomUUID();
      // Many held children ALL parented on the (missing) pid, at revisions 2..9.
      // Only the revision-2 child is a contiguous extension of the parent; the
      // rest are competing stale branches once the head advances.
      const siblings = [];
      for (let rev = 2; rev <= 9; rev++) {
        const att = attempt();
        siblings.push({
          att,
          ev: event(att, { clientComponentRevision: rev, parentEventId: pid }),
        });
      }
      await ingestSchedulingBatch(
        userId,
        siblings.map((s) => s.ev),
        siblings.map((s) => s.att),
        { nowMs: NOW },
      );

      // The parent finally arrives.
      const attP = attempt();
      const p = event(attP, {
        eventId: pid,
        clientComponentRevision: 1,
        parentEventId: null,
      });
      await ingestSchedulingBatch(userId, [p], [attP], { nowMs: NOW });

      const db = getDb();
      const events = await db
        .select()
        .from(reviewEvents)
        .where(eq(reviewEvents.userId, userId));
      // Parent + the single revision-2 child are scheduling; the other 7
      // stale-branch siblings stay held pending_parent.
      const scheduling = events.filter((e) => e.status === "scheduling");
      const pending = events.filter((e) => e.status === "pending_parent");
      expect(scheduling).toHaveLength(2);
      expect(pending).toHaveLength(7);
      const rev2 = siblings.find((s) => s.ev.clientComponentRevision === 2)!;
      expect(events.find((e) => e.eventId === rev2.ev.eventId)?.status).toBe(
        "scheduling",
      );
      const [component] = await db
        .select()
        .from(studyComponents)
        .where(eq(studyComponents.userId, userId));
      expect(component?.revision).toBe(2);
    });
  });
});
