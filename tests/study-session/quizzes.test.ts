import { describe, expect, it } from "vitest";

import { isComponentEligible } from "@/modules/study-engine/components";
import { resolveComponentIdentity } from "@/modules/study-engine/natural-key";
import {
  buildQuizPlan,
  DEFAULT_MC_QUIZ_CONFIG,
  DEFAULT_QUIZ_COUNT,
  eligibleQuizComponents,
  type McQuizConfig,
} from "@/modules/study-session/quizzes";

import { entriesById, entry, learnerEntries } from "../study-engine/fixtures";

describe("eligibleQuizComponents", () => {
  it("returns only translation (form_direction) components", () => {
    const components = eligibleQuizComponents(
      learnerEntries,
      DEFAULT_MC_QUIZ_CONFIG,
    );
    expect(components.length).toBeGreaterThan(0);
    for (const component of components) {
      expect(component.componentShape).toBe("form_direction");
      expect(component.direction).not.toBeNull();
      expect(component.sourceField).not.toBeNull();
    }
  });

  it("never yields an ineligible field or component (hard rule 2)", () => {
    // Include both directions so recognition AND recall are exercised.
    const components = eligibleQuizComponents(learnerEntries, {
      direction: "random",
      field: "random",
      delivery: "immediate",
    });
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

  it("Arabic→English selects the recognition skill", () => {
    const arEn = eligibleQuizComponents(learnerEntries, {
      direction: "arabic_to_english",
      field: "random",
      delivery: "immediate",
    });
    expect(arEn.length).toBeGreaterThan(0);
    for (const component of arEn) {
      expect(component.direction).toBe("arabic_to_english");
      expect(component.skillType).toBe("meaning_recognition");
    }
  });

  it("English→Arabic selects the recall skill", () => {
    const enAr = eligibleQuizComponents(learnerEntries, {
      direction: "english_to_arabic",
      field: "random",
      delivery: "immediate",
    });
    expect(enAr.length).toBeGreaterThan(0);
    for (const component of enAr) {
      expect(component.direction).toBe("english_to_arabic");
      expect(component.skillType).toBe("meaning_recall");
    }
  });

  it("filters to a specific field", () => {
    const masdarOnly = eligibleQuizComponents(learnerEntries, {
      direction: "random",
      field: "masdar",
      delivery: "immediate",
    });
    expect(masdarOnly.length).toBeGreaterThan(0);
    for (const component of masdarOnly) {
      expect(component.sourceField).toBe("masdar");
    }
  });

  it("random direction includes both recognition and recall", () => {
    const components = eligibleQuizComponents(learnerEntries, {
      direction: "random",
      field: "madi",
      delivery: "immediate",
    });
    const directions = new Set(components.map((c) => c.direction));
    expect(directions).toContain("arabic_to_english");
    expect(directions).toContain("english_to_arabic");
  });

  it("the delivery choice does not change which components are eligible", () => {
    const immediate = eligibleQuizComponents(learnerEntries, {
      direction: "arabic_to_english",
      field: "random",
      delivery: "immediate",
    });
    const timed = eligibleQuizComponents(learnerEntries, {
      direction: "arabic_to_english",
      field: "random",
      delivery: "timed",
    });
    const test = eligibleQuizComponents(learnerEntries, {
      direction: "arabic_to_english",
      field: "random",
      delivery: "test",
    });
    expect(timed).toEqual(immediate);
    expect(test).toEqual(immediate);
  });
});

describe("buildQuizPlan", () => {
  it("is deterministic in its seed", () => {
    const a = buildQuizPlan(learnerEntries, DEFAULT_MC_QUIZ_CONFIG, "seed-x");
    const b = buildQuizPlan(learnerEntries, DEFAULT_MC_QUIZ_CONFIG, "seed-x");
    expect(a).toEqual(b);
  });

  it("different seeds produce different orderings", () => {
    const a = buildQuizPlan(learnerEntries, DEFAULT_MC_QUIZ_CONFIG, "seed-a");
    const b = buildQuizPlan(learnerEntries, DEFAULT_MC_QUIZ_CONFIG, "seed-b");
    // Overwhelmingly likely to differ across hundreds of components.
    expect(a).not.toEqual(b);
  });

  it("caps at the requested count (default 20)", () => {
    const plan = buildQuizPlan(learnerEntries, DEFAULT_MC_QUIZ_CONFIG, "seed");
    expect(plan).toHaveLength(DEFAULT_QUIZ_COUNT);

    const five = buildQuizPlan(
      learnerEntries,
      DEFAULT_MC_QUIZ_CONFIG,
      "seed",
      5,
    );
    expect(five).toHaveLength(5);
  });

  it("every planned identity resolves to an eligible form_direction component", () => {
    const plan = buildQuizPlan(
      learnerEntries,
      { direction: "random", field: "random", delivery: "immediate" },
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

  it("returns fewer than count when the eligible pool is small", () => {
    const narrow: McQuizConfig = {
      direction: "english_to_arabic",
      field: "amr",
      delivery: "immediate",
    };
    const eligible = eligibleQuizComponents(learnerEntries, narrow);
    const plan = buildQuizPlan(learnerEntries, narrow, "seed", 1000);
    expect(plan).toHaveLength(eligible.length);
  });

  it("rejects a non-positive count", () => {
    expect(() =>
      buildQuizPlan(learnerEntries, DEFAULT_MC_QUIZ_CONFIG, "s", 0),
    ).toThrow();
  });
});
