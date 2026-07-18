import { describe, expect, it } from "vitest";

import {
  SKILL_METADATA,
  SOURCE_QUIZ_FORM_FIELDS,
  UNRESOLVED_ROOT_ENTRY_IDS,
} from "@/modules/content/constants";
import {
  deriveAllComponents,
  deriveComponentsForEntry,
  essentialComponentsForEntry,
  IneligibleComponentError,
  isComponentEligible,
  materialiseComponent,
} from "@/modules/study-engine/components";
import { buildComponentKey } from "@/modules/study-engine/natural-key";

import { entry, learnerEntries } from "./fixtures";

describe("component derivation", () => {
  it("derives distinct recognition components per source form", () => {
    const components = deriveComponentsForEntry(entry(1));
    const madiRec = components.find(
      (c) => c.skillType === "meaning_recognition" && c.sourceField === "madi",
    );
    const masdarRec = components.find(
      (c) =>
        c.skillType === "meaning_recognition" && c.sourceField === "masdar",
    );
    expect(madiRec).toBeDefined();
    expect(masdarRec).toBeDefined();
    // māḍī recognition and maṣdar recognition are DISTINCT components.
    expect(madiRec!.key).not.toBe(masdarRec!.key);
  });

  it("Ar→En and En→Ar of the same field are distinct components", () => {
    const components = deriveComponentsForEntry(entry(1));
    const recognition = components.find(
      (c) => c.skillType === "meaning_recognition" && c.sourceField === "madi",
    );
    const recall = components.find(
      (c) => c.skillType === "meaning_recall" && c.sourceField === "madi",
    );
    expect(recognition!.direction).toBe("arabic_to_english");
    expect(recall!.direction).toBe("english_to_arabic");
    expect(recognition!.key).not.toBe(recall!.key);
  });

  it("bab is a single entry-level component (no direction/field)", () => {
    const bab = deriveComponentsForEntry(entry(1)).filter(
      (c) => c.skillType === "bab_identification",
    );
    expect(bab).toHaveLength(1);
    expect(bab[0].componentShape).toBe("entry_level");
    expect(bab[0].sourceField).toBeNull();
    expect(bab[0].direction).toBeNull();
  });

  it("marks the essential set per PRODUCT_REQUIREMENTS §5", () => {
    const essential = essentialComponentsForEntry(entry(1));
    const labels = essential.map((c) => [c.skillType, c.sourceField].join(":"));
    // recognition of madi/mudari/masdar (eligible), recall of madi, bab, root.
    expect(labels).toContain("meaning_recognition:madi");
    expect(labels).toContain("meaning_recognition:mudari");
    expect(labels).toContain("meaning_recognition:masdar");
    expect(labels).toContain("meaning_recall:madi");
    expect(labels).toContain("bab_identification:");
    expect(labels).toContain("root_identification:");
    // ism_fail recognition and verb_type are extended, never essential.
    expect(labels).not.toContain("meaning_recognition:ism_fail");
    expect(labels).not.toContain("verb_type_identification:");
  });

  it("verb-type identification is derived but extended (never essential)", () => {
    const verbType = deriveComponentsForEntry(entry(1)).find(
      (c) => c.skillType === "verb_type_identification",
    );
    expect(verbType).toBeDefined();
    expect(verbType!.essential).toBe(false);
  });

  it("never derives an ineligible component (property over all entries)", () => {
    for (const e of learnerEntries) {
      for (const component of deriveComponentsForEntry(e)) {
        switch (component.skillType) {
          case "meaning_recognition":
          case "meaning_recall":
            expect(
              e.quiz_eligibility[component.sourceField!] &&
                e.quiz_eligibility.meaning,
              `entry ${e.id} ${component.key}`,
            ).toBe(true);
            break;
          case "bab_identification":
            expect(e.quiz_eligibility.bab).toBe(true);
            break;
          case "root_identification":
            expect(e.quiz_eligibility.root).toBe(true);
            break;
          case "verb_type_identification":
            expect(e.quiz_eligibility.verb_type).toBe(true);
            break;
        }
      }
    }
  });

  it("entries 369/372 yield no root or verb-type component", () => {
    for (const id of UNRESOLVED_ROOT_ENTRY_IDS) {
      const skills = deriveComponentsForEntry(entry(id)).map(
        (c) => c.skillType,
      );
      expect(skills).not.toContain("root_identification");
      expect(skills).not.toContain("verb_type_identification");
    }
  });

  it("derives components for all 455 entries with unique keys", () => {
    const all = deriveAllComponents(learnerEntries);
    const keys = new Set(all.map((c) => c.key));
    expect(keys.size).toBe(all.length);
    expect(all.length).toBeGreaterThan(455); // many components per entry
  });
});

describe("lazy materialisation", () => {
  it("materialises an eligible component", () => {
    const identity = {
      entryId: 1,
      skillType: "meaning_recognition" as const,
      sourceField: "madi" as const,
      direction: "arabic_to_english" as const,
    };
    const materialised = materialiseComponent(entry(1), identity);
    expect(materialised.key).toBe(buildComponentKey(identity));
    expect(materialised.entryId).toBe(1);
  });

  it("refuses to materialise an ineligible component (369 root)", () => {
    expect(
      isComponentEligible(entry(369), {
        entryId: 369,
        skillType: "root_identification",
      }),
    ).toBe(false);
    expect(() =>
      materialiseComponent(entry(369), {
        entryId: 369,
        skillType: "root_identification",
      }),
    ).toThrow(IneligibleComponentError);
  });

  it("isComponentEligible rejects a mismatched entry id", () => {
    expect(
      isComponentEligible(entry(1), {
        entryId: 2,
        skillType: "bab_identification",
      }),
    ).toBe(false);
  });

  it("every entry-level skill in metadata is covered by derivation", () => {
    const entryLevelSkills = SKILL_METADATA.filter(
      (m) => m.component_shape === "entry_level",
    ).map((m) => m.id);
    const derivedSkills = new Set(
      deriveComponentsForEntry(entry(1)).map((c) => c.skillType),
    );
    for (const skill of entryLevelSkills) {
      expect(derivedSkills.has(skill)).toBe(true);
    }
    // Sanity: the form fields we rely on are the six documented ones.
    expect(SOURCE_QUIZ_FORM_FIELDS).toHaveLength(6);
  });
});
