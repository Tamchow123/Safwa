/**
 * Denominator tests against the REAL generated release (Phase 12 §21.1).
 * These counts pin the current immutable release (455 entries); they are
 * asserted here — never hardcoded into production formulas, which derive
 * everything at runtime from `deriveAllComponents`.
 */
import { describe, expect, it } from "vitest";

import {
  computeProgressSummary,
  effectiveComponents,
} from "@/modules/analytics/progress";
import {
  deriveAllComponents,
  deriveComponentsForEntry,
} from "@/modules/study-engine/components";

import { entry, learnerEntries } from "../study-engine/fixtures";

const NOW = Date.UTC(2026, 6, 17, 12, 0, 0);

const allComponents = deriveAllComponents(learnerEntries);

describe("eligible component universe (§7.1)", () => {
  it("derives 455 entries, 6,793 eligible and 2,717 essential components", () => {
    expect(learnerEntries).toHaveLength(455);
    expect(allComponents).toHaveLength(6793);
    expect(allComponents.filter((c) => c.essential)).toHaveLength(2717);
  });

  it("derives the expected per-skill denominators", () => {
    const bySkill = new Map<string, number>();
    for (const component of allComponents) {
      bySkill.set(
        component.skillType,
        (bySkill.get(component.skillType) ?? 0) + 1,
      );
    }
    expect(bySkill.get("meaning_recognition")).toBe(2716);
    expect(bySkill.get("meaning_recall")).toBe(2716);
    expect(bySkill.get("bab_identification")).toBe(455);
    expect(bySkill.get("root_identification")).toBe(453);
    expect(bySkill.get("verb_type_identification")).toBe(453);
  });

  it("derives the expected per-form denominators (both directions)", () => {
    const byForm = new Map<string, number>();
    for (const component of allComponents) {
      if (component.sourceField === null) continue;
      byForm.set(
        component.sourceField,
        (byForm.get(component.sourceField) ?? 0) + 1,
      );
    }
    expect(byForm.get("madi")).toBe(910);
    expect(byForm.get("mudari")).toBe(908);
    expect(byForm.get("masdar")).toBe(890);
    expect(byForm.get("ism_fail")).toBe(908);
    expect(byForm.get("amr")).toBe(908);
    expect(byForm.get("nahi")).toBe(908);
  });

  it("entries 369 and 372 stay out of root and verb-type denominators", () => {
    for (const id of [369, 372]) {
      const components = deriveComponentsForEntry(entry(id));
      expect(
        components.some((c) => c.skillType === "root_identification"),
      ).toBe(false);
      expect(
        components.some((c) => c.skillType === "verb_type_identification"),
      ).toBe(false);
      // Their essential set still exists (recognition/recall/bāb).
      expect(components.some((c) => c.essential)).toBe(true);
    }
  });
});

describe("summary denominators over an empty learner state", () => {
  it("a brand-new guest sees exact zero numerators over full denominators", () => {
    const summary = computeProgressSummary(
      effectiveComponents(allComponents, [], NOW),
      learnerEntries.length,
    );
    expect(summary.overallCompletion).toEqual({
      numerator: 0,
      denominator: 455,
    });
    expect(summary.componentMastery).toEqual({
      numerator: 0,
      denominator: 6793,
    });
    expect(summary.perSkill.meaning_recognition.denominator).toBe(2716);
    expect(summary.perSkill.meaning_recall.denominator).toBe(2716);
    expect(summary.perSkill.bab_identification.denominator).toBe(455);
    expect(summary.perSkill.root_identification.denominator).toBe(453);
    expect(summary.perSkill.verb_type_identification.denominator).toBe(453);
    expect(summary.perForm.madi.denominator).toBe(910);
    expect(summary.perForm.mudari.denominator).toBe(908);
    expect(summary.perForm.masdar.denominator).toBe(890);
    expect(summary.perForm.ism_fail.denominator).toBe(908);
    expect(summary.perForm.amr.denominator).toBe(908);
    expect(summary.perForm.nahi.denominator).toBe(908);
    expect(summary.wordStates).toEqual({
      wordsNotStarted: 455,
      wordsLearning: 0,
      wordsMastered: 0,
      wordsStarted: 0,
    });
  });
});
