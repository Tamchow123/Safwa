import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { reviewEvents, studyAttempts, studySessions } from "@/db/schema";
import { createTestComponent } from "@/tests/integration/helpers/components";
import { createTestRelease } from "@/tests/integration/helpers/content-versions";
import { createTestUser } from "@/tests/integration/helpers/users";

/**
 * Proves `release_id` — not `content_version` — is what actually
 * disambiguates which manifests generated a session/attempt/event
 * (modules/study-engine/session.ts's own doc comment: `contentVersion` is
 * human-readable metadata that MAY REPEAT across releases, e.g. a
 * corrected re-publish under the same version string; `releaseId` is the
 * content-hash-derived authoritative identity). If two releases share one
 * `content_version`, a row's `content_version` alone cannot tell them
 * apart — only `release_id` can, and Phase 16's authoritative
 * reconstruction depends on that being true at the database level, not
 * merely by client convention.
 */
describe("release identity: release_id disambiguates a repeated content_version", () => {
  it("each attempt/session/event resolves to its own release_id when two releases share one content_version", async () => {
    const db = getDb();
    const sharedContentVersion = "2.2.0";
    const releaseA = await createTestRelease({
      contentVersion: sharedContentVersion,
    });
    const releaseB = await createTestRelease({
      contentVersion: sharedContentVersion,
    });
    expect(releaseA).not.toBe(releaseB);

    const userId = await createTestUser();
    const componentId = await createTestComponent(userId);

    const [sessionA] = await db
      .insert(studySessions)
      .values({
        userId,
        mode: "flashcard",
        config: {},
        releaseId: releaseA,
        contentVersion: sharedContentVersion,
        startedAt: new Date(),
      })
      .returning({ id: studySessions.id });
    const [sessionB] = await db
      .insert(studySessions)
      .values({
        userId,
        mode: "flashcard",
        config: {},
        releaseId: releaseB,
        contentVersion: sharedContentVersion,
        startedAt: new Date(),
      })
      .returning({ id: studySessions.id });
    if (!sessionA || !sessionB) {
      throw new Error("expected both session inserts to return a row");
    }

    function attemptRow(sessionId: string, releaseId: string) {
      return {
        id: randomUUID(),
        userId,
        sessionId,
        studyComponentId: componentId,
        entryId: 1,
        skillTypeId: "bab_identification",
        promptRef: { entryId: 1, field: "bab" },
        correctAnswerRef: { entryId: 1, field: "bab" },
        isCorrect: true,
        isFirstAttempt: true,
        isReinforcement: false,
        questionPosition: 0,
        mode: "flashcard" as const,
        questionInstanceId: randomUUID(),
        questionSeed: "seed",
        questionGeneratorVersion: "1",
        occurredAtUtc: new Date(),
        timezoneAtEvent: "UTC",
        utcOffsetMinutesAtEvent: 0,
        localDateAtEvent: "2026-01-01",
        timezoneSource: "browser_detected" as const,
        deviceId: "device-1",
        releaseId,
        contentVersion: sharedContentVersion,
      };
    }

    const [attemptA] = await db
      .insert(studyAttempts)
      .values(attemptRow(sessionA.id, releaseA))
      .returning({ id: studyAttempts.id });
    const [attemptB] = await db
      .insert(studyAttempts)
      .values(attemptRow(sessionB.id, releaseB))
      .returning({ id: studyAttempts.id });
    if (!attemptA || !attemptB) {
      throw new Error("expected both attempt inserts to return a row");
    }

    await db.insert(reviewEvents).values({
      eventId: randomUUID(),
      userId,
      studyComponentId: componentId,
      attemptId: attemptA.id,
      rating: "good",
      status: "scheduling",
      baseServerRevision: 0,
      clientComponentRevision: 1,
      occurredAtClient: new Date(),
      occurredAtCanonical: new Date(),
      deviceId: "device-1",
      clientSequence: 1,
      sessionId: sessionA.id,
      releaseId: releaseA,
      contentVersion: sharedContentVersion,
      timezoneAtEvent: "UTC",
      utcOffsetMinutesAtEvent: 0,
      localDateAtEvent: "2026-01-01",
      timezoneSource: "browser_detected",
    });
    await db.insert(reviewEvents).values({
      eventId: randomUUID(),
      userId,
      studyComponentId: componentId,
      attemptId: attemptB.id,
      rating: "good",
      status: "scheduling",
      baseServerRevision: 0,
      clientComponentRevision: 1,
      occurredAtClient: new Date(),
      occurredAtCanonical: new Date(),
      deviceId: "device-1",
      clientSequence: 1,
      sessionId: sessionB.id,
      releaseId: releaseB,
      contentVersion: sharedContentVersion,
      timezoneAtEvent: "UTC",
      utcOffsetMinutesAtEvent: 0,
      localDateAtEvent: "2026-01-01",
      timezoneSource: "browser_detected",
    });

    const [storedSessionA] = await db
      .select({ releaseId: studySessions.releaseId })
      .from(studySessions)
      .where(eq(studySessions.id, sessionA.id));
    const [storedSessionB] = await db
      .select({ releaseId: studySessions.releaseId })
      .from(studySessions)
      .where(eq(studySessions.id, sessionB.id));
    expect(storedSessionA?.releaseId).toBe(releaseA);
    expect(storedSessionB?.releaseId).toBe(releaseB);
    expect(storedSessionA?.releaseId).not.toBe(storedSessionB?.releaseId);

    const [storedAttemptA] = await db
      .select({ releaseId: studyAttempts.releaseId })
      .from(studyAttempts)
      .where(eq(studyAttempts.id, attemptA.id));
    const [storedAttemptB] = await db
      .select({ releaseId: studyAttempts.releaseId })
      .from(studyAttempts)
      .where(eq(studyAttempts.id, attemptB.id));
    expect(storedAttemptA?.releaseId).toBe(releaseA);
    expect(storedAttemptB?.releaseId).toBe(releaseB);

    const [storedEventA] = await db
      .select({ releaseId: reviewEvents.releaseId })
      .from(reviewEvents)
      .where(eq(reviewEvents.attemptId, attemptA.id));
    const [storedEventB] = await db
      .select({ releaseId: reviewEvents.releaseId })
      .from(reviewEvents)
      .where(eq(reviewEvents.attemptId, attemptB.id));
    expect(storedEventA?.releaseId).toBe(releaseA);
    expect(storedEventB?.releaseId).toBe(releaseB);
  });

  it("rejects a study_session/study_attempt/review_event with a release_id that isn't registered", async () => {
    const db = getDb();
    const userId = await createTestUser();
    const componentId = await createTestComponent(userId);
    const unknownRelease = `release-${randomUUID()}`;

    await expect(
      db.insert(studySessions).values({
        userId,
        mode: "flashcard",
        config: {},
        releaseId: unknownRelease,
        contentVersion: "1.0.0",
        startedAt: new Date(),
      }),
    ).rejects.toThrow();

    await expect(
      db.insert(studyAttempts).values({
        id: randomUUID(),
        userId,
        studyComponentId: componentId,
        entryId: 1,
        skillTypeId: "bab_identification",
        promptRef: { entryId: 1, field: "bab" },
        correctAnswerRef: { entryId: 1, field: "bab" },
        isCorrect: true,
        isFirstAttempt: true,
        isReinforcement: false,
        questionPosition: 0,
        mode: "flashcard",
        questionInstanceId: randomUUID(),
        questionSeed: "seed",
        questionGeneratorVersion: "1",
        occurredAtUtc: new Date(),
        timezoneAtEvent: "UTC",
        utcOffsetMinutesAtEvent: 0,
        localDateAtEvent: "2026-01-01",
        timezoneSource: "browser_detected",
        deviceId: "device-1",
        releaseId: unknownRelease,
        contentVersion: "1.0.0",
      }),
    ).rejects.toThrow();
  });
});
