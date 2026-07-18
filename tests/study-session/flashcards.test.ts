import { describe, expect, it } from "vitest";

import { isComponentEligible } from "@/modules/study-engine/components";
import { resolveComponentIdentity } from "@/modules/study-engine/natural-key";
import {
  buildFlashcardPlan,
  DEFAULT_FLASHCARD_CONFIG,
  DEFAULT_FLASHCARD_COUNT,
  eligibleFlashcardComponents,
  type FlashcardConfig,
} from "@/modules/study-session/flashcards";

import { entriesById, entry, learnerEntries } from "../study-engine/fixtures";

describe("eligibleFlashcardComponents", () => {
  it("returns only translation (form_direction) components", () => {
    const components = eligibleFlashcardComponents(
      learnerEntries,
      DEFAULT_FLASHCARD_CONFIG,
    );
    expect(components.length).toBeGreaterThan(0);
    for (const component of components) {
      expect(component.componentShape).toBe("form_direction");
      expect(component.direction).not.toBeNull();
      expect(component.sourceField).not.toBeNull();
    }
  });

  it("never yields an ineligible field or component (hard rule 2)", () => {
    const components = eligibleFlashcardComponents(
      learnerEntries,
      DEFAULT_FLASHCARD_CONFIG,
    );
    for (const component of components) {
      const source = entry(component.entryId);
      // The field it teaches AND the meaning must both be eligible.
      expect(source.quiz_eligibility[component.sourceField!]).toBe(true);
      expect(source.quiz_eligibility.meaning).toBe(true);
      // And the resolved identity must pass the authoritative eligibility gate.
      expect(
        isComponentEligible(source, {
          entryId: component.entryId,
          skillType: component.skillType,
          sourceField: component.sourceField,
          direction: component.direction,
        }),
      ).toBe(true);
    }
  });

  it("filters to a specific direction", () => {
    const arEn = eligibleFlashcardComponents(learnerEntries, {
      direction: "arabic_to_english",
      field: "random",
    });
    expect(arEn.length).toBeGreaterThan(0);
    for (const component of arEn) {
      expect(component.direction).toBe("arabic_to_english");
      expect(component.skillType).toBe("meaning_recognition");
    }

    const enAr = eligibleFlashcardComponents(learnerEntries, {
      direction: "english_to_arabic",
      field: "random",
    });
    for (const component of enAr) {
      expect(component.direction).toBe("english_to_arabic");
      expect(component.skillType).toBe("meaning_recall");
    }
  });

  it("filters to a specific field", () => {
    const masdarOnly = eligibleFlashcardComponents(learnerEntries, {
      direction: "random",
      field: "masdar",
    });
    expect(masdarOnly.length).toBeGreaterThan(0);
    for (const component of masdarOnly) {
      expect(component.sourceField).toBe("masdar");
    }
  });

  it("random direction includes both recognition and recall", () => {
    const components = eligibleFlashcardComponents(learnerEntries, {
      direction: "random",
      field: "madi",
    });
    const directions = new Set(components.map((c) => c.direction));
    expect(directions).toContain("arabic_to_english");
    expect(directions).toContain("english_to_arabic");
  });
});

describe("buildFlashcardPlan", () => {
  it("is deterministic in its seed", () => {
    const a = buildFlashcardPlan(
      learnerEntries,
      DEFAULT_FLASHCARD_CONFIG,
      "seed-x",
    );
    const b = buildFlashcardPlan(
      learnerEntries,
      DEFAULT_FLASHCARD_CONFIG,
      "seed-x",
    );
    expect(a).toEqual(b);
  });

  it("different seeds produce different orderings", () => {
    const a = buildFlashcardPlan(
      learnerEntries,
      DEFAULT_FLASHCARD_CONFIG,
      "seed-a",
    );
    const b = buildFlashcardPlan(
      learnerEntries,
      DEFAULT_FLASHCARD_CONFIG,
      "seed-b",
    );
    // Overwhelmingly likely to differ across hundreds of components.
    expect(a).not.toEqual(b);
  });

  it("caps at the requested count (default 20)", () => {
    const plan = buildFlashcardPlan(
      learnerEntries,
      DEFAULT_FLASHCARD_CONFIG,
      "seed",
    );
    expect(plan).toHaveLength(DEFAULT_FLASHCARD_COUNT);

    const five = buildFlashcardPlan(
      learnerEntries,
      DEFAULT_FLASHCARD_CONFIG,
      "seed",
      5,
    );
    expect(five).toHaveLength(5);
  });

  it("every planned identity resolves to an eligible form_direction component", () => {
    const plan = buildFlashcardPlan(
      learnerEntries,
      DEFAULT_FLASHCARD_CONFIG,
      "seed",
      50,
    );
    for (const item of plan) {
      const resolved = resolveComponentIdentity(item.identity);
      expect(resolved.componentShape).toBe("form_direction");
      const source = entriesById.get(item.identity.entryId)!;
      expect(isComponentEligible(source, item.identity)).toBe(true);
    }
  });

  it("returns fewer than count when eligible pool is small", () => {
    // hasiba bāb has only 6 entries; a very narrow filter still stays within
    // the eligible pool and never invents components.
    const narrow: FlashcardConfig = {
      direction: "english_to_arabic",
      field: "amr",
    };
    const eligible = eligibleFlashcardComponents(learnerEntries, narrow);
    const plan = buildFlashcardPlan(learnerEntries, narrow, "seed", 1000);
    expect(plan).toHaveLength(eligible.length);
  });

  it("rejects a non-positive count", () => {
    expect(() =>
      buildFlashcardPlan(learnerEntries, DEFAULT_FLASHCARD_CONFIG, "s", 0),
    ).toThrow();
  });
});
