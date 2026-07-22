import { describe, expect, it } from "vitest";
import { SKILL_TYPE_SEED } from "@/db/seed";

describe("SKILL_TYPE_SEED", () => {
  it("contains exactly the 5 current skill types with the correct shapes", () => {
    expect(SKILL_TYPE_SEED).toHaveLength(5);
    const byId = new Map(SKILL_TYPE_SEED.map((row) => [row.id, row]));
    expect(byId.get("meaning_recognition")?.componentShape).toBe(
      "form_direction",
    );
    expect(byId.get("meaning_recall")?.componentShape).toBe("form_direction");
    expect(byId.get("bab_identification")?.componentShape).toBe("entry_level");
    expect(byId.get("root_identification")?.componentShape).toBe("entry_level");
    expect(byId.get("verb_type_identification")?.componentShape).toBe(
      "entry_level",
    );
  });

  it("every row has a non-empty display name", () => {
    for (const row of SKILL_TYPE_SEED) {
      expect(row.displayName.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate ids", () => {
    const ids = SKILL_TYPE_SEED.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
