import { randomUUID } from "node:crypto";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";

/**
 * Inserts a fresh user with a unique email and returns its id. Every
 * application table scopes its uniqueness to `user_id`, so tests isolate
 * themselves by creating their own user rather than needing a truncate
 * between every single test (tests/integration/setup.ts resets once per
 * file instead).
 */
export async function createTestUser(
  namePrefix = "Test User",
): Promise<string> {
  const db = getDb();
  const [row] = await db
    .insert(users)
    .values({
      name: namePrefix,
      email: `${namePrefix.toLowerCase().replace(/\s+/g, ".")}.${randomUUID()}@example.test`,
    })
    .returning({ id: users.id });
  if (!row) {
    throw new Error("createTestUser: insert returned no row");
  }
  return row.id;
}
