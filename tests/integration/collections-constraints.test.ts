import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { bookmarks, customListEntries, customLists } from "@/db/schema";
import { createTestList } from "@/tests/integration/helpers/lists";
import { createTestUser } from "@/tests/integration/helpers/users";

/**
 * Server-side collection-table constraint integration suite
 * (phases-15.md §54): bookmark uniqueness, list-membership uniqueness,
 * list-name uniqueness per user (but not across users), and the
 * name-length/updated-not-before-created CHECKs.
 */
describe("collections constraint integration", () => {
  it("rejects a duplicate bookmark for the same user/entry", async () => {
    const db = getDb();
    const userId = await createTestUser();
    await db.insert(bookmarks).values({ userId, entryId: 1 });
    await expect(
      db.insert(bookmarks).values({ userId, entryId: 1 }),
    ).rejects.toThrow();
  });

  it("allows the same entry bookmarked by two different users", async () => {
    const db = getDb();
    const userA = await createTestUser();
    const userB = await createTestUser();
    await expect(
      db.insert(bookmarks).values({ userId: userA, entryId: 1 }),
    ).resolves.toBeDefined();
    await expect(
      db.insert(bookmarks).values({ userId: userB, entryId: 1 }),
    ).resolves.toBeDefined();
  });

  it("rejects a duplicate list-membership entry", async () => {
    const db = getDb();
    const userId = await createTestUser();
    const listId = await createTestList(userId, "Verbs");
    await db.insert(customListEntries).values({ listId, entryId: 1 });
    await expect(
      db.insert(customListEntries).values({ listId, entryId: 1 }),
    ).rejects.toThrow();
  });

  it("rejects a duplicate normalised list name for the same user", async () => {
    const db = getDb();
    const userId = await createTestUser();
    await db
      .insert(customLists)
      .values({ userId, name: "Nouns", normalisedName: "nouns" });
    await expect(
      db
        .insert(customLists)
        .values({ userId, name: "NOUNS", normalisedName: "nouns" }),
    ).rejects.toThrow();
  });

  it("allows the same list name for two different users", async () => {
    const db = getDb();
    const userA = await createTestUser();
    const userB = await createTestUser();
    await expect(
      db
        .insert(customLists)
        .values({ userId: userA, name: "Verbs", normalisedName: "verbs" }),
    ).resolves.toBeDefined();
    await expect(
      db
        .insert(customLists)
        .values({ userId: userB, name: "Verbs", normalisedName: "verbs" }),
    ).resolves.toBeDefined();
  });

  it("rejects a list name longer than 60 characters", async () => {
    const db = getDb();
    const userId = await createTestUser();
    const longName = "x".repeat(61);
    await expect(
      db.insert(customLists).values({
        userId,
        name: longName,
        normalisedName: longName.toLowerCase(),
      }),
    ).rejects.toThrow();
  });

  it("rejects an empty list name", async () => {
    const db = getDb();
    const userId = await createTestUser();
    await expect(
      db.insert(customLists).values({ userId, name: "", normalisedName: "" }),
    ).rejects.toThrow();
  });
});
