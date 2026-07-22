import { getDb } from "@/db/client";
import { studyComponents } from "@/db/schema";

/** Inserts a valid entry-level study_component and returns its id. */
export async function createTestComponent(
  userId: string,
  entryId = 1,
  skillTypeId = "bab_identification",
): Promise<string> {
  const db = getDb();
  const [row] = await db
    .insert(studyComponents)
    .values({
      userId,
      entryId,
      skillTypeId,
      componentShape: "entry_level",
    })
    .returning({ id: studyComponents.id });
  if (!row) {
    throw new Error("createTestComponent: insert returned no row");
  }
  return row.id;
}
