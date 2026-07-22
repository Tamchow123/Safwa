import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/db/client";
import { registerContent } from "@/db/register-content";
import {
  reviewEvents,
  studyAttempts,
  studyComponents,
  syncAuditLog,
} from "@/db/schema";
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
import { revokeEventsBatch } from "@/modules/sync/server/revoke";
import type {
  WireAttempt,
  WireEvent,
  WireRevocation,
} from "@/modules/sync/protocol";
import { createTestUser } from "@/tests/integration/helpers/users";

const SEED = "revoke-test-seed";
const NOW = Date.parse("2026-07-20T10:01:00.000Z");
const OCCURRED = "2026-07-20T10:00:00.000Z";

type Component = {
  identity: ResolvedComponentIdentity;
  instance: QuestionInstance;
};

let releaseId: string;
let context: QuestionContext;
let comp1: Component;

beforeAll(async () => {
  const { registered } = await registerContent(getDb());
  releaseId = registered[0]!;
  const verified = await loadVerifiedReleaseCached(releaseId);
  context = createQuestionContextFromRelease(verified.learner);
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
      comp1 = { identity: candidate, instance: inst };
      break;
    } catch {
      // next entry
    }
  }
  if (!comp1) throw new Error("need a generatable component");
});

function attempt(overrides: Partial<WireAttempt> = {}): WireAttempt {
  const { identity, instance } = comp1;
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

function revocation(
  ev: WireEvent,
  overrides: Partial<WireRevocation> = {},
): WireRevocation {
  return {
    revocationId: randomUUID(),
    eventId: ev.eventId,
    studyComponentId: ev.studyComponentId,
    deviceId: "device-1",
    occurredAtClient: OCCURRED,
    ...overrides,
  };
}

describe("revokeEventsBatch", () => {
  it("removes the scheduling effect but preserves the attempt history (§16)", async () => {
    const userId = await createTestUser();
    const att = attempt();
    const ev = event(att);
    await ingestSchedulingBatch(userId, [ev], [att], { nowMs: NOW });

    const { results, serverCursor } = await revokeEventsBatch(
      userId,
      [revocation(ev)],
      { nowMs: NOW },
    );
    expect(results[0]).toMatchObject({ status: "accepted", serverRevision: 2 });
    expect(serverCursor).toBe(2); // 1 from ingest, +1 from revocation

    const db = getDb();
    const [storedEvent] = await db
      .select()
      .from(reviewEvents)
      .where(eq(reviewEvents.eventId, ev.eventId));
    expect(storedEvent?.status).toBe("revoked");
    expect(storedEvent?.revokedAt).not.toBeNull();

    const [component] = await db
      .select()
      .from(studyComponents)
      .where(eq(studyComponents.userId, userId));
    expect(component?.reps).toBe(0); // scheduling effect undone
    expect(component?.learnerState).toBe("not_started");
    expect(component?.revision).toBe(2);
    expect(component?.lastSyncSeq).toBe(2);

    // The attempt is retained for history/analytics.
    const attempts = await db
      .select()
      .from(studyAttempts)
      .where(eq(studyAttempts.userId, userId));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.id).toBe(att.id);
  });

  it("is idempotent — re-revoking a revoked event is a duplicate no-op", async () => {
    const userId = await createTestUser();
    const att = attempt();
    const ev = event(att);
    await ingestSchedulingBatch(userId, [ev], [att], { nowMs: NOW });
    const rev = revocation(ev);
    await revokeEventsBatch(userId, [rev], { nowMs: NOW });

    const second = await revokeEventsBatch(userId, [revocation(ev)], {
      nowMs: NOW,
    });
    expect(second.results[0]).toMatchObject({
      status: "duplicate",
      reasonCode: "revocation_already_revoked",
      duplicate: true,
    });
    // No second bump: cursor stays at 2 (ingest=1, first revoke=2).
    expect(second.serverCursor).toBe(2);
    const db = getDb();
    const [component] = await db
      .select()
      .from(studyComponents)
      .where(eq(studyComponents.userId, userId));
    expect(component?.revision).toBe(2);
  });

  it("rejects a revocation for another account's event (enumeration-safe)", async () => {
    const owner = await createTestUser();
    const attacker = await createTestUser();
    const att = attempt();
    const ev = event(att);
    await ingestSchedulingBatch(owner, [ev], [att], { nowMs: NOW });

    const { results } = await revokeEventsBatch(attacker, [revocation(ev)], {
      nowMs: NOW,
    });
    expect(results[0]).toMatchObject({
      status: "rejected",
      reasonCode: "revocation_unknown_event",
    });
    // The owner's event is untouched.
    const db = getDb();
    const [storedEvent] = await db
      .select()
      .from(reviewEvents)
      .where(eq(reviewEvents.eventId, ev.eventId));
    expect(storedEvent?.status).toBe("scheduling");
  });

  it("rejects an unknown event id", async () => {
    const userId = await createTestUser();
    const att = attempt();
    const ev = event(att);
    await ingestSchedulingBatch(userId, [ev], [att], { nowMs: NOW });

    const bogus = revocation(ev, { eventId: randomUUID() });
    const { results } = await revokeEventsBatch(userId, [bogus], {
      nowMs: NOW,
    });
    expect(results[0]).toMatchObject({
      status: "rejected",
      reasonCode: "revocation_unknown_event",
    });
  });

  it("rejects revoking a non-head event recoverably (has descendants, D2)", async () => {
    const userId = await createTestUser();
    const a1 = attempt();
    const e1 = event(a1, { clientComponentRevision: 1, parentEventId: null });
    const a2 = attempt();
    const e2 = event(a2, {
      clientComponentRevision: 2,
      parentEventId: e1.eventId,
    });
    await ingestSchedulingBatch(userId, [e1, e2], [a1, a2], { nowMs: NOW });

    // e1 is not the head (e2 descends from it) → recoverable rejection.
    const { results } = await revokeEventsBatch(userId, [revocation(e1)], {
      nowMs: NOW,
    });
    expect(results[0]).toMatchObject({
      status: "rejected",
      reasonCode: "revocation_has_descendants",
      recoverable: true,
    });
    const db = getDb();
    const [component] = await db
      .select()
      .from(studyComponents)
      .where(eq(studyComponents.userId, userId));
    expect(component?.reps).toBe(2); // unchanged
    expect(component?.revision).toBe(2);
    const audits = await db
      .select()
      .from(syncAuditLog)
      .where(
        and(
          eq(syncAuditLog.userId, userId),
          eq(syncAuditLog.reasonCode, "revocation_has_descendants"),
        ),
      );
    expect(audits).toHaveLength(1);
  });

  it("revoking the head of a chain replays the remaining events", async () => {
    const userId = await createTestUser();
    const a1 = attempt();
    const e1 = event(a1, { clientComponentRevision: 1, parentEventId: null });
    const a2 = attempt();
    const e2 = event(a2, {
      clientComponentRevision: 2,
      parentEventId: e1.eventId,
    });
    await ingestSchedulingBatch(userId, [e1, e2], [a1, a2], { nowMs: NOW });

    // Revoke the head e2 → chain is just e1, reps back to 1.
    const { results } = await revokeEventsBatch(userId, [revocation(e2)], {
      nowMs: NOW,
    });
    expect(results[0]?.status).toBe("accepted");
    const db = getDb();
    const [component] = await db
      .select()
      .from(studyComponents)
      .where(eq(studyComponents.userId, userId));
    expect(component?.reps).toBe(1);
    expect(component?.revision).toBe(3); // 2 from ingest, +1 revoke
    // e1 remains schedulable; only e2 is revoked.
    const remaining = await db
      .select()
      .from(reviewEvents)
      .where(
        and(
          eq(reviewEvents.userId, userId),
          eq(reviewEvents.status, "scheduling"),
        ),
      );
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.eventId).toBe(e1.eventId);
  });

  it("accepts a whole run submitted ancestor-first in ONE batch (head-first, D2)", async () => {
    const userId = await createTestUser();
    const a1 = attempt();
    const e1 = event(a1, { clientComponentRevision: 1, parentEventId: null });
    const a2 = attempt();
    const e2 = event(a2, {
      clientComponentRevision: 2,
      parentEventId: e1.eventId,
    });
    await ingestSchedulingBatch(userId, [e1, e2], [a1, a2], { nowMs: NOW });

    // Submit ancestor-first (e1 before e2); the server processes head-first, so
    // both accept in a single pass without a second round trip.
    const { results } = await revokeEventsBatch(
      userId,
      [revocation(e1), revocation(e2)],
      { nowMs: NOW },
    );
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "accepted")).toBe(true);
    const db = getDb();
    const [component] = await db
      .select()
      .from(studyComponents)
      .where(eq(studyComponents.userId, userId));
    expect(component?.reps).toBe(0); // both undone
    expect(component?.learnerState).toBe("not_started");
    expect(component?.revision).toBe(4); // 2 from ingest, +2 accepted in one tx
    const remaining = await db
      .select()
      .from(reviewEvents)
      .where(
        and(
          eq(reviewEvents.userId, userId),
          eq(reviewEvents.status, "scheduling"),
        ),
      );
    expect(remaining).toHaveLength(0);
  });

  it("rejects revoking a non-scheduling (pending_parent) event", async () => {
    const userId = await createTestUser();
    const att = attempt();
    // Unknown parent → held as pending_parent, never scheduling-authoritative.
    const ev = event(att, {
      clientComponentRevision: 3,
      parentEventId: randomUUID(),
    });
    await ingestSchedulingBatch(userId, [ev], [att], { nowMs: NOW });

    const { results } = await revokeEventsBatch(userId, [revocation(ev)], {
      nowMs: NOW,
    });
    expect(results[0]).toMatchObject({
      status: "rejected",
      reasonCode: "not_scheduling_authoritative",
    });
  });
});
