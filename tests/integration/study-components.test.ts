import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { skillTypes, studyComponents } from "@/db/schema";
import { createTestUser } from "@/tests/integration/helpers/users";

/**
 * Database-constraint integration suite for `study_components`
 * (phases-15.md §53). Tests the actual committed migration against real
 * PostgreSQL — no ORM mocking. Every rejection case proves the DATABASE
 * itself rejects the row (the Drizzle schema's text columns carry no
 * literal-union type constraint, so nothing here is blocked at compile
 * time — only PostgreSQL's own CHECK/FK/unique constraints enforce these).
 */

const FORM_SKILL = "meaning_recognition"; // form_direction
const ENTRY_SKILL = "bab_identification"; // entry_level
const ROOT_SKILL = "root_identification"; // entry_level

type ComponentInsert = {
  userId: string;
  entryId?: number;
  skillTypeId: string;
  componentShape: string;
  sourceField?: string | null;
  direction?: string | null;
  reps?: number;
  lapses?: number;
  revision?: number;
};

function insertComponent(row: ComponentInsert) {
  const db = getDb();
  return db.insert(studyComponents).values({
    userId: row.userId,
    entryId: row.entryId ?? 1,
    skillTypeId: row.skillTypeId,
    componentShape: row.componentShape,
    sourceField: row.sourceField ?? null,
    direction: row.direction ?? null,
    reps: row.reps ?? 0,
    lapses: row.lapses ?? 0,
    revision: row.revision ?? 0,
  });
}

describe("study_components constraint integration", () => {
  describe("required rejections", () => {
    it("rejects a root (entry_level) skill stored as form_direction", async () => {
      const userId = await createTestUser();
      await expect(
        insertComponent({
          userId,
          skillTypeId: ROOT_SKILL,
          componentShape: "form_direction",
          sourceField: "madi",
          direction: "arabic_to_english",
        }),
      ).rejects.toThrow();
    });

    it("rejects meaning_recognition (form_direction) stored as entry_level", async () => {
      const userId = await createTestUser();
      await expect(
        insertComponent({
          userId,
          skillTypeId: FORM_SKILL,
          componentShape: "entry_level",
        }),
      ).rejects.toThrow();
    });

    it("rejects a form component with NULL source_field", async () => {
      const userId = await createTestUser();
      await expect(
        insertComponent({
          userId,
          skillTypeId: FORM_SKILL,
          componentShape: "form_direction",
          sourceField: null,
          direction: "arabic_to_english",
        }),
      ).rejects.toThrow();
    });

    it("rejects a form component with NULL direction", async () => {
      const userId = await createTestUser();
      await expect(
        insertComponent({
          userId,
          skillTypeId: FORM_SKILL,
          componentShape: "form_direction",
          sourceField: "madi",
          direction: null,
        }),
      ).rejects.toThrow();
    });

    it("rejects an entry-level component with non-NULL source_field", async () => {
      const userId = await createTestUser();
      await expect(
        insertComponent({
          userId,
          skillTypeId: ENTRY_SKILL,
          componentShape: "entry_level",
          sourceField: "madi",
        }),
      ).rejects.toThrow();
    });

    it("rejects an entry-level component with non-NULL direction", async () => {
      const userId = await createTestUser();
      await expect(
        insertComponent({
          userId,
          skillTypeId: ENTRY_SKILL,
          componentShape: "entry_level",
          direction: "arabic_to_english",
        }),
      ).rejects.toThrow();
    });

    it("rejects invalid source_field text", async () => {
      const userId = await createTestUser();
      await expect(
        insertComponent({
          userId,
          skillTypeId: FORM_SKILL,
          componentShape: "form_direction",
          sourceField: "not_a_real_field",
          direction: "arabic_to_english",
        }),
      ).rejects.toThrow();
    });

    it("rejects invalid direction text", async () => {
      const userId = await createTestUser();
      await expect(
        insertComponent({
          userId,
          skillTypeId: FORM_SKILL,
          componentShape: "form_direction",
          sourceField: "madi",
          direction: "sideways",
        }),
      ).rejects.toThrow();
    });

    it("rejects an unknown component shape", async () => {
      const userId = await createTestUser();
      await expect(
        insertComponent({
          userId,
          skillTypeId: FORM_SKILL,
          componentShape: "form_transformation",
          sourceField: "madi",
          direction: "arabic_to_english",
        }),
      ).rejects.toThrow();
    });

    it("rejects negative revision", async () => {
      const userId = await createTestUser();
      await expect(
        insertComponent({
          userId,
          skillTypeId: ENTRY_SKILL,
          componentShape: "entry_level",
          revision: -1,
        }),
      ).rejects.toThrow();
    });

    it("rejects negative reps", async () => {
      const userId = await createTestUser();
      await expect(
        insertComponent({
          userId,
          skillTypeId: ENTRY_SKILL,
          componentShape: "entry_level",
          reps: -1,
        }),
      ).rejects.toThrow();
    });

    it("rejects negative lapses", async () => {
      const userId = await createTestUser();
      await expect(
        insertComponent({
          userId,
          skillTypeId: ENTRY_SKILL,
          componentShape: "entry_level",
          lapses: -1,
        }),
      ).rejects.toThrow();
    });

    it("rejects a duplicate form component (same user/entry/skill/field/direction)", async () => {
      const userId = await createTestUser();
      const spec = {
        userId,
        skillTypeId: FORM_SKILL,
        componentShape: "form_direction",
        sourceField: "madi",
        direction: "arabic_to_english",
      };
      await insertComponent(spec);
      await expect(insertComponent(spec)).rejects.toThrow();
    });

    it("rejects a duplicate entry-level component (same user/entry/skill)", async () => {
      const userId = await createTestUser();
      const spec = {
        userId,
        skillTypeId: ENTRY_SKILL,
        componentShape: "entry_level",
      };
      await insertComponent(spec);
      await expect(insertComponent(spec)).rejects.toThrow();
    });
  });

  describe("required successes", () => {
    it("allows different source fields to coexist for the same user/entry/skill", async () => {
      const userId = await createTestUser();
      await expect(
        insertComponent({
          userId,
          skillTypeId: FORM_SKILL,
          componentShape: "form_direction",
          sourceField: "madi",
          direction: "arabic_to_english",
        }),
      ).resolves.toBeDefined();
      await expect(
        insertComponent({
          userId,
          skillTypeId: FORM_SKILL,
          componentShape: "form_direction",
          sourceField: "mudari",
          direction: "arabic_to_english",
        }),
      ).resolves.toBeDefined();
    });

    it("allows different directions to coexist for the same user/entry/skill/field", async () => {
      const userId = await createTestUser();
      await expect(
        insertComponent({
          userId,
          skillTypeId: FORM_SKILL,
          componentShape: "form_direction",
          sourceField: "madi",
          direction: "arabic_to_english",
        }),
      ).resolves.toBeDefined();
      await expect(
        insertComponent({
          userId,
          skillTypeId: FORM_SKILL,
          componentShape: "form_direction",
          sourceField: "madi",
          direction: "english_to_arabic",
        }),
      ).resolves.toBeDefined();
    });

    it("allows two different users to own the same natural component identity", async () => {
      const userA = await createTestUser();
      const userB = await createTestUser();
      const spec = (userId: string) => ({
        userId,
        skillTypeId: ENTRY_SKILL,
        componentShape: "entry_level",
      });
      await expect(insertComponent(spec(userA))).resolves.toBeDefined();
      await expect(insertComponent(spec(userB))).resolves.toBeDefined();
    });

    it("inserts a valid entry-level component", async () => {
      const userId = await createTestUser();
      const db = getDb();
      const [row] = await db
        .insert(studyComponents)
        .values({
          userId,
          entryId: 42,
          skillTypeId: ENTRY_SKILL,
          componentShape: "entry_level",
        })
        .returning();
      expect(row?.componentShape).toBe("entry_level");
      expect(row?.sourceField).toBeNull();
      expect(row?.direction).toBeNull();
    });

    it("inserts a valid form component", async () => {
      const userId = await createTestUser();
      const db = getDb();
      const [row] = await db
        .insert(studyComponents)
        .values({
          userId,
          entryId: 42,
          skillTypeId: FORM_SKILL,
          componentShape: "form_direction",
          sourceField: "masdar",
          direction: "english_to_arabic",
        })
        .returning();
      expect(row?.sourceField).toBe("masdar");
      expect(row?.direction).toBe("english_to_arabic");
    });
  });

  describe("future-shape protection", () => {
    it("rejects an unknown future component_shape in skill_types itself", async () => {
      const db = getDb();
      await expect(
        db.insert(skillTypes).values({
          id: "pronoun_conjugation",
          componentShape: "form_transformation",
          displayName: "Pronoun conjugation",
        }),
      ).rejects.toThrow();
    });
  });
});
