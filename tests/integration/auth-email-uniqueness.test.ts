import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";

/**
 * Case-insensitive email uniqueness integration proof (phases-15.md §16):
 * "Add an integration test showing that differing email casing cannot
 * create two accounts."
 */
describe("users email uniqueness (case-insensitive)", () => {
  it("rejects a second account whose email differs only by case", async () => {
    const db = getDb();
    const email = `case.test.${randomUUID()}@example.test`;
    await db.insert(users).values({ name: "First", email });
    await expect(
      db.insert(users).values({ name: "Second", email: email.toUpperCase() }),
    ).rejects.toThrow();
  });

  it("rejects an exact duplicate email", async () => {
    const db = getDb();
    const email = `exact.test.${randomUUID()}@example.test`;
    await db.insert(users).values({ name: "First", email });
    await expect(
      db.insert(users).values({ name: "Second", email }),
    ).rejects.toThrow();
  });
});
