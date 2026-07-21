import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import {
  contentVersions,
  dailyActivity,
  guestImports,
  userSettings,
} from "@/db/schema";
import { createTestUser } from "@/tests/integration/helpers/users";

const VALID_HEX64 = "a".repeat(64);

function contentVersionRow(
  overrides: Partial<typeof contentVersions.$inferInsert> = {},
) {
  return {
    releaseId: overrides.releaseId ?? `release-${randomUUID()}`,
    contentVersion: "1.0.0",
    schemaVersion: "1.0.0",
    questionGeneratorVersion: "1",
    entryCount: 455,
    checksumLearner: VALID_HEX64,
    checksumValidation: VALID_HEX64,
    checksumAssessment: VALID_HEX64,
    releaseStatus: "supported",
    minimumSupportedClientVersion: "0.1.0",
    minimumSupportedEventSchema: 1,
    ...overrides,
  };
}

describe("daily_activity constraint integration", () => {
  it("rejects a duplicate (user_id, local_date) row", async () => {
    const db = getDb();
    const userId = await createTestUser();
    await db.insert(dailyActivity).values({ userId, localDate: "2026-01-01" });
    await expect(
      db.insert(dailyActivity).values({ userId, localDate: "2026-01-01" }),
    ).rejects.toThrow();
  });

  it("allows the same local_date for two different users", async () => {
    const db = getDb();
    const userA = await createTestUser();
    const userB = await createTestUser();
    await expect(
      db
        .insert(dailyActivity)
        .values({ userId: userA, localDate: "2026-01-01" }),
    ).resolves.toBeDefined();
    await expect(
      db
        .insert(dailyActivity)
        .values({ userId: userB, localDate: "2026-01-01" }),
    ).resolves.toBeDefined();
  });
});

describe("user_settings constraint integration", () => {
  it("enforces one row per user", async () => {
    const db = getDb();
    const userId = await createTestUser();
    await db.insert(userSettings).values({ userId });
    await expect(db.insert(userSettings).values({ userId })).rejects.toThrow();
  });

  it("rejects an out-of-bounds question_count", async () => {
    const db = getDb();
    const userId = await createTestUser();
    await expect(
      db.insert(userSettings).values({ userId, questionCount: 0 }),
    ).rejects.toThrow();
    await expect(
      db.insert(userSettings).values({ userId, questionCount: 101 }),
    ).rejects.toThrow();
  });

  it("rejects browser timezone_mode with a non-NULL timezone_name", async () => {
    const db = getDb();
    const userId = await createTestUser();
    await expect(
      db.insert(userSettings).values({
        userId,
        timezoneMode: "browser",
        timezoneName: "Asia/Dubai",
      }),
    ).rejects.toThrow();
  });

  it("rejects iana timezone_mode with a NULL timezone_name", async () => {
    const db = getDb();
    const userId = await createTestUser();
    await expect(
      db.insert(userSettings).values({ userId, timezoneMode: "iana" }),
    ).rejects.toThrow();
  });

  it("accepts a valid iana timezone shape", async () => {
    const db = getDb();
    const userId = await createTestUser();
    await expect(
      db.insert(userSettings).values({
        userId,
        timezoneMode: "iana",
        timezoneName: "Asia/Dubai",
      }),
    ).resolves.toBeDefined();
  });
});

describe("guest_imports constraint integration", () => {
  it("rejects a duplicate import_key (idempotency anchor)", async () => {
    const db = getDb();
    const userId = await createTestUser();
    const importKey = randomUUID();
    await db
      .insert(guestImports)
      .values({ userId, deviceId: "device-1", importKey, result: "applied" });
    await expect(
      db
        .insert(guestImports)
        .values({ userId, deviceId: "device-1", importKey, result: "no_op" }),
    ).rejects.toThrow();
  });
});

describe("content_versions constraint integration", () => {
  it("rejects a non-hex64 checksum", async () => {
    const db = getDb();
    await expect(
      db
        .insert(contentVersions)
        .values(contentVersionRow({ checksumLearner: "not-a-checksum" })),
    ).rejects.toThrow();
  });

  it("rejects a non-positive entry_count", async () => {
    const db = getDb();
    await expect(
      db.insert(contentVersions).values(contentVersionRow({ entryCount: 0 })),
    ).rejects.toThrow();
  });

  it("enforces exactly one active release, alongside any number of supported/revoked releases", async () => {
    // `content_versions` has no per-user scoping, so — unlike every other
    // describe block in this file — these assertions must live in ONE test:
    // this file resets once per FILE (tests/integration/setup.ts), so a
    // second test asserting "a second active release is allowed after a
    // supported/revoked one" would collide with the active row this same
    // test already committed.
    const db = getDb();
    await expect(
      db
        .insert(contentVersions)
        .values(contentVersionRow({ releaseStatus: "active" })),
    ).resolves.toBeDefined();
    await expect(
      db
        .insert(contentVersions)
        .values(contentVersionRow({ releaseStatus: "active" })),
    ).rejects.toThrow();
    await expect(
      db
        .insert(contentVersions)
        .values(contentVersionRow({ releaseStatus: "supported" })),
    ).resolves.toBeDefined();
    await expect(
      db
        .insert(contentVersions)
        .values(contentVersionRow({ releaseStatus: "revoked" })),
    ).resolves.toBeDefined();
  });
});
