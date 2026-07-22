import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "@/db/client";
import {
  bookmarks,
  reviewEvents,
  studyComponents,
  syncAuditLog,
  syncTombstones,
  users,
  userSyncState,
} from "@/db/schema";
import { createTestComponent } from "@/tests/integration/helpers/components";
import { createTestRelease } from "@/tests/integration/helpers/content-versions";
import { createTestUser } from "@/tests/integration/helpers/users";

/**
 * Phase 16 migration 0002 schema integration suite. Proves the account-cursor,
 * tombstone and audit tables exist with their constraints, the `last_sync_seq`
 * cursor columns default to 0 on the existing tables, and account deletion
 * cascades every new Phase 16 table (phases-16.md §32).
 */
describe("sync schema (migration 0002)", () => {
  it("defaults user_sync_state.sync_revision to 0", async () => {
    const db = getDb();
    const userId = await createTestUser();
    const [row] = await db.insert(userSyncState).values({ userId }).returning();
    expect(row?.syncRevision).toBe(0);
  });

  it("defaults last_sync_seq to 0 on study_components and bookmarks", async () => {
    const db = getDb();
    const userId = await createTestUser();
    const componentId = await createTestComponent(userId);
    await db.insert(bookmarks).values({ userId, entryId: 1 });

    const [component] = await db
      .select()
      .from(studyComponents)
      .where(eq(studyComponents.id, componentId));
    const [bookmark] = await db
      .select()
      .from(bookmarks)
      .where(eq(bookmarks.userId, userId));
    expect(component?.lastSyncSeq).toBe(0);
    expect(bookmark?.lastSyncSeq).toBe(0);
  });

  it("defaults review_events.last_sync_seq to 0 and clock_suspect to false", async () => {
    const db = getDb();
    const userId = await createTestUser();
    const componentId = await createTestComponent(userId);
    const releaseId = await createTestRelease();
    const [event] = await db
      .insert(reviewEvents)
      .values({
        eventId: randomUUID(),
        userId,
        studyComponentId: componentId,
        rating: "good",
        status: "scheduling",
        baseServerRevision: 0,
        clientComponentRevision: 1,
        occurredAtClient: new Date(),
        occurredAtCanonical: new Date(),
        deviceId: "device-1",
        clientSequence: 1,
        releaseId,
        contentVersion: "test-1",
        timezoneAtEvent: "UTC",
        utcOffsetMinutesAtEvent: 0,
        localDateAtEvent: "2026-01-01",
        timezoneSource: "browser_detected",
      })
      .returning();
    expect(event?.lastSyncSeq).toBe(0);
    expect(event?.clockSuspect).toBe(false);
    expect(event?.revokedAt).toBeNull();
  });

  it("accepts a valid tombstone and enforces (user, kind, ref) uniqueness", async () => {
    const db = getDb();
    const userId = await createTestUser();
    await db
      .insert(syncTombstones)
      .values({ userId, kind: "bookmark", ref: "42", lastSyncSeq: 1 });

    await expect(
      db
        .insert(syncTombstones)
        .values({ userId, kind: "bookmark", ref: "42", lastSyncSeq: 2 }),
    ).rejects.toThrow();
  });

  it("rejects an invalid tombstone kind", async () => {
    const db = getDb();
    const userId = await createTestUser();
    await expect(
      db
        .insert(syncTombstones)
        .values({ userId, kind: "banana", ref: "1", lastSyncSeq: 1 }),
    ).rejects.toThrow();
  });

  it("rejects an invalid audit severity and item kind", async () => {
    const db = getDb();
    const userId = await createTestUser();
    await expect(
      db.insert(syncAuditLog).values({
        userId,
        itemKind: "event",
        itemId: randomUUID(),
        reasonCode: "cycle_detected",
        severity: "catastrophic",
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(syncAuditLog).values({
        userId,
        itemKind: "not_a_kind",
        itemId: randomUUID(),
        reasonCode: "cycle_detected",
        severity: "warning",
      }),
    ).rejects.toThrow();
  });

  it("rejects a negative account cursor stamp", async () => {
    const db = getDb();
    const userId = await createTestUser();
    await expect(
      db
        .insert(syncTombstones)
        .values({ userId, kind: "list", ref: randomUUID(), lastSyncSeq: -1 }),
    ).rejects.toThrow();
  });

  it("cascades user_sync_state, sync_tombstones and sync_audit_log on user deletion", async () => {
    const db = getDb();
    const userId = await createTestUser();
    await db.insert(userSyncState).values({ userId, syncRevision: 5 });
    await db
      .insert(syncTombstones)
      .values({ userId, kind: "bookmark", ref: "7", lastSyncSeq: 5 });
    await db.insert(syncAuditLog).values({
      userId,
      itemKind: "event",
      itemId: randomUUID(),
      reasonCode: "clock_corrected",
      severity: "info",
      clockSuspect: true,
    });

    await db.delete(users).where(eq(users.id, userId));

    expect(
      await db
        .select()
        .from(userSyncState)
        .where(eq(userSyncState.userId, userId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(syncTombstones)
        .where(eq(syncTombstones.userId, userId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(syncAuditLog)
        .where(eq(syncAuditLog.userId, userId)),
    ).toHaveLength(0);
  });
});
