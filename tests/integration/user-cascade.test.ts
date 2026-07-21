import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import {
  accounts,
  bookmarks,
  customListEntries,
  customLists,
  dailyActivity,
  guestImports,
  rateLimits,
  reviewEvents,
  sessions,
  studyAttempts,
  studyComponents,
  studySessions,
  userSettings,
  users,
} from "@/db/schema";
import { createTestComponent } from "@/tests/integration/helpers/components";
import { createTestList } from "@/tests/integration/helpers/lists";
import { createTestUser } from "@/tests/integration/helpers/users";

/**
 * User cascade-deletion and ownership integration suite (phases-15.md §54).
 * Proves every application table that scopes ownership to `user_id`
 * actually cascades on `DELETE FROM users`, and that session/account rows
 * cascade too (Better Auth's own tables).
 */
describe("user cascade deletion", () => {
  it("cascades to sessions and accounts", async () => {
    const db = getDb();
    const userId = await createTestUser();
    await db.insert(sessions).values({
      userId,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await db.insert(accounts).values({
      userId,
      accountId: randomUUID(),
      providerId: "credential",
    });

    await db.delete(users).where(eq(users.id, userId));

    expect(
      (await db.select().from(sessions).where(eq(sessions.userId, userId)))
        .length,
    ).toBe(0);
    expect(
      (await db.select().from(accounts).where(eq(accounts.userId, userId)))
        .length,
    ).toBe(0);
  });

  it("cascades to study_components, study_sessions, study_attempts, review_events, daily_activity", async () => {
    const db = getDb();
    const userId = await createTestUser();
    const componentId = await createTestComponent(userId);
    const [session] = await db
      .insert(studySessions)
      .values({
        userId,
        mode: "flashcard",
        config: {},
        contentVersion: "test-1",
        startedAt: new Date(),
      })
      .returning({ id: studySessions.id });
    if (!session) throw new Error("session insert returned no row");
    await db.insert(studyAttempts).values({
      id: randomUUID(),
      userId,
      sessionId: session.id,
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
      contentVersion: "test-1",
    });
    await db.insert(reviewEvents).values({
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
      contentVersion: "test-1",
      timezoneAtEvent: "UTC",
      utcOffsetMinutesAtEvent: 0,
      localDateAtEvent: "2026-01-01",
      timezoneSource: "browser_detected",
    });
    await db.insert(dailyActivity).values({
      userId,
      localDate: "2026-01-01",
    });

    await db.delete(users).where(eq(users.id, userId));

    for (const [table, column] of [
      [studyComponents, studyComponents.userId],
      [studySessions, studySessions.userId],
      [studyAttempts, studyAttempts.userId],
      [reviewEvents, reviewEvents.userId],
      [dailyActivity, dailyActivity.userId],
    ] as const) {
      const remaining = await db.select().from(table).where(eq(column, userId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("cascades to bookmarks, custom_lists, custom_list_entries, user_settings, guest_imports", async () => {
    const db = getDb();
    const userId = await createTestUser();
    await db.insert(bookmarks).values({ userId, entryId: 1 });
    const listId = await createTestList(userId, "My List");
    await db.insert(customListEntries).values({ listId, entryId: 1 });
    await db.insert(userSettings).values({ userId });
    await db.insert(guestImports).values({
      userId,
      deviceId: "device-1",
      importKey: randomUUID(),
      result: "applied",
    });

    await db.delete(users).where(eq(users.id, userId));

    expect(
      await db.select().from(bookmarks).where(eq(bookmarks.userId, userId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(customLists).where(eq(customLists.userId, userId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(customListEntries)
        .where(eq(customListEntries.listId, listId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.userId, userId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(guestImports)
        .where(eq(guestImports.userId, userId)),
    ).toHaveLength(0);
  });

  it("the database-backed rate_limit table accepts rows independent of any user", async () => {
    const db = getDb();
    const [row] = await db
      .insert(rateLimits)
      .values({
        key: `test:${randomUUID()}`,
        count: 1,
        lastRequest: Date.now(),
      })
      .returning();
    expect(row?.count).toBe(1);
  });
});
