import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { reviewEvents } from "@/db/schema";
import { createTestComponent } from "@/tests/integration/helpers/components";
import { createTestUser } from "@/tests/integration/helpers/users";

/**
 * `review_events` constraint integration suite (phases-15.md §54): rating/
 * status CHECKs, the deliberate absence of an FK on `parent_event_id` (a
 * `pending_parent` event must be storable before its parent arrives), and
 * `event_id` idempotency.
 */

function baseEvent(overrides: {
  userId: string;
  studyComponentId: string;
  eventId?: string;
  rating?: string;
  status?: string;
  parentEventId?: string | null;
}) {
  return {
    eventId: overrides.eventId ?? randomUUID(),
    userId: overrides.userId,
    studyComponentId: overrides.studyComponentId,
    rating: overrides.rating ?? "good",
    status: overrides.status ?? "scheduling",
    baseServerRevision: 0,
    parentEventId: overrides.parentEventId ?? null,
    clientComponentRevision: 1,
    occurredAtClient: new Date(),
    occurredAtCanonical: new Date(),
    deviceId: "device-1",
    clientSequence: 1,
    contentVersion: "test-1",
    timezoneAtEvent: "UTC",
    utcOffsetMinutesAtEvent: 0,
    localDateAtEvent: "2026-01-01",
    timezoneSource: "browser_detected" as const,
  };
}

describe("review_events constraint integration", () => {
  it("rejects an invalid rating", async () => {
    const db = getDb();
    const userId = await createTestUser();
    const componentId = await createTestComponent(userId);
    await expect(
      db.insert(reviewEvents).values(
        baseEvent({
          userId,
          studyComponentId: componentId,
          rating: "excellent",
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects an invalid status", async () => {
    const db = getDb();
    const userId = await createTestUser();
    const componentId = await createTestComponent(userId);
    await expect(
      db.insert(reviewEvents).values(
        baseEvent({
          userId,
          studyComponentId: componentId,
          status: "unknown_status",
        }),
      ),
    ).rejects.toThrow();
  });

  it("stores a pending_parent event whose parent_event_id does not (yet) exist anywhere", async () => {
    const db = getDb();
    const userId = await createTestUser();
    const componentId = await createTestComponent(userId);
    const unknownParent = randomUUID();
    const [row] = await db
      .insert(reviewEvents)
      .values(
        baseEvent({
          userId,
          studyComponentId: componentId,
          status: "pending_parent",
          parentEventId: unknownParent,
        }),
      )
      .returning();
    expect(row?.parentEventId).toBe(unknownParent);
  });

  it("rejects a duplicate event_id (idempotent ingestion key)", async () => {
    const db = getDb();
    const userId = await createTestUser();
    const componentId = await createTestComponent(userId);
    const eventId = randomUUID();
    await db
      .insert(reviewEvents)
      .values(baseEvent({ userId, studyComponentId: componentId, eventId }));
    await expect(
      db
        .insert(reviewEvents)
        .values(baseEvent({ userId, studyComponentId: componentId, eventId })),
    ).rejects.toThrow();
  });

  it("accepts every valid rating and status value", async () => {
    const db = getDb();
    const userId = await createTestUser();
    const componentId = await createTestComponent(userId);
    for (const rating of ["again", "hard", "good", "easy"] as const) {
      await expect(
        db
          .insert(reviewEvents)
          .values(baseEvent({ userId, studyComponentId: componentId, rating })),
      ).resolves.toBeDefined();
    }
    for (const status of [
      "scheduling",
      "reinforcement",
      "conflict_demoted",
      "revoked",
      "pending_parent",
    ] as const) {
      await expect(
        db
          .insert(reviewEvents)
          .values(baseEvent({ userId, studyComponentId: componentId, status })),
      ).resolves.toBeDefined();
    }
  });
});
