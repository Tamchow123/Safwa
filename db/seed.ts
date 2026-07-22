/**
 * Idempotent `skill_types` seed (phases-15.md §17) shared by db/migrate.ts
 * (applied after every migration run) and db/reset-test-database.ts
 * (re-applied after every disposable-test-database wipe).
 */
import type { Database } from "@/db/client";
import { skillTypes } from "@/db/schema";

export const SKILL_TYPE_SEED: ReadonlyArray<{
  id: string;
  componentShape: "form_direction" | "entry_level";
  displayName: string;
}> = [
  {
    id: "meaning_recognition",
    componentShape: "form_direction",
    displayName: "Meaning recognition",
  },
  {
    id: "meaning_recall",
    componentShape: "form_direction",
    displayName: "Meaning recall",
  },
  {
    id: "bab_identification",
    componentShape: "entry_level",
    displayName: "Bāb identification",
  },
  {
    id: "root_identification",
    componentShape: "entry_level",
    displayName: "Root identification",
  },
  {
    id: "verb_type_identification",
    componentShape: "entry_level",
    displayName: "Verb-type identification",
  },
];

export async function seedSkillTypes(db: Database): Promise<void> {
  // All 5 upserts commit as one unit — a crash mid-loop must never leave
  // some rows updated to the new seed values and others not.
  await db.transaction(async (tx) => {
    for (const row of SKILL_TYPE_SEED) {
      await tx
        .insert(skillTypes)
        .values({
          id: row.id,
          componentShape: row.componentShape,
          displayName: row.displayName,
          isActive: true,
        })
        .onConflictDoUpdate({
          target: skillTypes.id,
          set: {
            componentShape: row.componentShape,
            displayName: row.displayName,
          },
        });
    }
  });
}
