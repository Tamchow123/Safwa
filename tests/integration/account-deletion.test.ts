import { randomUUID } from "node:crypto";
import { desc, eq, like } from "drizzle-orm";
import { parseSetCookieHeader } from "better-auth/cookies";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import {
  accounts,
  bookmarks,
  contentVersions,
  customListEntries,
  customLists,
  dailyActivity,
  guestImports,
  reviewEvents,
  sessions,
  skillTypes,
  studyAttempts,
  studyComponents,
  studySessions,
  userSettings,
  users,
  verifications,
} from "@/db/schema";
import { getAuth } from "@/modules/auth/server";
import { createTestComponent } from "@/tests/integration/helpers/components";
import { createTestList } from "@/tests/integration/helpers/lists";

const PASSWORD = "correct-horse-battery-staple";

/**
 * End-to-end self-service account deletion (phases-15.md §51), exercised
 * through Better Auth's REAL API (not a raw `DELETE FROM users`, which
 * tests/integration/user-cascade.test.ts already proves cascades at the
 * FK level). modules/auth/server.ts (T11) configures
 * `deleteUser.sendDeleteAccountVerification`, so this is a genuine
 * two-step flow: signIn -> deleteUser({password}) sends a confirmation
 * email and does NOT delete yet -> deleteUserCallback({token}) (the link
 * the learner would click) actually deletes. Session cookie extraction
 * mirrors better-auth's own test-instance.mjs signInWithUser helper.
 */
async function signInAndGetSessionHeaders(email: string): Promise<Headers> {
  const response = await getAuth().api.signInEmail({
    body: { email, password: PASSWORD },
    asResponse: true,
  });
  const setCookie = response.headers.get("set-cookie") ?? "";
  const token = parseSetCookieHeader(setCookie).get(
    "better-auth.session_token",
  )?.value;
  if (!token) {
    throw new Error("signInAndGetSessionHeaders: no session token in response");
  }
  return new Headers({ cookie: `better-auth.session_token=${token}` });
}

async function seedUserWithAppRows(email: string): Promise<string> {
  const db = getDb();
  const signUp = await getAuth().api.signUpEmail({
    body: { name: "Deletion Test", email, password: PASSWORD },
  });
  const userId = signUp.user.id;
  // requireEmailVerification blocks sign-in until verified; mark verified
  // directly since this test proves deletion, not the verification flow.
  await db
    .update(users)
    .set({ emailVerified: true })
    .where(eq(users.id, userId));

  const componentId = await createTestComponent(userId);
  const [studySession] = await db
    .insert(studySessions)
    .values({
      userId,
      mode: "flashcard",
      config: {},
      contentVersion: "test-1",
      startedAt: new Date(),
    })
    .returning({ id: studySessions.id });
  if (!studySession) throw new Error("studySession insert returned no row");
  await db.insert(studyAttempts).values({
    id: randomUUID(),
    userId,
    sessionId: studySession.id,
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
  await db.insert(dailyActivity).values({ userId, localDate: "2026-01-01" });
  await db.insert(bookmarks).values({ userId, entryId: 1 });
  const listId = await createTestList(userId, "Deletion Test List");
  await db.insert(customListEntries).values({ listId, entryId: 1 });
  await db.insert(userSettings).values({ userId });
  await db.insert(guestImports).values({
    userId,
    deviceId: "device-1",
    importKey: randomUUID(),
    result: "applied",
  });

  return userId;
}

describe("self-service account deletion", () => {
  it("rejects the wrong password with a generic error and does not delete anything", async () => {
    const email = `delete.wrong-password.${randomUUID()}@example.test`;
    const userId = await seedUserWithAppRows(email);
    const headers = await signInAndGetSessionHeaders(email);

    await expect(
      getAuth().api.deleteUser({
        body: { password: "totally-wrong-password" },
        headers,
      }),
    ).rejects.toThrow();

    expect(
      await getDb().select().from(users).where(eq(users.id, userId)),
    ).toHaveLength(1);
  });

  it("sends a confirmation email on the correct password without deleting yet", async () => {
    const email = `delete.pending.${randomUUID()}@example.test`;
    const userId = await seedUserWithAppRows(email);
    const headers = await signInAndGetSessionHeaders(email);

    const result = await getAuth().api.deleteUser({
      body: { password: PASSWORD },
      headers,
    });

    expect(result.success).toBe(true);
    expect(
      await getDb().select().from(users).where(eq(users.id, userId)),
    ).toHaveLength(1);
  });

  it("cascades every listed table via the real deleteUser + confirmation-callback flow, while skill_types and content_versions remain", async () => {
    const email = `delete.confirmed.${randomUUID()}@example.test`;
    const userId = await seedUserWithAppRows(email);
    const listRows = await getDb()
      .select()
      .from(customLists)
      .where(eq(customLists.userId, userId));
    const listId = listRows[0]?.id;
    if (!listId) throw new Error("expected a seeded custom list");

    await getDb()
      .insert(contentVersions)
      .values({
        releaseId: `release-deletion-test-${randomUUID()}`,
        contentVersion: "1.0.0",
        schemaVersion: "1",
        questionGeneratorVersion: "1",
        entryCount: 1,
        checksumLearner: "a".repeat(64),
        checksumValidation: "b".repeat(64),
        checksumAssessment: "c".repeat(64),
        releaseStatus: "supported",
        minimumSupportedClientVersion: "0.1.0",
        minimumSupportedEventSchema: 1,
      });

    const headers = await signInAndGetSessionHeaders(email);
    await getAuth().api.deleteUser({ body: { password: PASSWORD }, headers });

    // Extract the deletion-confirmation token the same way the learner's
    // emailed link would carry it, then complete the deletion exactly as
    // clicking that link would.
    const [verificationRow] = await getDb()
      .select()
      .from(verifications)
      .where(like(verifications.identifier, "delete-account-%"))
      .orderBy(desc(verifications.createdAt))
      .limit(1);
    if (!verificationRow) {
      throw new Error("expected a delete-account verification row");
    }
    const token = verificationRow.identifier.replace(/^delete-account-/, "");

    await getAuth().api.deleteUserCallback({ query: { token }, headers });

    for (const [table, column] of [
      [sessions, sessions.userId],
      [accounts, accounts.userId],
      [studyComponents, studyComponents.userId],
      [studySessions, studySessions.userId],
      [studyAttempts, studyAttempts.userId],
      [reviewEvents, reviewEvents.userId],
      [dailyActivity, dailyActivity.userId],
      [bookmarks, bookmarks.userId],
      [customLists, customLists.userId],
      [userSettings, userSettings.userId],
      [guestImports, guestImports.userId],
    ] as const) {
      const remaining = await getDb()
        .select()
        .from(table)
        .where(eq(column, userId));
      expect(remaining).toHaveLength(0);
    }
    expect(
      await getDb()
        .select()
        .from(customListEntries)
        .where(eq(customListEntries.listId, listId)),
    ).toHaveLength(0);
    expect(
      await getDb().select().from(users).where(eq(users.id, userId)),
    ).toHaveLength(0);

    // Global lookup tables must be untouched by this user's deletion.
    expect((await getDb().select().from(skillTypes)).length).toBeGreaterThan(0);
    expect(
      (await getDb().select().from(contentVersions)).length,
    ).toBeGreaterThan(0);
  });
});
