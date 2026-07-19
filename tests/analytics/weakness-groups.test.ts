/**
 * Weakness aggregation and ranking (Phase 13 §12-14, §25): bāb, verb-type,
 * source-form, direction, skill and state dimensions; minimum evidence and
 * deterministic ranking.
 */
import { describe, expect, it } from "vitest";

import type { LearnerEntry } from "@/modules/content/schema";
import {
  MIN_FIRST_ATTEMPTS_FOR_EVIDENCE,
  STRONG_SINGLE_COMPONENT_THRESHOLD,
  buildAllWeaknessGroups,
  buildWeaknessGroups,
  rankWeaknessGroups,
  topOverallWeaknessGroups,
  type WeaknessGroup,
} from "@/modules/analytics/weakness-groups";
import type { ComponentWeakness } from "@/modules/analytics/weakness";
import type {
  WeaknessAttemptEvidence,
  WeaknessComponentEvidence,
} from "@/modules/analytics/weakness-evidence";

const NOW = 1_784_000_000_000;
let counter = 0;

function entry(overrides: Partial<LearnerEntry> = {}): LearnerEntry {
  counter += 1;
  return {
    id: counter,
    madi: "x",
    mudari: "y",
    masdar: "z",
    meaning: "m",
    ism_fail: "f",
    amr: "a",
    nahi: "n",
    bab: "nasara",
    bab_arabic: "arabic-bab",
    verb_type: "sahih",
    verb_type_arabic: "arabic-verb-type",
    book_page: 1,
    root: "r",
    quiz_eligibility: {
      madi: true,
      mudari: true,
      masdar: true,
      meaning: true,
      ism_fail: true,
      amr: true,
      nahi: true,
      bab: true,
      verb_type: true,
      root: true,
    },
    ...overrides,
  };
}

function attemptEv(
  overrides: Partial<WeaknessAttemptEvidence> = {},
): WeaknessAttemptEvidence {
  counter += 1;
  return {
    attemptId: `attempt-${counter}`,
    componentKey: "entry:1:skill:bab_identification",
    entryId: 1,
    skillType: "bab_identification",
    direction: null,
    analysisForm: "madi",
    isCorrect: false,
    occurredAtMs: NOW,
    ...overrides,
  };
}

function componentEv(
  overrides: Partial<WeaknessComponentEvidence> = {},
): WeaknessComponentEvidence {
  return {
    componentKey: "entry:1:skill:bab_identification",
    entryId: 1,
    skillType: "bab_identification",
    direction: null,
    sourceField: null,
    effectiveState: "learning",
    fsrsLapses: 0,
    firstAttempts: [],
    ...overrides,
  };
}

function weakness(
  overrides: Partial<ComponentWeakness> = {},
): ComponentWeakness {
  return {
    score: 0.4,
    accuracySignal: 0.4,
    lapseSignal: 0,
    recentFailureSignal: 0,
    firstAttemptCount: 2,
    incorrectFirstAttemptCount: 2,
    firstAttemptAccuracy: 0,
    lapses: 0,
    lastAttemptAtMs: NOW,
    lastIncorrectAtMs: NOW,
    qualifiesAsWeak: true,
    consideredFirstAttempts: [],
    ...overrides,
  };
}

describe("buildWeaknessGroups — bāb (§25 bāb)", () => {
  it("errors in one bāb make that group surface; other bābs do not inherit the attempts", () => {
    const weakEntry = entry({ bab: "nasara" });
    const strongEntry = entry({ bab: "daraba" });
    const weakKey = `entry:${weakEntry.id}:skill:bab_identification`;
    const strongKey = `entry:${strongEntry.id}:skill:bab_identification`;

    const componentWeakness = new Map([
      [weakKey, weakness({ score: 0.6, qualifiesAsWeak: true })],
      [
        strongKey,
        weakness({
          score: 0,
          qualifiesAsWeak: false,
          firstAttemptCount: 1, // below the minimum-evidence attempt bar
          incorrectFirstAttemptCount: 0,
          firstAttemptAccuracy: 1,
        }),
      ],
    ]);
    const evidence = new Map([
      [weakKey, componentEv({ componentKey: weakKey, entryId: weakEntry.id })],
      [
        strongKey,
        componentEv({ componentKey: strongKey, entryId: strongEntry.id }),
      ],
    ]);

    const groups = rankWeaknessGroups(
      buildWeaknessGroups("bab", componentWeakness, evidence, [
        weakEntry,
        strongEntry,
      ]),
    );
    const nasara = groups.find((g) => g.value === "nasara");
    const daraba = groups.find((g) => g.value === "daraba");
    expect(nasara?.weakComponentCount).toBe(1);
    expect(nasara?.weaknessScore).toBeGreaterThan(0);
    // daraba has zero evidence-worthy score and shouldn't even meet the
    // minimum-evidence bar with only 2 all-correct attempts and no lapse.
    expect(daraba).toBeUndefined();
  });
});

describe("buildWeaknessGroups — verb type (§25 verb type)", () => {
  it("eligible classifications aggregate correctly and unresolved entries never appear", () => {
    const eligible = entry({ verb_type: "mudaaf" });
    const unresolved369 = entry({
      quiz_eligibility: {
        ...entry().quiz_eligibility,
        verb_type: false,
        root: false,
      },
    });
    const eligibleKey = `entry:${eligible.id}:skill:verb_type_identification`;
    const unresolvedKey = `entry:${unresolved369.id}:skill:verb_type_identification`;

    const componentWeakness = new Map([
      [eligibleKey, weakness()],
      [unresolvedKey, weakness()],
    ]);
    const evidence = new Map([
      [
        eligibleKey,
        componentEv({
          componentKey: eligibleKey,
          entryId: eligible.id,
          skillType: "verb_type_identification",
        }),
      ],
      [
        unresolvedKey,
        componentEv({
          componentKey: unresolvedKey,
          entryId: unresolved369.id,
          skillType: "verb_type_identification",
        }),
      ],
    ]);

    const groups = buildWeaknessGroups(
      "verb_type",
      componentWeakness,
      evidence,
      [eligible, unresolved369],
    );
    expect(groups.map((g) => g.value)).toEqual(["mudaaf"]);
    expect(groups.some((g) => g.value === "sahih")).toBe(false);
  });
});

describe("buildWeaknessGroups — source form (§25 form)", () => {
  it("a translation component attributes via sourceField (component-level, one form)", () => {
    const componentKey =
      "entry:1:skill:meaning_recognition:field:mudari:direction:arabic_to_english";
    const componentWeakness = new Map([
      [
        componentKey,
        weakness({
          lapses: 2,
          consideredFirstAttempts: [
            attemptEv({
              componentKey,
              analysisForm: "mudari",
              isCorrect: false,
            }),
            attemptEv({
              componentKey,
              analysisForm: "mudari",
              isCorrect: false,
            }),
          ],
        }),
      ],
    ]);
    const evidence = new Map([[componentKey, componentEv({ componentKey })]]);
    const groups = buildWeaknessGroups(
      "source_form",
      componentWeakness,
      evidence,
      [],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].value).toBe("mudari");
    expect(groups[0].firstAttemptCount).toBe(2);
    expect(groups[0].lapseCount).toBe(2); // single-form component: attributable
  });

  it("a bāb component attempted with māḍī and muḍāriʿ produces separate form evidence without duplicating history or lapses", () => {
    const componentKey = "entry:1:skill:bab_identification";
    const componentWeakness = new Map([
      [
        componentKey,
        weakness({
          lapses: 3,
          consideredFirstAttempts: [
            attemptEv({ componentKey, analysisForm: "madi", isCorrect: false }),
            attemptEv({
              componentKey,
              analysisForm: "mudari",
              isCorrect: true,
            }),
          ],
        }),
      ],
    ]);
    const evidence = new Map([[componentKey, componentEv({ componentKey })]]);
    const groups = buildWeaknessGroups(
      "source_form",
      componentWeakness,
      evidence,
      [],
    );
    const madi = groups.find((g) => g.value === "madi")!;
    const mudari = groups.find((g) => g.value === "mudari")!;
    expect(madi.firstAttemptCount).toBe(1);
    expect(mudari.firstAttemptCount).toBe(1);
    expect(madi.incorrectFirstAttemptCount).toBe(1);
    expect(mudari.incorrectFirstAttemptCount).toBe(0);
    // Multi-form component: lapses are not honestly attributable to either
    // single form, so neither bucket invents a lapse count.
    expect(madi.lapseCount).toBe(0);
    expect(mudari.lapseCount).toBe(0);
  });
  it("uses the SAME windowed evidence as every other dimension, never the unbounded lifetime history (ARCH-001 regression)", () => {
    // A component whose weakness.ts score is windowed to only 2 recent
    // attempts (simulating computeComponentWeakness's RECENT_FIRST_ATTEMPT_WINDOW
    // cap) must report the SAME attempt count in its source_form group as it
    // would in any whole-component dimension — never the component's full
    // unbounded history.
    const componentKey = "entry:1:skill:bab_identification";
    const windowed = [
      attemptEv({ componentKey, analysisForm: "madi", isCorrect: false }),
      attemptEv({ componentKey, analysisForm: "madi", isCorrect: true }),
    ];
    const cw = weakness({
      firstAttemptCount: windowed.length,
      consideredFirstAttempts: windowed,
    });
    const componentWeakness = new Map([[componentKey, cw]]);
    const evidence = new Map([[componentKey, componentEv({ componentKey })]]);

    const formGroups = buildWeaknessGroups(
      "source_form",
      componentWeakness,
      evidence,
      [],
    );
    const totalFormAttempts = formGroups.reduce(
      (sum, g) => sum + g.firstAttemptCount,
      0,
    );
    expect(totalFormAttempts).toBe(cw.firstAttemptCount);
  });
});

describe("buildWeaknessGroups — direction (§25 direction)", () => {
  it("recognition contributes only to arabic_to_english; recall only to english_to_arabic; entry-level attempts enter neither", () => {
    const recognitionKey =
      "entry:1:skill:meaning_recognition:field:madi:direction:arabic_to_english";
    const recallKey =
      "entry:1:skill:meaning_recall:field:madi:direction:english_to_arabic";
    const babKey = "entry:1:skill:bab_identification";

    const componentWeakness = new Map([
      [recognitionKey, weakness()],
      [recallKey, weakness()],
      [babKey, weakness()],
    ]);
    const evidence = new Map([
      [
        recognitionKey,
        componentEv({
          componentKey: recognitionKey,
          direction: "arabic_to_english",
        }),
      ],
      [
        recallKey,
        componentEv({
          componentKey: recallKey,
          direction: "english_to_arabic",
        }),
      ],
      [babKey, componentEv({ componentKey: babKey, direction: null })],
    ]);
    const groups = buildWeaknessGroups(
      "direction",
      componentWeakness,
      evidence,
      [],
    );
    expect(groups.map((g) => g.value).sort()).toEqual([
      "arabic_to_english",
      "english_to_arabic",
    ]);
  });
});

describe("buildWeaknessGroups — skill and state (§25)", () => {
  it("every current skill groups correctly", () => {
    const skills = [
      "meaning_recognition",
      "meaning_recall",
      "bab_identification",
      "root_identification",
      "verb_type_identification",
    ] as const;
    const componentWeakness = new Map(
      skills.map((s, i) => [`k${i}`, weakness()]),
    );
    const evidence = new Map(
      skills.map((s, i) => [
        `k${i}`,
        componentEv({ componentKey: `k${i}`, skillType: s }),
      ]),
    );
    const groups = buildWeaknessGroups(
      "skill",
      componentWeakness,
      evidence,
      [],
    );
    expect(groups.map((g) => g.value).sort()).toEqual([...skills].sort());
  });

  it("state groups use the effective current state; untouched not_started never surfaces (no evidence entry)", () => {
    const componentWeakness = new Map([["k1", weakness({ score: 0.6 })]]);
    const evidence = new Map([
      [
        "k1",
        componentEv({ componentKey: "k1", effectiveState: "needs_review" }),
      ],
    ]);
    const groups = buildWeaknessGroups(
      "state",
      componentWeakness,
      evidence,
      [],
    );
    expect(groups.map((g) => g.value)).toEqual(["needs_review"]);
  });
});

describe("ranking (§25 ranking)", () => {
  function group(overrides: Partial<WeaknessGroup>): WeaknessGroup {
    return {
      dimension: "skill",
      value: "meaning_recognition",
      weakComponentCount: 1,
      attemptedComponentCount: 1,
      firstAttemptCount: 5,
      incorrectFirstAttemptCount: 3,
      firstAttemptAccuracy: 0.4,
      lapseCount: 0,
      weaknessScore: 0.5,
      lastAttemptAtMs: NOW,
      lastIncorrectAtMs: NOW,
      ...overrides,
    };
  }

  it("sustained difficulty outranks one low-confidence failure", () => {
    const sustained = group({
      value: "a",
      weaknessScore: 0.6,
      weakComponentCount: 3,
    });
    const isolated = group({
      value: "b",
      weaknessScore: 0.3,
      weakComponentCount: 1,
    });
    const ranked = rankWeaknessGroups([isolated, sustained]);
    expect(ranked[0].value).toBe("a");
  });

  it("recent evidence affects ties", () => {
    const older = group({
      value: "a",
      weaknessScore: 0.5,
      weakComponentCount: 1,
      lastIncorrectAtMs: NOW - 100,
    });
    const recent = group({
      value: "b",
      weaknessScore: 0.5,
      weakComponentCount: 1,
      lastIncorrectAtMs: NOW,
    });
    const ranked = rankWeaknessGroups([older, recent]);
    expect(ranked[0].value).toBe("b");
  });

  it("strong evidence lowers a group score (reflected via the weaknessScore field itself)", () => {
    const strong = group({
      value: "a",
      weaknessScore: 0.1,
      weakComponentCount: 0,
      firstAttemptCount: 10,
      incorrectFirstAttemptCount: 0,
    });
    const weak = group({
      value: "b",
      weaknessScore: 0.7,
      weakComponentCount: 1,
    });
    const ranked = rankWeaknessGroups([strong, weak]);
    expect(ranked[0].value).toBe("b");
  });

  it("minimum evidence: fewer than 2 attempts and no lapse and a moderate score does not surface", () => {
    const belowBar = group({
      value: "a",
      firstAttemptCount: 1,
      lapseCount: 0,
      weaknessScore: STRONG_SINGLE_COMPONENT_THRESHOLD - 0.01,
    });
    expect(rankWeaknessGroups([belowBar])).toEqual([]);
  });

  it("minimum evidence: a single severe component still surfaces above the strong-single-component bar", () => {
    const severe = group({
      value: "a",
      firstAttemptCount: 1,
      lapseCount: 0,
      weaknessScore: STRONG_SINGLE_COMPONENT_THRESHOLD + 0.01,
    });
    expect(rankWeaknessGroups([severe])).toHaveLength(1);
  });

  it("minimum evidence: exactly the attempt threshold surfaces even with a low score", () => {
    const atThreshold = group({
      value: "a",
      firstAttemptCount: MIN_FIRST_ATTEMPTS_FOR_EVIDENCE,
      lapseCount: 0,
      weaknessScore: 0.01,
    });
    expect(rankWeaknessGroups([atThreshold])).toHaveLength(1);
  });

  it("minimum evidence: a genuine lapse alone is enough", () => {
    const lapseOnly = group({
      value: "a",
      firstAttemptCount: 0,
      lapseCount: 1,
      weaknessScore: 0.01,
    });
    expect(rankWeaknessGroups([lapseOnly])).toHaveLength(1);
  });

  it("ranking is deterministic and stable across input order", () => {
    const a = group({ value: "a", weaknessScore: 0.5 });
    const b = group({ value: "b", weaknessScore: 0.5 });
    const forward = rankWeaknessGroups([a, b]).map((g) => g.value);
    const reversed = rankWeaknessGroups([b, a]).map((g) => g.value);
    expect(reversed).toEqual(forward);
  });

  it("empty evidence returns an empty list", () => {
    expect(rankWeaknessGroups([])).toEqual([]);
  });
});

describe("buildAllWeaknessGroups / topOverallWeaknessGroups", () => {
  it("returns ranked groups for every dimension and a merged top-N overall", () => {
    const e = entry();
    const babKey = `entry:${e.id}:skill:bab_identification`;
    const componentWeakness = new Map([
      [babKey, weakness({ score: 0.8, qualifiesAsWeak: true })],
    ]);
    const evidence = new Map([
      [
        babKey,
        componentEv({
          componentKey: babKey,
          entryId: e.id,
          firstAttempts: [
            attemptEv({ componentKey: babKey, isCorrect: false }),
            attemptEv({ componentKey: babKey, isCorrect: false }),
          ],
        }),
      ],
    ]);
    const all = buildAllWeaknessGroups(componentWeakness, evidence, [e]);
    expect(all.bab.length).toBeGreaterThan(0);
    expect(all.skill.length).toBeGreaterThan(0);
    const top = topOverallWeaknessGroups(all, 5);
    expect(top.length).toBeGreaterThan(0);
    expect(top.length).toBeLessThanOrEqual(5);
  });
});
