import { describe, expect, it } from "vitest";

import {
  SOURCE_QUIZ_FORM_FIELDS,
  UNRESOLVED_ROOT_ENTRY_IDS,
} from "@/modules/content/constants";
import {
  deriveAllComponents,
  isComponentEligible,
} from "@/modules/study-engine/components";
import { generateQuestion } from "@/modules/study-engine/generator";
import { resolveComponentIdentity } from "@/modules/study-engine/natural-key";
import {
  buildEntryQuizPlan,
  DEFAULT_BAB_QUIZ_CONFIG,
  DEFAULT_ROOT_QUIZ_CONFIG,
  eligibleEntryQuizComponents,
  eligiblePromptForms,
  type EntryQuizConfig,
} from "@/modules/study-session/entry-quizzes";

import {
  entriesById,
  entry,
  learnerEntries,
  questionContext,
} from "../study-engine/fixtures";

describe("eligibleEntryQuizComponents", () => {
  it("bāb config yields only eligible entry-level bāb components", () => {
    const components = eligibleEntryQuizComponents(
      learnerEntries,
      DEFAULT_BAB_QUIZ_CONFIG,
    );
    expect(components.length).toBeGreaterThan(0);
    for (const component of components) {
      expect(component.skillType).toBe("bab_identification");
      expect(component.componentShape).toBe("entry_level");
      expect(entry(component.entryId).quiz_eligibility.bab).toBe(true);
    }
  });

  it("root config yields only root-eligible entries — 369/372 never appear", () => {
    const components = eligibleEntryQuizComponents(
      learnerEntries,
      DEFAULT_ROOT_QUIZ_CONFIG,
    );
    expect(components.length).toBeGreaterThan(0);
    for (const component of components) {
      expect(component.skillType).toBe("root_identification");
      expect(entry(component.entryId).quiz_eligibility.root).toBe(true);
      expect(UNRESOLVED_ROOT_ENTRY_IDS).not.toContain(component.entryId);
    }
  });

  it("a specific prompt form keeps only entries where that form is eligible", () => {
    // Find a real form with at least one ineligible bāb-eligible entry so the
    // filtering path is demonstrably exercised (guards against vacuity).
    const formWithIneligible = SOURCE_QUIZ_FORM_FIELDS.find((form) =>
      learnerEntries.some(
        (candidate) =>
          candidate.quiz_eligibility.bab && !candidate.quiz_eligibility[form],
      ),
    );
    expect(formWithIneligible).toBeDefined();

    const config: EntryQuizConfig = {
      skill: "bab_identification",
      promptForm: formWithIneligible!,
    };
    const components = eligibleEntryQuizComponents(learnerEntries, config);
    expect(components.length).toBeGreaterThan(0);
    const included = new Set(components.map((component) => component.entryId));
    for (const candidate of learnerEntries) {
      if (!candidate.quiz_eligibility.bab) continue;
      expect(included.has(candidate.id)).toBe(
        candidate.quiz_eligibility[formWithIneligible!],
      );
    }
  });
});

describe("buildEntryQuizPlan — bāb", () => {
  it("defaults every item's prompt form to the māḍī", () => {
    const plan = buildEntryQuizPlan(
      learnerEntries,
      DEFAULT_BAB_QUIZ_CONFIG,
      "seed",
    );
    expect(plan.length).toBeGreaterThan(0);
    for (const item of plan) {
      expect(item.promptForm).toBe("madi");
      expect(resolveComponentIdentity(item.identity).skillType).toBe(
        "bab_identification",
      );
    }
  });

  it("honours a specific configured prompt form (muḍāriʿ / ism al-fāʿil)", () => {
    for (const promptForm of ["mudari", "ism_fail"] as const) {
      const plan = buildEntryQuizPlan(
        learnerEntries,
        { skill: "bab_identification", promptForm },
        "seed",
        50,
      );
      expect(plan.length).toBeGreaterThan(0);
      for (const item of plan) {
        expect(item.promptForm).toBe(promptForm);
        // The prompt form is always eligible for the planned entry.
        expect(entry(item.identity.entryId).quiz_eligibility[promptForm]).toBe(
          true,
        );
      }
    }
  });

  it("random prompt form picks an eligible form per item and varies", () => {
    const plan = buildEntryQuizPlan(
      learnerEntries,
      { skill: "bab_identification", promptForm: "random" },
      "seed-random",
      50,
    );
    expect(plan.length).toBe(50);
    const seen = new Set<string>();
    for (const item of plan) {
      const forms = eligiblePromptForms(entry(item.identity.entryId));
      expect(forms).toContain(item.promptForm);
      seen.add(item.promptForm);
    }
    // Across 50 seeded-random picks more than one form appears.
    expect(seen.size).toBeGreaterThan(1);
  });

  it("is deterministic in its seed", () => {
    const config: EntryQuizConfig = {
      skill: "bab_identification",
      promptForm: "random",
    };
    const a = buildEntryQuizPlan(learnerEntries, config, "seed-x");
    const b = buildEntryQuizPlan(learnerEntries, config, "seed-x");
    expect(a).toEqual(b);
    const c = buildEntryQuizPlan(learnerEntries, config, "seed-y");
    expect(a).not.toEqual(c);
  });

  it("caps at the requested count and rejects a non-positive count", () => {
    const plan = buildEntryQuizPlan(
      learnerEntries,
      DEFAULT_BAB_QUIZ_CONFIG,
      "seed",
      5,
    );
    expect(plan).toHaveLength(5);
    expect(() =>
      buildEntryQuizPlan(learnerEntries, DEFAULT_BAB_QUIZ_CONFIG, "seed", 0),
    ).toThrow();
  });

  it("every planned identity passes the authoritative eligibility gate", () => {
    const plan = buildEntryQuizPlan(
      learnerEntries,
      DEFAULT_BAB_QUIZ_CONFIG,
      "seed",
      50,
    );
    for (const item of plan) {
      const source = entriesById.get(item.identity.entryId)!;
      expect(isComponentEligible(source, item.identity)).toBe(true);
    }
  });
});

describe("buildEntryQuizPlan — root (369/372 exclusion, full material)", () => {
  it("never plans 369/372 and never shows them among any question's options", () => {
    // The ENTIRE eligible root pool, prompted and generated for real: neither
    // unresolved entry may appear as a target OR as a distractor option.
    const eligible = eligibleEntryQuizComponents(
      learnerEntries,
      DEFAULT_ROOT_QUIZ_CONFIG,
    );
    const plan = buildEntryQuizPlan(
      learnerEntries,
      DEFAULT_ROOT_QUIZ_CONFIG,
      "seed",
      eligible.length,
    );
    expect(plan).toHaveLength(eligible.length);
    for (const [position, item] of plan.entries()) {
      expect(UNRESOLVED_ROOT_ENTRY_IDS).not.toContain(item.identity.entryId);
      const question = generateQuestion(questionContext, {
        identity: item.identity,
        deliveryMode: "mc",
        questionSeed: "seed",
        position,
        promptForm: item.promptForm,
      });
      expect(question.answerField).toBe("root");
      for (const option of question.options) {
        expect(option.ref.field).toBe("root");
        expect(UNRESOLVED_ROOT_ENTRY_IDS).not.toContain(option.ref.entryId);
      }
    }
  }, 60000);

  it("369/372 derive no root or verb-type components at all", () => {
    const derived = deriveAllComponents(learnerEntries);
    for (const unresolvedId of UNRESOLVED_ROOT_ENTRY_IDS) {
      const skills = derived
        .filter((component) => component.entryId === unresolvedId)
        .map((component) => component.skillType);
      expect(skills).not.toContain("root_identification");
      expect(skills).not.toContain("verb_type_identification");
      // The bāb component still exists — only root/verb-type are unverified.
      expect(skills).toContain("bab_identification");
    }
  });
});
