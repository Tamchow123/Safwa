import { describe, expect, it } from "vitest";

import { deriveComponentsForEntry } from "@/modules/study-engine/components";
import { defaultEntryPromptForm } from "@/modules/study-session/mixed";
import {
  chainForEntry,
  chainStatus,
  type ChainComponentState,
} from "@/modules/study-session/skill-chain";

import { entry, learnerEntries } from "../study-engine/fixtures";

/** "skill/field" labels, for readable order assertions. */
function labels(
  components: { skillType: string; sourceField: string | null }[],
) {
  return components.map((c) =>
    c.sourceField ? `${c.skillType}/${c.sourceField}` : c.skillType,
  );
}

function withEligibility(
  id: number,
  overrides: Partial<ReturnType<typeof entry>["quiz_eligibility"]>,
) {
  const base = entry(id);
  return {
    ...base,
    quiz_eligibility: { ...base.quiz_eligibility, ...overrides },
  };
}

describe("chainForEntry", () => {
  it("is the owner's order over the essential skills", () => {
    const chain = chainForEntry(deriveComponentsForEntry(entry(1)));
    expect(labels(chain)).toEqual([
      "meaning_recognition/madi",
      "meaning_recall/madi",
      "bab_identification",
      "meaning_recognition/mudari",
      "meaning_recognition/masdar",
      "root_identification",
    ]);
    expect(chain[1].direction).toBe("english_to_arabic");
    expect(chain[0].direction).toBe("arabic_to_english");
  });

  it("holds only essential skills — extended ones stay in the focused modes", () => {
    for (const source of learnerEntries) {
      for (const component of chainForEntry(deriveComponentsForEntry(source))) {
        expect(component.essential).toBe(true);
      }
    }
  });

  it("skips an ineligible skill rather than teaching it (hard rule 2)", () => {
    const chain = chainForEntry(
      deriveComponentsForEntry(
        withEligibility(1, { masdar: false, root: false }),
      ),
    );
    expect(labels(chain)).toEqual([
      "meaning_recognition/madi",
      "meaning_recall/madi",
      "bab_identification",
      "meaning_recognition/mudari",
    ]);
  });

  it("entries 369 and 372 have no root step", () => {
    for (const id of [369, 372]) {
      const chain = chainForEntry(deriveComponentsForEntry(entry(id)));
      expect(labels(chain)).not.toContain("root_identification");
      expect(chain[0].skillType).toBe("meaning_recognition");
    }
  });

  it("always opens with recognition: without the māḍī, the first recognition moves up", () => {
    const chain = chainForEntry(
      deriveComponentsForEntry(withEligibility(1, { madi: false })),
    );
    expect(labels(chain)).toEqual([
      "meaning_recognition/mudari",
      "bab_identification",
      "meaning_recognition/masdar",
      "root_identification",
    ]);
  });

  it("every chain skill can be asked: an entry with a chain always has a prompt form for its bāb and root", () => {
    // The planner and the entry page use the chain unfiltered; this is what
    // makes that safe. Every release entry, plus each way of losing forms.
    const variants = learnerEntries.flatMap((source) => [
      source,
      ...(["madi", "mudari", "masdar"] as const).map((form) => ({
        ...source,
        quiz_eligibility: { ...source.quiz_eligibility, [form]: false },
      })),
      {
        ...source,
        quiz_eligibility: {
          ...source.quiz_eligibility,
          madi: false,
          mudari: false,
          amr: false,
          nahi: false,
          ism_fail: false,
        },
      },
    ]);
    let chainsWithEntryLevelSkills = 0;
    for (const variant of variants) {
      const chain = chainForEntry(deriveComponentsForEntry(variant));
      if (chain.length === 0) continue;
      expect(defaultEntryPromptForm(variant)).not.toBeNull();
      if (chain.some((c) => c.componentShape === "entry_level")) {
        chainsWithEntryLevelSkills += 1;
      }
    }
    // Not vacuous: the bāb and root steps are in nearly every chain.
    expect(chainsWithEntryLevelSkills).toBeGreaterThan(learnerEntries.length);
  });

  it("an entry with no essential recognition has no chain (never opens with ṣarf)", () => {
    const chain = chainForEntry(
      deriveComponentsForEntry(
        withEligibility(1, { madi: false, mudari: false, masdar: false }),
      ),
    );
    expect(chain).toEqual([]);
  });
});

describe("chainStatus", () => {
  const chain = chainForEntry(deriveComponentsForEntry(entry(1)));
  const [madiRec, madiRecall, bab, mudariRec] = chain;

  function statuses(states: Record<string, ChainComponentState>) {
    return chainStatus(chain, (key) => states[key]).map((s) => s.status);
  }

  it("a brand-new word: the first skill is next, the rest locked", () => {
    expect(statuses({})).toEqual([
      "next",
      "locked",
      "locked",
      "locked",
      "locked",
      "locked",
    ]);
  });

  it("a started skill that has not qualified keeps the next one locked", () => {
    expect(
      statuses({
        [madiRec.key]: { started: true, qualifiesForNextSkill: false },
      }).slice(0, 3),
    ).toEqual(["started", "locked", "locked"]);
  });

  it("a qualifying skill unlocks exactly the one after it", () => {
    expect(
      statuses({
        [madiRec.key]: { started: true, qualifiesForNextSkill: true },
      }).slice(0, 3),
    ).toEqual(["started", "next", "locked"]);
  });

  it("a skill started elsewhere counts as started; the chain moves past it", () => {
    // The bāb was practised in the Bāb quiz before its turn came.
    expect(
      statuses({
        [madiRec.key]: { started: true, qualifiesForNextSkill: true },
        [madiRecall.key]: { started: true, qualifiesForNextSkill: true },
        [bab.key]: { started: true, qualifiesForNextSkill: true },
      }).slice(0, 5),
    ).toEqual(["started", "started", "started", "next", "locked"]);
    // …and a skill whose predecessor was never started stays locked even when
    // a later skill was started out of turn.
    expect(
      statuses({
        [madiRec.key]: { started: true, qualifiesForNextSkill: false },
        [bab.key]: { started: true, qualifiesForNextSkill: true },
      }).slice(0, 4),
    ).toEqual(["started", "locked", "started", "next"]);
  });

  it("offers only the earliest unlocked skill, even with one started out of turn", () => {
    // Two skills qualify (the māḍī recognition, and the muḍāriʿ recognition
    // practised early in another mode); only the earlier gap is next.
    const result = statuses({
      [madiRec.key]: { started: true, qualifiesForNextSkill: true },
      [mudariRec.key]: { started: true, qualifiesForNextSkill: true },
    });
    expect(result).toEqual([
      "started",
      "next",
      "locked",
      "started",
      "locked",
      "locked",
    ]);
    expect(result.filter((s) => s === "next")).toHaveLength(1);
  });
});
