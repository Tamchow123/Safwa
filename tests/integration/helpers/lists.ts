import { getDb } from "@/db/client";
import { customLists } from "@/db/schema";

/** Inserts a valid custom list and returns its id. */
export async function createTestList(
  userId: string,
  name = "Test List",
): Promise<string> {
  const db = getDb();
  const [row] = await db
    .insert(customLists)
    .values({ userId, name, normalisedName: name.toLowerCase() })
    .returning({ id: customLists.id });
  if (!row) {
    throw new Error("createTestList: insert returned no row");
  }
  return row.id;
}
