/**
 * Phase 17 §14 — the server's write and read paths carrying a UNION.
 *
 * Most unions here are seeded directly into `review_events`: two accepted roots
 * on one component, which is exactly the shape a guest→account merge produces
 * and exactly the shape corruption produces. The point of those tests is that
 * the server treats the two cases DIFFERENTLY, and that the only thing
 * separating them is `study_components.merged_at`.
 *
 * The final block (T10e) is the other half: it creates its unions the way
 * production does, through the server-internal merge ingestion mode, and shows
 * that the mode is the ONLY thing that can obtain the stamp.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { getDb } from "@/db/client";
import { registerContent } from "@/db/register-content";
import { reviewEvents, studyComponents } from "@/db/schema";
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
import { pullChanges } from "@/modules/sync/server/pull";
import { revokeEventsBatch } from "@/modules/sync/server/revoke";
import { createTestUser } from "@/tests/integration/helpers/users";

const NOW = Date.parse("2026-07-20T12:00:00.000Z");
const SEED = "merge-union-seed";
let releaseId: string;
let context: QuestionContext;
let identity: ResolvedComponentIdentity;
let instance: QuestionInstance;

beforeAll(async () => {
  // A component identity the ACTIVE RELEASE really contains: ingestion validates
  // the identity against the release before it does anything else, so a
  // hand-picked entry id would make these tests fail for a reason that has
  // nothing to do with merging.
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
      instance = generateQuestion(context, {
        identity: candidate,
        deliveryMode: "mc",
        questionSeed: SEED,
        position: 0,
      });
      identity = candidate;
      break;
    } catch {
      // try the next entry
    }
  }
  if (!identity) throw new Error("no generatable component in the release");
});

type SeedEvent = {
  eventId: string;
  parentEventId: string | null;
  revision: number;
  /** Minutes after NOW's base; the canonical instant the union is ordered by. */
  offsetMinutes: number;
  /** Held rather than accepted, awaiting its parent. */
  pending?: boolean;
  /** Written by a merge coordinator — decides which lineage rule judges it. */
  imported?: boolean;
};

/** A component plus a directly-seeded accepted event set. */
async function seedComponent(
  userId: string,
  events: readonly SeedEvent[],
  options: { merged: boolean },
): Promise<string> {
  const db = getDb();
  const [component] = await db
    .insert(studyComponents)
    .values({
      userId,
      entryId: identity.entryId,
      skillTypeId: identity.skillType,
      componentShape: identity.componentShape,
      sourceField: identity.sourceField,
      direction: identity.direction,
      revision: events.length,
      // Stamped so the component falls inside an ordinary pull page — without
      // this the pull tests below would pass vacuously by never loading it.
      lastSyncSeq: 1,
      // Both or neither: the constraint requires the grant to name the import
      // that justified it.
      mergedAt: options.merged ? new Date(NOW) : null,
      mergedFromGuestImportId: options.merged ? randomUUID() : null,
    })
    .returning({ id: studyComponents.id });
  const componentId = component!.id;

  const base = Date.parse("2026-07-20T09:00:00.000Z");
  for (const event of events) {
    const at = new Date(base + event.offsetMinutes * 60_000);
    await db.insert(reviewEvents).values({
      eventId: event.eventId,
      userId,
      studyComponentId: componentId,
      attemptId: null,
      rating: "good",
      status: event.pending ? "pending_parent" : "scheduling",
      baseServerRevision: 0,
      parentEventId: event.parentEventId,
      clientComponentRevision: event.revision,
      occurredAtClient: at,
      occurredAtCanonical: at,
      deviceId: "device-1",
      clientSequence: event.revision,
      releaseId,
      contentVersion: context.contentVersion,
      timezoneAtEvent: "UTC",
      utcOffsetMinutesAtEvent: 0,
      localDateAtEvent: "2026-07-20",
      timezoneSource: "browser_detected",
      lastSyncSeq: 1,
      importedFromGuestImportId: event.imported ? randomUUID() : null,
    });
  }
  return componentId;
}

/**
 * A guest chain (G1→G2, older) and an account chain (A1→A2, more recent)
 * unioned onto one component. Both number their revisions from 1, which is what
 * makes "highest revision" the wrong head: G2 and A2 are both revision 2, and
 * the LATEST event is A2.
 *
 * Ids are minted per call — these tests share one database, and a fixed id set
 * would make the second test collide on `review_events_pkey` rather than test
 * anything.
 */
function union(): { events: SeedEvent[]; accountTail: string } {
  const guestRoot = randomUUID();
  const guestTail = randomUUID();
  const accountRoot = randomUUID();
  const accountTail = randomUUID();
  return {
    accountTail,
    events: [
      {
        eventId: guestRoot,
        parentEventId: null,
        revision: 1,
        offsetMinutes: 0,
      },
      {
        eventId: guestTail,
        parentEventId: guestRoot,
        revision: 2,
        offsetMinutes: 30,
      },
      {
        eventId: accountRoot,
        parentEventId: null,
        revision: 1,
        offsetMinutes: 120,
      },
      {
        eventId: accountTail,
        parentEventId: accountRoot,
        revision: 2,
        offsetMinutes: 150,
      },
    ],
  };
}

/** The component key the seeded rows correspond to, for routing. */
function seededComponentKey(): string {
  return buildComponentKey(identity);
}

/** Undo of the union's latest event — the one a learner would actually undo. */
function revocation(eventId: string) {
  return {
    revocationId: randomUUID(),
    eventId,
    studyComponentId: seededComponentKey(),
    deviceId: "device-1",
    occurredAtClient: "2026-07-20T11:30:00.000Z",
  };
}

/** A well-formed attempt for the resolved component, so ingestion gets past its
 * identity resolution — these tests are about lineage, not grading. */
function pushAttempt(id: string, sessionId: string) {
  return {
    id,
    sessionId,
    deviceId: "device-1",
    studyComponentId: seededComponentKey(),
    entryId: identity.entryId,
    skillTypeId: identity.skillType,
    sourceField: identity.sourceField,
    direction: identity.direction,
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
    mode: "mc" as const,
    optionCount: instance.optionCount,
    perQuestionLimitMs: null,
    questionInstanceId: instance.questionInstanceId,
    questionSeed: SEED,
    questionGeneratorVersion: "1",
    releaseId,
    contentVersion: context.contentVersion,
    occurredAtUtc: "2026-07-20T11:00:00.000Z",
    timezoneAtEvent: "UTC",
    utcOffsetMinutesAtEvent: 0,
    localDateAtEvent: "2026-07-20",
    timezoneSource: "browser_detected" as const,
  };
}

/**
 * Run one ingestion request against the seeded component so its promotion pass
 * executes. The event is a fresh root, which ordinary sync refuses on a
 * component that already has history — the refusal is the point: it proves the
 * promotion pass runs even when nothing in the batch is accepted, and it keeps
 * the trigger from quietly contributing history of its own.
 */
async function triggerPromotionPass(
  userId: string,
  options: { maxPendingReprocess?: number } = {},
): Promise<void> {
  const attemptId = randomUUID();
  const sessionId = randomUUID();
  const { results } = await ingestSchedulingBatch(
    userId,
    [
      {
        eventId: randomUUID(),
        studyComponentId: seededComponentKey(),
        attemptId,
        rating: "good",
        status: "scheduling",
        baseServerRevision: 0,
        parentEventId: null,
        clientComponentRevision: 1,
        clientSequence: 99,
        occurredAtClient: "2026-07-20T11:00:00.000Z",
        deviceId: "device-1",
        sessionId,
        releaseId,
        contentVersion: context.contentVersion,
        timezoneAtEvent: "UTC",
        utcOffsetMinutesAtEvent: 0,
        localDateAtEvent: "2026-07-20",
        timezoneSource: "browser_detected",
      },
    ],
    [pushAttempt(attemptId, sessionId)],
    { nowMs: NOW, ...options },
  );
  expect(results[0]).toMatchObject({ status: "rejected" });
}

/** The Postgres constraint a Drizzle query failure was ultimately caused by. */
function violatedConstraint(error: unknown): string | undefined {
  const cause = (error as { cause?: { constraint?: string } } | undefined)
    ?.cause;
  return cause?.constraint;
}

describe("a union WITHOUT the merge marker is treated as corruption", () => {
  it("pull refuses to project it rather than serving a plausible card", async () => {
    // The canary REL-003 exists to keep alive. A multi-rooted component that no
    // coordinator marked could have come from a bad migration, a manual repair
    // or a restore interleaving two histories — replaying it would hand the
    // learner a merged-looking card nobody authorised, silently.
    const userId = await createTestUser();
    await seedComponent(userId, union().events, { merged: false });

    await expect(
      pullChanges(userId, { since: 0, limit: 100 }, { nowMs: NOW }),
    ).rejects.toThrow();
  });

  it("revoke refuses too, so no read path quietly accepts the shape", async () => {
    const userId = await createTestUser();
    const { events, accountTail } = union();
    await seedComponent(userId, events, { merged: false });

    // Revocation does not throw to the caller: like ingestion, it isolates a
    // failing component so one bad component cannot take down a batch. The
    // refusal therefore surfaces as a recoverable per-item rejection — but it IS
    // a refusal, and the undo is not applied.
    const result = await revokeEventsBatch(userId, [revocation(accountTail)], {
      nowMs: NOW,
    });
    expect(result.results[0]).toMatchObject({
      status: "rejected",
      reasonCode: "internal_error",
      recoverable: true,
    });

    const db = getDb();
    const [untouched] = await db
      .select()
      .from(reviewEvents)
      .where(eq(reviewEvents.eventId, accountTail));
    expect(untouched?.status).toBe("scheduling");
  });
});

describe("a union WITH the merge marker replays everywhere", () => {
  it("pull projects it and names the CHRONOLOGICAL head as the lineage anchor", async () => {
    // The second device's ordinary Phase 16 pull is what §17 requires to keep
    // working after a merge. It must also receive the right anchor: the client
    // parents its next review on `headEventId`, so naming the longer chain's tip
    // instead of the latest event would make the server reject the very review
    // it asked for, and that device would stop recording reviews for this
    // component with no error anyone sees.
    const userId = await createTestUser();
    const { events, accountTail } = union();
    await seedComponent(userId, events, { merged: true });

    const page = await pullChanges(
      userId,
      { since: 0, limit: 100 },
      { nowMs: NOW },
    );
    expect(page.components).toHaveLength(1);
    const [component] = page.components;
    expect(component?.headEventId).toBe(accountTail);
    // The head's OWN revision, which the client adds one to. Both chains happen
    // to be length 2 here, so this coincides with the union maximum — the
    // asymmetric case that tells them apart is tested further down.
    expect(component?.headClientRevision).toBe(2);
    // All four events were replayed, not just one chain's.
    expect(component?.card?.reps).toBe(4);
  });

  it("revoke works on a merged component — an undo is not blocked by the merge", async () => {
    const userId = await createTestUser();
    const { events, accountTail } = union();
    await seedComponent(userId, events, { merged: true });

    const result = await revokeEventsBatch(userId, [revocation(accountTail)], {
      nowMs: NOW,
    });
    expect(result.results[0]).toMatchObject({ status: "accepted" });

    const db = getDb();
    const [revoked] = await db
      .select()
      .from(reviewEvents)
      .where(eq(reviewEvents.eventId, accountTail));
    expect(revoked?.status).toBe("revoked");
  });
});

describe("the marker is a per-component permission, not a global switch", () => {
  it("one account can hold a marked component and an unmarked one at once", async () => {
    // Guards against the tolerance being implemented as a user- or request-level
    // flag: the unmarked component must still fail while the marked one works.
    const userId = await createTestUser();
    await seedComponent(userId, union().events, { merged: true });
    const db = getDb();
    const [second] = await db
      .insert(studyComponents)
      .values({
        userId,
        entryId: identity.entryId + 1000,
        skillTypeId: "meaning_recognition",
        componentShape: "form_direction",
        sourceField: "madi",
        direction: "arabic_to_english",
        revision: 2,
        lastSyncSeq: 1,
        mergedAt: null,
      })
      .returning({ id: studyComponents.id });
    const base = Date.parse("2026-07-20T09:00:00.000Z");
    for (const [index, id] of [randomUUID(), randomUUID()].entries()) {
      await db.insert(reviewEvents).values({
        eventId: id,
        userId,
        studyComponentId: second!.id,
        attemptId: null,
        rating: "good",
        status: "scheduling",
        baseServerRevision: 0,
        parentEventId: null, // two roots, unmarked ⇒ corrupt
        clientComponentRevision: 1,
        occurredAtClient: new Date(base + index * 60_000),
        occurredAtCanonical: new Date(base + index * 60_000),
        deviceId: "device-1",
        clientSequence: 1,
        releaseId,
        contentVersion: context.contentVersion,
        timezoneAtEvent: "UTC",
        utcOffsetMinutesAtEvent: 0,
        localDateAtEvent: "2026-07-20",
        timezoneSource: "browser_detected",
        lastSyncSeq: 1,
      });
    }

    await expect(
      pullChanges(userId, { since: 0, limit: 100 }, { nowMs: NOW }),
    ).rejects.toThrow();
  });
});

describe("a held child behind a non-head parent is still promoted", () => {
  it("promotes a guest child whose parent is not the chronological head", async () => {
    // The silent-loss case. The guest's G2 arrived before its parent G1 and was
    // held; G1 is now accepted, but the component's head is the account's more
    // recent A1. Keyed on (head, headRevision + 1) — Phase 16's rule — nothing
    // ever looks under G1, so G2 waits until its TTL expires and is purged: a
    // guest review lost with no rejection reported to anyone.
    const userId = await createTestUser();
    const db = getDb();
    const guestRoot = randomUUID();
    const guestHeld = randomUUID();
    const accountRoot = randomUUID();

    const componentId = await seedComponent(
      userId,
      [
        {
          eventId: guestRoot,
          parentEventId: null,
          revision: 1,
          offsetMinutes: 0,
          imported: true,
        },
        {
          eventId: accountRoot,
          parentEventId: null,
          revision: 1,
          offsetMinutes: 120,
        },
        {
          eventId: guestHeld,
          parentEventId: guestRoot,
          revision: 2,
          offsetMinutes: 15,
          pending: true,
          imported: true,
        },
      ],
      { merged: true },
    );
    void componentId;

    // Any request touching this component runs the promotion pass. Re-sending an
    // event the server already has is the smallest way to trigger one without
    // inventing new history — it is refused as a payload conflict (the seeded
    // row carries no idempotency hash), and the promotion pass still runs, which
    // is the point. The attempt has to be present and well-formed regardless:
    // ingestion resolves the component identity from the batch's first attempt
    // before it does anything else, and bails out entirely without one.
    const attemptId = randomUUID();
    const sessionId = randomUUID();
    const { results } = await ingestSchedulingBatch(
      userId,
      [
        {
          eventId: accountRoot,
          studyComponentId: seededComponentKey(),
          attemptId,
          rating: "good",
          status: "scheduling",
          baseServerRevision: 0,
          parentEventId: null,
          clientComponentRevision: 1,
          clientSequence: 1,
          occurredAtClient: "2026-07-20T11:00:00.000Z",
          deviceId: "device-1",
          sessionId,
          releaseId,
          contentVersion: context.contentVersion,
          timezoneAtEvent: "UTC",
          utcOffsetMinutesAtEvent: 0,
          localDateAtEvent: "2026-07-20",
          timezoneSource: "browser_detected",
        },
      ],
      [
        {
          id: attemptId,
          sessionId,
          deviceId: "device-1",
          studyComponentId: seededComponentKey(),
          entryId: identity.entryId,
          skillTypeId: identity.skillType,
          sourceField: identity.sourceField,
          direction: identity.direction,
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
          occurredAtUtc: "2026-07-20T11:00:00.000Z",
          timezoneAtEvent: "UTC",
          utcOffsetMinutesAtEvent: 0,
          localDateAtEvent: "2026-07-20",
          timezoneSource: "browser_detected",
        },
      ],
      { nowMs: NOW },
    );
    // The trigger event itself is refused — this test is about what happens to
    // the HELD child, and asserting the refusal keeps the trigger honest rather
    // than letting a silently-accepted duplicate stand in for it.
    expect(results[0]).toMatchObject({ status: "rejected" });

    const [promoted] = await db
      .select()
      .from(reviewEvents)
      .where(eq(reviewEvents.eventId, guestHeld));
    expect(promoted?.status).toBe("scheduling");
  });
});

describe("the merge provenance constraint", () => {
  it("refuses provenance without the stamp that explains it", async () => {
    const userId = await createTestUser();
    const db = getDb();
    const error = await db
      .insert(studyComponents)
      .values({
        userId,
        entryId: 3,
        skillTypeId: "meaning_recognition",
        componentShape: "form_direction",
        sourceField: "madi",
        direction: "arabic_to_english",
        mergedAt: null,
        mergedFromGuestImportId: randomUUID(),
      })
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );
    // Asserted by constraint NAME, not by message text: Drizzle wraps the
    // driver error in a "Failed query: ..." string, so matching on the message
    // would pass for any insert failure at all, including a typo in this test.
    expect(violatedConstraint(error)).toBe(
      "study_components_merge_provenance_check",
    );
  });

  it("refuses the stamp WITHOUT provenance — an untraceable grant is the one to worry about", async () => {
    // The direction that matters more. `merged_at` is the only thing separating
    // an authorised merge from corruption, so a stamp naming no import cannot
    // be told apart afterwards from one left by a coordinator bug or a manual
    // repair — exactly the question an incident would need answered.
    const userId = await createTestUser();
    const db = getDb();
    const error = await db
      .insert(studyComponents)
      .values({
        userId,
        entryId: 4,
        skillTypeId: "meaning_recognition",
        componentShape: "form_direction",
        sourceField: "madi",
        direction: "arabic_to_english",
        mergedAt: new Date(NOW),
        mergedFromGuestImportId: null,
      })
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );
    expect(violatedConstraint(error)).toBe(
      "study_components_merge_provenance_check",
    );
  });

  it("accepts both together, and neither together", async () => {
    const userId = await createTestUser();
    const db = getDb();
    const importId = randomUUID();
    const [merged] = await db
      .insert(studyComponents)
      .values({
        userId,
        entryId: 5,
        skillTypeId: "meaning_recognition",
        componentShape: "form_direction",
        sourceField: "madi",
        direction: "arabic_to_english",
        mergedAt: new Date(NOW),
        mergedFromGuestImportId: importId,
      })
      .returning({ id: studyComponents.id });
    const [stored] = await db
      .select()
      .from(studyComponents)
      .where(
        and(
          eq(studyComponents.id, merged!.id),
          eq(studyComponents.userId, userId),
        ),
      );
    expect(stored?.mergedAt).not.toBeNull();
    expect(stored?.mergedFromGuestImportId).toBe(importId);

    // And the ordinary, never-merged shape stays legal.
    const [plain] = await db
      .insert(studyComponents)
      .values({
        userId,
        entryId: 6,
        skillTypeId: "meaning_recognition",
        componentShape: "form_direction",
        sourceField: "madi",
        direction: "arabic_to_english",
      })
      .returning({ id: studyComponents.id });
    expect(plain?.id).toBeTruthy();
  });
});

describe("the merge rule is scoped to imported events, not to merged components", () => {
  it("REFUSES a fresh root pushed at a merged component through ordinary sync", async () => {
    // SEC-001. If `merged_at` decided which rule new arrivals are judged by,
    // then merging a component once would make it permanently easier to write
    // to: any device could keep adding fresh root chains to it forever, each
    // replayed into authoritative FSRS state, with none of Phase 16's
    // stale-branch or fork rejection. §14 says the merge behaviour must not be
    // available to ordinary sync requests, and this is that check — through the
    // real ingestion entry point, not a direct insert.
    const userId = await createTestUser();
    const { events } = union();
    await seedComponent(userId, events, { merged: true });

    const attemptId = randomUUID();
    const sessionId = randomUUID();
    const { results } = await ingestSchedulingBatch(
      userId,
      [
        {
          eventId: randomUUID(),
          studyComponentId: seededComponentKey(),
          attemptId,
          rating: "good",
          status: "scheduling",
          baseServerRevision: 0,
          // A THIRD root, on a component that legitimately holds two.
          parentEventId: null,
          clientComponentRevision: 1,
          clientSequence: 9,
          occurredAtClient: "2026-07-20T11:45:00.000Z",
          deviceId: "device-1",
          sessionId,
          releaseId,
          contentVersion: context.contentVersion,
          timezoneAtEvent: "UTC",
          utcOffsetMinutesAtEvent: 0,
          localDateAtEvent: "2026-07-20",
          timezoneSource: "browser_detected",
        },
      ],
      [pushAttempt(attemptId, sessionId)],
      { nowMs: NOW },
    );
    expect(results[0]).toMatchObject({
      status: "rejected",
      reasonCode: "stale_branch_conflict",
    });
  });

  it("ACCEPTS an ordinary continuation parented on the merged component's head", async () => {
    // The other half of the same rule, and the pairing REL-004 is about: the
    // client parents on the anchor pull gave it and numbers one past the union
    // head's OWN revision. Phase 16's classifier is what judges that, and its
    // contiguity check is against that same value — so the two agree. The chains
    // here are
    // deliberately UNEQUAL in length, with the shorter one chronologically last,
    // which is the shape where the head's own revision and the union maximum
    // differ and a per-parent rule would reject the server's own anchor.
    const userId = await createTestUser();
    const guestRoot = randomUUID();
    const guestMid = randomUUID();
    const guestTail = randomUUID();
    const accountTail = randomUUID();
    await seedComponent(
      userId,
      [
        {
          eventId: guestRoot,
          parentEventId: null,
          revision: 1,
          offsetMinutes: 0,
          imported: true,
        },
        {
          eventId: guestMid,
          parentEventId: guestRoot,
          revision: 2,
          offsetMinutes: 10,
          imported: true,
        },
        {
          eventId: guestTail,
          parentEventId: guestMid,
          revision: 3,
          offsetMinutes: 20,
          imported: true,
        },
        // One short account chain, and it happened last.
        {
          eventId: accountTail,
          parentEventId: null,
          revision: 1,
          offsetMinutes: 200,
        },
      ],
      { merged: true },
    );

    const page = await pullChanges(
      userId,
      { since: 0, limit: 100 },
      { nowMs: NOW },
    );
    const [component] = page.components;
    expect(component?.headEventId).toBe(accountTail);
    // The head's OWN revision — 1 — not the union maximum of 3. Replay checks
    // contiguity per CHAIN, so the next event must be one past the head it
    // parents on; pairing it with the union maximum would have the server accept
    // an event that the very next replay throws on.
    expect(component?.headClientRevision).toBe(1);

    const attemptId = randomUUID();
    const sessionId = randomUUID();
    const { results } = await ingestSchedulingBatch(
      userId,
      [
        {
          eventId: randomUUID(),
          studyComponentId: seededComponentKey(),
          attemptId,
          rating: "good",
          status: "scheduling",
          baseServerRevision: 0,
          // Exactly what the client derives from the anchor above.
          parentEventId: component!.headEventId ?? null,
          clientComponentRevision: (component!.headClientRevision ?? 0) + 1,
          clientSequence: 9,
          occurredAtClient: "2026-07-20T13:00:00.000Z",
          deviceId: "device-1",
          sessionId,
          releaseId,
          contentVersion: context.contentVersion,
          timezoneAtEvent: "UTC",
          utcOffsetMinutesAtEvent: 0,
          localDateAtEvent: "2026-07-20",
          timezoneSource: "browser_detected",
        },
      ],
      [pushAttempt(attemptId, sessionId)],
      { nowMs: NOW },
    );
    expect(results[0]).toMatchObject({ status: "accepted" });
  });
});

describe("promotion under shapes the two-chain fixture cannot reach", () => {
  it("promotes held children from ALL chains of a three-way union (TEST-002)", async () => {
    // Two guest imports plus the account's own history. With only two chains the
    // frontier is seeded from a single parent, so nothing distinguishes "walks
    // the held parents" from "walks the one held parent".
    const userId = await createTestUser();
    const rootA = randomUUID();
    const heldA = randomUUID();
    const rootB = randomUUID();
    const heldB = randomUUID();
    const accountRoot = randomUUID();

    await seedComponent(
      userId,
      [
        {
          eventId: rootA,
          parentEventId: null,
          revision: 1,
          offsetMinutes: 0,
          imported: true,
        },
        {
          eventId: heldA,
          parentEventId: rootA,
          revision: 2,
          offsetMinutes: 5,
          pending: true,
          imported: true,
        },
        {
          eventId: rootB,
          parentEventId: null,
          revision: 1,
          offsetMinutes: 60,
          imported: true,
        },
        {
          eventId: heldB,
          parentEventId: rootB,
          revision: 2,
          offsetMinutes: 65,
          pending: true,
          imported: true,
        },
        {
          eventId: accountRoot,
          parentEventId: null,
          revision: 1,
          offsetMinutes: 200,
        },
      ],
      { merged: true },
    );

    await triggerPromotionPass(userId);

    const db = getDb();
    for (const held of [heldA, heldB]) {
      const [row] = await db
        .select()
        .from(reviewEvents)
        .where(eq(reviewEvents.eventId, held));
      expect(row?.status).toBe("scheduling");
    }
  });

  it("promotes a held child of a held child (TEST-003)", async () => {
    // The frontier pushes each promoted child back on as a parent. One level of
    // promotion does not exercise that; two does.
    const userId = await createTestUser();
    const root = randomUUID();
    const held1 = randomUUID();
    const held2 = randomUUID();
    const accountRoot = randomUUID();

    await seedComponent(
      userId,
      [
        {
          eventId: root,
          parentEventId: null,
          revision: 1,
          offsetMinutes: 0,
          imported: true,
        },
        {
          eventId: held1,
          parentEventId: root,
          revision: 2,
          offsetMinutes: 5,
          pending: true,
          imported: true,
        },
        {
          eventId: held2,
          parentEventId: held1,
          revision: 3,
          offsetMinutes: 10,
          pending: true,
          imported: true,
        },
        {
          eventId: accountRoot,
          parentEventId: null,
          revision: 1,
          offsetMinutes: 200,
        },
      ],
      { merged: true },
    );

    await triggerPromotionPass(userId);

    const db = getDb();
    for (const held of [held1, held2]) {
      const [row] = await db
        .select()
        .from(reviewEvents)
        .where(eq(reviewEvents.eventId, held));
      expect(row?.status).toBe("scheduling");
    }
  });

  it("stops at the promotion budget and leaves the remainder held (TEST-004)", async () => {
    // The budget is a DoS bound (SEC-T9c-001), and the frontier's seeding changed
    // in this slice, so the bound is worth pinning rather than assuming. The cap
    // is injected rather than reached by seeding a thousand rows — a test nobody
    // would keep is not coverage.
    const userId = await createTestUser();
    const root = randomUUID();
    const chain = [randomUUID(), randomUUID(), randomUUID()];

    await seedComponent(
      userId,
      [
        {
          eventId: root,
          parentEventId: null,
          revision: 1,
          offsetMinutes: 0,
          imported: true,
        },
        {
          eventId: chain[0]!,
          parentEventId: root,
          revision: 2,
          offsetMinutes: 5,
          pending: true,
          imported: true,
        },
        {
          eventId: chain[1]!,
          parentEventId: chain[0]!,
          revision: 3,
          offsetMinutes: 10,
          pending: true,
          imported: true,
        },
        {
          eventId: chain[2]!,
          parentEventId: chain[1]!,
          revision: 4,
          offsetMinutes: 15,
          pending: true,
          imported: true,
        },
      ],
      { merged: true },
    );

    await triggerPromotionPass(userId, { maxPendingReprocess: 2 });

    const db = getDb();
    const statuses: string[] = [];
    for (const id of chain) {
      const [row] = await db
        .select()
        .from(reviewEvents)
        .where(eq(reviewEvents.eventId, id));
      statuses.push(row?.status ?? "missing");
    }
    // Exactly the budget is spent, in chain order; the rest waits for the next
    // request rather than being dropped.
    expect(statuses).toEqual(["scheduling", "scheduling", "pending_parent"]);
  });
});

describe("an ordinary single-rooted component is unaffected (TEST-005)", () => {
  it("anchors on its latest event with its own revision, whatever order rows arrive in", async () => {
    // refreshChainHead and the rekeyed promotion loop are on the hot path for
    // EVERY account, not only merged ones. This slice should provide its own
    // evidence of that rather than inferring it from Phase 16's suite passing.
    const userId = await createTestUser();
    const e1 = randomUUID();
    const e2 = randomUUID();
    const e3 = randomUUID();

    await seedComponent(
      userId,
      [
        // Deliberately not in causal order, and with a non-monotonic instant on
        // the middle event, so a chronological or arrival-order rule would pick
        // differently from the structural one.
        { eventId: e3, parentEventId: e2, revision: 3, offsetMinutes: 40 },
        { eventId: e1, parentEventId: null, revision: 1, offsetMinutes: 10 },
        { eventId: e2, parentEventId: e1, revision: 2, offsetMinutes: 90 },
      ],
      { merged: false },
    );

    const page = await pullChanges(
      userId,
      { since: 0, limit: 100 },
      { nowMs: NOW },
    );
    const [component] = page.components;
    // The structural tip, and its own revision — Phase 16's answer exactly.
    expect(component?.headEventId).toBe(e3);
    expect(component?.headClientRevision).toBe(3);
    expect(component?.card?.reps).toBe(3);
  });
});

// --- T10e: the server-internal merge INGESTION MODE --------------------------
//
// Everything above seeds its unions straight into `review_events`, because when
// it was written nothing could create one. This block creates them the way
// production will: through `ingestSchedulingBatch` with the server-internal
// `guestImport` option, which is reachable only from the merge coordinator.

/** One scheduling event, shaped for `ingestSchedulingBatch`. */
function wireEvent(
  eventId: string,
  attemptId: string,
  sessionId: string,
  parentEventId: string | null,
  revision: number,
  occurredAtClient: string,
) {
  return {
    eventId,
    studyComponentId: seededComponentKey(),
    attemptId,
    rating: "good" as const,
    status: "scheduling" as const,
    baseServerRevision: 0,
    parentEventId,
    clientComponentRevision: revision,
    clientSequence: revision,
    occurredAtClient,
    deviceId: "device-1",
    sessionId,
    releaseId,
    contentVersion: context.contentVersion,
    timezoneAtEvent: "UTC",
    utcOffsetMinutesAtEvent: 0,
    localDateAtEvent: "2026-07-20",
    timezoneSource: "browser_detected" as const,
  };
}

/**
 * Ingest one event, optionally under the merge ingestion mode.
 *
 * `importId` is a bare uuid rather than a real `guest_imports` row: neither
 * `imported_from_guest_import_id` nor `merged_from_guest_import_id` is a foreign
 * key (deliberately — see db/schema/learning.ts), so a row here would add setup
 * without adding evidence. What is under test is that the id the coordinator
 * passes reaches both columns unchanged.
 */
async function ingestOne(
  userId: string,
  event: {
    eventId: string;
    parentEventId: string | null;
    revision: number;
    occurredAtClient: string;
  },
  importId?: string,
) {
  const attemptId = randomUUID();
  const sessionId = randomUUID();
  return ingestSchedulingBatch(
    userId,
    [
      wireEvent(
        event.eventId,
        attemptId,
        sessionId,
        event.parentEventId,
        event.revision,
        event.occurredAtClient,
      ),
    ],
    [pushAttempt(attemptId, sessionId)],
    importId === undefined
      ? { nowMs: NOW }
      : { nowMs: NOW, guestImport: { importId } },
  );
}

/** The seeded component row for an account, or undefined if none exists. */
async function componentRow(userId: string) {
  const [row] = await getDb()
    .select({
      id: studyComponents.id,
      revision: studyComponents.revision,
      reps: studyComponents.reps,
      mergedAt: studyComponents.mergedAt,
      mergedFromGuestImportId: studyComponents.mergedFromGuestImportId,
    })
    .from(studyComponents)
    .where(eq(studyComponents.userId, userId));
  return row;
}

/**
 * REL-005 as a checkable invariant over COMMITTED state: no component anywhere
 * in the database holds a multi-rooted accepted set without the stamp that
 * authorises it.
 *
 * A test cannot observe a half-finished transaction — that is what a
 * transaction is — so this is deliberately not phrased as "the stamp is written
 * at the same instant". It is phrased as the thing an operator would actually
 * alert on, and it is what a partial commit would break: an unmarked union is
 * precisely the state that throws at ingest, pull AND revoke, so if the union
 * and its authorisation could ever land separately, this assertion is what would
 * catch the window.
 *
 * Scoped to ONE account, not the whole database: the blocks above deliberately
 * seed unmarked unions as corruption fixtures, and a global scan would report
 * those and never fail for the reason it exists to fail for.
 */
async function expectNoUnauthorisedUnions(userId: string): Promise<void> {
  const rows = await getDb()
    .select({
      componentId: reviewEvents.studyComponentId,
      eventId: reviewEvents.eventId,
      parentEventId: reviewEvents.parentEventId,
      status: reviewEvents.status,
      mergedAt: studyComponents.mergedAt,
    })
    .from(reviewEvents)
    .innerJoin(
      studyComponents,
      eq(studyComponents.id, reviewEvents.studyComponentId),
    )
    .where(eq(reviewEvents.userId, userId));

  const byComponent = new Map<
    string,
    {
      accepted: { eventId: string; parentEventId: string | null }[];
      mergedAt: Date | null;
    }
  >();
  for (const row of rows) {
    if (row.status !== "scheduling") continue;
    const entry = byComponent.get(row.componentId) ?? {
      accepted: [],
      mergedAt: row.mergedAt,
    };
    entry.accepted.push({
      eventId: row.eventId,
      parentEventId: row.parentEventId,
    });
    byComponent.set(row.componentId, entry);
  }

  const unauthorised: string[] = [];
  for (const [componentId, entry] of byComponent) {
    const acceptedIds = new Set(entry.accepted.map((e) => e.eventId));
    const roots = entry.accepted.filter(
      (e) => e.parentEventId === null || !acceptedIds.has(e.parentEventId),
    ).length;
    if (roots > 1 && entry.mergedAt === null) unauthorised.push(componentId);
  }
  expect(unauthorised).toEqual([]);
}

describe("the merge ingestion mode is the only way to create a union", () => {
  it("stamps the component with the import that authorised it, and replays the union", async () => {
    const userId = await createTestUser();
    const importId = randomUUID();
    const a1 = randomUUID();
    const a2 = randomUUID();
    const g1 = randomUUID();

    // The account's own history, through ORDINARY push. No merge mode, no
    // stamp — this is a plain single-rooted Phase 16 chain.
    await ingestOne(userId, {
      eventId: a1,
      parentEventId: null,
      revision: 1,
      occurredAtClient: "2026-07-20T10:00:00.000Z",
    });
    await ingestOne(userId, {
      eventId: a2,
      parentEventId: a1,
      revision: 2,
      occurredAtClient: "2026-07-20T10:30:00.000Z",
    });
    const beforeMerge = await componentRow(userId);
    expect(beforeMerge?.mergedAt).toBeNull();
    expect(beforeMerge?.mergedFromGuestImportId).toBeNull();

    // Now the guest's history arrives under the coordinator's import: a SECOND
    // root on the same component, which ordinary sync would call a stale branch.
    const { results } = await ingestOne(
      userId,
      {
        eventId: g1,
        parentEventId: null,
        revision: 1,
        occurredAtClient: "2026-07-20T09:00:00.000Z",
      },
      importId,
    );
    expect(results[0]).toMatchObject({ itemId: g1, status: "accepted" });

    const merged = await componentRow(userId);
    // The stamp, and the provenance that explains it — the id the coordinator
    // passed, not a value invented on the way through.
    expect(merged?.mergedAt).not.toBeNull();
    expect(merged?.mergedFromGuestImportId).toBe(importId);
    // And the union genuinely replayed in that same transaction: three accepted
    // events across two chains. Had the mark been read from the pre-transaction
    // component row, this replay would have thrown ChainError instead.
    expect(merged?.reps).toBe(3);
    expect(merged?.revision).toBe(3);

    // The imported event carries its own provenance; the account's do not.
    const events = await getDb()
      .select({
        eventId: reviewEvents.eventId,
        importedFrom: reviewEvents.importedFromGuestImportId,
      })
      .from(reviewEvents)
      .where(eq(reviewEvents.userId, userId));
    const importedBy = new Map(events.map((e) => [e.eventId, e.importedFrom]));
    expect(importedBy.get(g1)).toBe(importId);
    expect(importedBy.get(a1)).toBeNull();
    expect(importedBy.get(a2)).toBeNull();

    await expectNoUnauthorisedUnions(userId);
  });

  it("refuses the same second root through ordinary push, and stamps nothing", async () => {
    // The counterpart of the test above, differing in ONE argument: no
    // `guestImport`. If the union rule were reachable without it — or if the
    // stamp could be obtained by any other route — this would pass too.
    const userId = await createTestUser();
    const a1 = randomUUID();
    const g1 = randomUUID();

    await ingestOne(userId, {
      eventId: a1,
      parentEventId: null,
      revision: 1,
      occurredAtClient: "2026-07-20T10:00:00.000Z",
    });

    const { results } = await ingestOne(userId, {
      eventId: g1,
      parentEventId: null,
      revision: 1,
      occurredAtClient: "2026-07-20T09:00:00.000Z",
    });
    expect(results[0]).toMatchObject({
      itemId: g1,
      status: "rejected",
      reasonCode: "stale_branch_conflict",
    });

    const component = await componentRow(userId);
    expect(component?.mergedAt).toBeNull();
    expect(component?.mergedFromGuestImportId).toBeNull();
    // The refused root left nothing behind: no second chain, no half-grant.
    expect(component?.reps).toBe(1);
    await expectNoUnauthorisedUnions(userId);
  });

  it("keeps the ORIGINAL stamp when a second import lands on an already-merged component", async () => {
    // `merged_at` answers "when did this component first become a union, and
    // which import made it one" — the question an incident investigation asks.
    // Re-stamping per import would overwrite that answer with the latest one.
    const userId = await createTestUser();
    const firstImport = randomUUID();
    const secondImport = randomUUID();

    await ingestOne(userId, {
      eventId: randomUUID(),
      parentEventId: null,
      revision: 1,
      occurredAtClient: "2026-07-20T10:00:00.000Z",
    });
    await ingestOne(
      userId,
      {
        eventId: randomUUID(),
        parentEventId: null,
        revision: 1,
        occurredAtClient: "2026-07-20T09:00:00.000Z",
      },
      firstImport,
    );
    const afterFirst = await componentRow(userId);

    await ingestOne(
      userId,
      {
        eventId: randomUUID(),
        parentEventId: null,
        revision: 1,
        occurredAtClient: "2026-07-20T08:00:00.000Z",
      },
      secondImport,
    );
    const afterSecond = await componentRow(userId);

    expect(afterSecond?.mergedFromGuestImportId).toBe(firstImport);
    expect(afterSecond?.mergedAt).toEqual(afterFirst?.mergedAt);
    // The third root still replayed — keeping the original stamp is a
    // provenance decision, not a refusal to merge again.
    expect(afterSecond?.reps).toBe(3);
    await expectNoUnauthorisedUnions(userId);
  });

  it("does not stamp an import that lands on a component with no account history", async () => {
    // A guest history merged into an account that never studied this component
    // is single-rooted. There is no union, so there is nothing to authorise, and
    // granting union tolerance anyway would retire the corruption canary for a
    // component that never needed it.
    const userId = await createTestUser();
    const importId = randomUUID();

    const { results } = await ingestOne(
      userId,
      {
        eventId: randomUUID(),
        parentEventId: null,
        revision: 1,
        occurredAtClient: "2026-07-20T09:00:00.000Z",
      },
      importId,
    );
    expect(results[0]).toMatchObject({ status: "accepted" });

    const component = await componentRow(userId);
    expect(component?.mergedAt).toBeNull();
    expect(component?.mergedFromGuestImportId).toBeNull();
    expect(component?.reps).toBe(1);
  });
});
