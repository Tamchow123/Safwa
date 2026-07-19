/**
 * Exact weak-set drill planning and request validation (Phase 13 §17-18,
 * §26).
 */
import { describe, expect, it } from "vitest";

import type { SourceQuizFormField } from "@/modules/content/constants";
import type { LearnerEntry } from "@/modules/content/schema";
import {
  computeComponentWeakness,
  type ComponentWeakness,
} from "@/modules/analytics/weakness";
import type {
  WeaknessAttemptEvidence,
  WeaknessComponentEvidence,
} from "@/modules/analytics/weakness-evidence";
import {
  buildAllWeaknessGroups,
  type WeaknessGroup,
} from "@/modules/analytics/weakness-groups";
import { buildComponentKey } from "@/modules/study-engine/natural-key";
import {
  buildWeakDrillPlan,
  isWeaknessDimension,
  validateWeakDrillRequest,
  type WeakDrillRequest,
} from "@/modules/study-session/weak-drill";

const NOW = 1_784_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
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

function evidence(
  e: LearnerEntry,
  overrides: Partial<WeaknessComponentEvidence> = {},
): WeaknessComponentEvidence {
  return {
    componentKey: `entry:${e.id}:skill:bab_identification`,
    entryId: e.id,
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

function attempt(
  e: LearnerEntry,
  form: SourceQuizFormField,
  isCorrect: boolean,
  occurredAtMs: number,
): WeaknessAttemptEvidence {
  counter += 1;
  return {
    attemptId: `attempt-${counter}`,
    componentKey: `entry:${e.id}:skill:bab_identification`,
    entryId: e.id,
    skillType: "bab_identification",
    direction: null,
    analysisForm: form,
    isCorrect,
    occurredAtMs,
  };
}

const DEFAULTS = { questionCount: 20 };

describe("isWeaknessDimension / validateWeakDrillRequest", () => {
  const groups: Record<string, readonly WeaknessGroup[]> = {
    bab: [
      {
        dimension: "bab",
        value: "nasara",
        weakComponentCount: 1,
        attemptedComponentCount: 1,
        firstAttemptCount: 2,
        incorrectFirstAttemptCount: 2,
        firstAttemptAccuracy: 0,
        lapseCount: 0,
        weaknessScore: 0.5,
        lastAttemptAtMs: NOW,
        lastIncorrectAtMs: NOW,
      },
    ],
    verb_type: [],
    source_form: [],
    direction: [],
    skill: [],
    state: [],
  } as never;

  it("accepts a valid, currently-materialised dimension/value pair", () => {
    const result = validateWeakDrillRequest("bab", "nasara", groups as never);
    expect(result).toEqual({ dimension: "bab", value: "nasara" });
  });

  it("rejects an unrecognised dimension", () => {
    expect(
      validateWeakDrillRequest("not-a-dimension", "nasara", groups as never),
    ).toBeNull();
  });

  it("rejects a value that is not a current group (stale or invented)", () => {
    expect(
      validateWeakDrillRequest("bab", "daraba", groups as never),
    ).toBeNull();
  });

  it("rejects missing dimension or value", () => {
    expect(
      validateWeakDrillRequest(null, "nasara", groups as never),
    ).toBeNull();
    expect(validateWeakDrillRequest("bab", null, groups as never)).toBeNull();
    expect(
      validateWeakDrillRequest(undefined, undefined, groups as never),
    ).toBeNull();
  });

  it("never requires a raw component key to validate — only dimension + value", () => {
    // The whole point: componentKey strings ("entry:1:skill:...") are never
    // accepted as a dimension or matched against a group value directly.
    expect(isWeaknessDimension("entry:1:skill:bab_identification")).toBe(false);
  });
});

describe("buildWeakDrillPlan — qualification and matching", () => {
  it("only currently-qualifying weak components enter the plan", () => {
    const weak = entry({ bab: "nasara" });
    const strong = entry({ bab: "nasara" });
    const weakEv = evidence(weak);
    const strongEv = evidence(strong, { componentKey: "k-strong" });
    const request: WeakDrillRequest = { dimension: "bab", value: "nasara" };

    const plan = buildWeakDrillPlan(
      [weak, strong],
      new Map([
        [weakEv.componentKey, weakEv],
        [strongEv.componentKey, strongEv],
      ]),
      new Map([
        [weakEv.componentKey, weakness({ qualifiesAsWeak: true })],
        [strongEv.componentKey, weakness({ qualifiesAsWeak: false, score: 0 })],
      ]),
      request,
      DEFAULTS,
      "seed",
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].identity.entryId).toBe(weak.id);
  });

  it("untouched components (no evidence entry at all) are excluded", () => {
    const e = entry({ bab: "nasara" });
    const request: WeakDrillRequest = { dimension: "bab", value: "nasara" };
    const plan = buildWeakDrillPlan(
      [e],
      new Map(),
      new Map(),
      request,
      DEFAULTS,
      "seed",
    );
    expect(plan).toHaveLength(0);
  });

  it("stale/ineligible components (evidence with no matching current entry) are excluded", () => {
    const ev = evidence(entry(), { entryId: 999_999 }); // no entry with this id
    const request: WeakDrillRequest = { dimension: "bab", value: "nasara" };
    const plan = buildWeakDrillPlan(
      [],
      new Map([[ev.componentKey, ev]]),
      new Map([[ev.componentKey, weakness()]]),
      request,
      DEFAULTS,
      "seed",
    );
    expect(plan).toHaveLength(0);
  });

  it("group matching is exact: a bāb drill contains only the selected bāb", () => {
    const nasara = entry({ bab: "nasara" });
    const daraba = entry({ bab: "daraba" });
    const nasaraEv = evidence(nasara);
    const darabaEv = evidence(daraba, {
      componentKey: "k-daraba",
      entryId: daraba.id,
    });
    const request: WeakDrillRequest = { dimension: "bab", value: "nasara" };

    const plan = buildWeakDrillPlan(
      [nasara, daraba],
      new Map([
        [nasaraEv.componentKey, nasaraEv],
        [darabaEv.componentKey, darabaEv],
      ]),
      new Map([
        [nasaraEv.componentKey, weakness()],
        [darabaEv.componentKey, weakness()],
      ]),
      request,
      DEFAULTS,
      "seed",
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].identity.entryId).toBe(nasara.id);
  });

  it("verb-type drill excludes unresolved entries (369/372-style) via data-driven eligibility", () => {
    const eligible = entry({ verb_type: "mudaaf" });
    const unresolved = entry({
      quiz_eligibility: {
        ...entry().quiz_eligibility,
        verb_type: false,
        root: false,
      },
      verb_type: "mudaaf",
    });
    const eligibleEv = evidence(eligible, {
      componentKey: "k-eligible",
      skillType: "verb_type_identification",
    });
    const unresolvedEv = evidence(unresolved, {
      componentKey: "k-unresolved",
      entryId: unresolved.id,
      skillType: "verb_type_identification",
    });
    const request: WeakDrillRequest = {
      dimension: "verb_type",
      value: "mudaaf",
    };

    const plan = buildWeakDrillPlan(
      [eligible, unresolved],
      new Map([
        [eligibleEv.componentKey, eligibleEv],
        [unresolvedEv.componentKey, unresolvedEv],
      ]),
      new Map([
        [eligibleEv.componentKey, weakness()],
        [unresolvedEv.componentKey, weakness()],
      ]),
      request,
      DEFAULTS,
      "seed",
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].identity.entryId).toBe(eligible.id);
  });

  it("direction drill contains only that direction; entry-level components never enter", () => {
    const e = entry();
    const recognitionEv = evidence(e, {
      componentKey: "k-recognition",
      skillType: "meaning_recognition",
      direction: "arabic_to_english",
      sourceField: "madi",
    });
    const recallEv = evidence(e, {
      componentKey: "k-recall",
      skillType: "meaning_recall",
      direction: "english_to_arabic",
      sourceField: "madi",
    });
    const babEv = evidence(e, { componentKey: "k-bab" });
    const request: WeakDrillRequest = {
      dimension: "direction",
      value: "arabic_to_english",
    };

    const plan = buildWeakDrillPlan(
      [e],
      new Map([
        [recognitionEv.componentKey, recognitionEv],
        [recallEv.componentKey, recallEv],
        [babEv.componentKey, babEv],
      ]),
      new Map([
        [recognitionEv.componentKey, weakness()],
        [recallEv.componentKey, weakness()],
        [babEv.componentKey, weakness()],
      ]),
      request,
      DEFAULTS,
      "seed",
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].identity.direction).toBe("arabic_to_english");
  });

  it("skill drill contains only that skill", () => {
    const e = entry();
    const babEv = evidence(e, {
      componentKey: "k-bab",
      skillType: "bab_identification",
    });
    const rootEv = evidence(e, {
      componentKey: "k-root",
      skillType: "root_identification",
    });
    const request: WeakDrillRequest = {
      dimension: "skill",
      value: "root_identification",
    };

    const plan = buildWeakDrillPlan(
      [e],
      new Map([
        [babEv.componentKey, babEv],
        [rootEv.componentKey, rootEv],
      ]),
      new Map([
        [babEv.componentKey, weakness()],
        [rootEv.componentKey, weakness()],
      ]),
      request,
      DEFAULTS,
      "seed",
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].identity.skillType).toBe("root_identification");
  });

  it("state drill uses the effective state carried on the evidence", () => {
    const e = entry();
    const learningEv = evidence(e, {
      componentKey: "k-learning",
      effectiveState: "learning",
    });
    const needsReviewEv = evidence(e, {
      componentKey: "k-needs-review",
      effectiveState: "needs_review",
    });
    const request: WeakDrillRequest = {
      dimension: "state",
      value: "needs_review",
    };

    const plan = buildWeakDrillPlan(
      [e],
      new Map([
        [learningEv.componentKey, learningEv],
        [needsReviewEv.componentKey, needsReviewEv],
      ]),
      new Map([
        [learningEv.componentKey, weakness()],
        [needsReviewEv.componentKey, weakness()],
      ]),
      request,
      DEFAULTS,
      "seed",
    );
    expect(plan).toHaveLength(1);
  });
});

describe("buildWeakDrillPlan — source-form dimension", () => {
  it("a translation component matches only its own intrinsic source field", () => {
    const e = entry();
    const ev = evidence(e, {
      componentKey: "k-madi",
      skillType: "meaning_recognition",
      direction: "arabic_to_english",
      sourceField: "madi",
    });
    const request: WeakDrillRequest = {
      dimension: "source_form",
      value: "madi",
    };
    const plan = buildWeakDrillPlan(
      [e],
      new Map([[ev.componentKey, ev]]),
      new Map([[ev.componentKey, weakness()]]),
      request,
      DEFAULTS,
      "seed",
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].promptForm).toBeUndefined(); // translation components carry no promptForm
  });

  it("an entry-level form-specific drill sets the selected promptForm and requires matching considered evidence", () => {
    const e = entry();
    const ev = evidence(e, { componentKey: "k-bab" });
    const cw = weakness({
      consideredFirstAttempts: [
        {
          attemptId: "a1",
          componentKey: "k-bab",
          entryId: e.id,
          skillType: "bab_identification",
          direction: null,
          analysisForm: "mudari",
          isCorrect: false,
          occurredAtMs: NOW,
        },
      ],
    });
    const request: WeakDrillRequest = {
      dimension: "source_form",
      value: "mudari",
    };
    const plan = buildWeakDrillPlan(
      [e],
      new Map([[ev.componentKey, ev]]),
      new Map([[ev.componentKey, cw]]),
      request,
      DEFAULTS,
      "seed",
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].promptForm).toBe("mudari");
  });

  it("never falls back to another prompt form: excludes when the selected form has no considered evidence", () => {
    const e = entry();
    const ev = evidence(e, { componentKey: "k-bab" });
    const cw = weakness({
      consideredFirstAttempts: [
        {
          attemptId: "a1",
          componentKey: "k-bab",
          entryId: e.id,
          skillType: "bab_identification",
          direction: null,
          analysisForm: "madi", // only madi evidence exists
          isCorrect: false,
          occurredAtMs: NOW,
        },
      ],
    });
    const request: WeakDrillRequest = {
      dimension: "source_form",
      value: "mudari",
    }; // requested form differs
    const plan = buildWeakDrillPlan(
      [e],
      new Map([[ev.componentKey, ev]]),
      new Map([[ev.componentKey, cw]]),
      request,
      DEFAULTS,
      "seed",
    );
    expect(plan).toHaveLength(0);
  });

  it("excludes a component when the selected form is no longer quiz-eligible", () => {
    const e = entry({
      quiz_eligibility: { ...entry().quiz_eligibility, mudari: false },
    });
    const ev = evidence(e, { componentKey: "k-bab" });
    const cw = weakness({
      consideredFirstAttempts: [
        {
          attemptId: "a1",
          componentKey: "k-bab",
          entryId: e.id,
          skillType: "bab_identification",
          direction: null,
          analysisForm: "mudari",
          isCorrect: false,
          occurredAtMs: NOW,
        },
      ],
    });
    const request: WeakDrillRequest = {
      dimension: "source_form",
      value: "mudari",
    };
    const plan = buildWeakDrillPlan(
      [e],
      new Map([[ev.componentKey, ev]]),
      new Map([[ev.componentKey, cw]]),
      request,
      DEFAULTS,
      "seed",
    );
    expect(plan).toHaveLength(0);
  });
});

describe("buildWeakDrillPlan — ranking, count, determinism", () => {
  it("highest scores are selected first", () => {
    const lowEntry = entry({ bab: "nasara" });
    const highEntry = entry({ bab: "nasara" });
    const low = evidence(lowEntry, {
      componentKey: "k-low",
      entryId: lowEntry.id,
    });
    const high = evidence(highEntry, {
      componentKey: "k-high",
      entryId: highEntry.id,
    });
    const request: WeakDrillRequest = { dimension: "bab", value: "nasara" };
    const plan = buildWeakDrillPlan(
      [lowEntry, highEntry],
      new Map([
        [low.componentKey, low],
        [high.componentKey, high],
      ]),
      new Map([
        [low.componentKey, weakness({ score: 0.3 })],
        [high.componentKey, weakness({ score: 0.9 })],
      ]),
      request,
      DEFAULTS,
      "seed",
    );
    expect(plan.map((item) => item.identity.entryId)).toEqual([
      highEntry.id,
      lowEntry.id,
    ]);
  });

  it("session default question count is honoured", () => {
    const entries = Array.from({ length: 5 }, () => entry());
    const evidenceMap = new Map<string, WeaknessComponentEvidence>();
    const weaknessMap = new Map<string, ComponentWeakness>();
    for (const e of entries) {
      const ev = evidence(e);
      evidenceMap.set(ev.componentKey, ev);
      weaknessMap.set(ev.componentKey, weakness());
    }
    const request: WeakDrillRequest = { dimension: "bab", value: "nasara" };
    const plan = buildWeakDrillPlan(
      entries,
      evidenceMap,
      weaknessMap,
      request,
      { questionCount: 3 },
      "seed",
    );
    expect(plan).toHaveLength(3);
  });

  it("rejects a non-positive question count", () => {
    const request: WeakDrillRequest = { dimension: "bab", value: "nasara" };
    expect(() =>
      buildWeakDrillPlan(
        [],
        new Map(),
        new Map(),
        request,
        { questionCount: 0 },
        "seed",
      ),
    ).toThrow();
  });

  it("same inputs produce an identical plan (deterministic, seed-stable)", () => {
    const entries = Array.from({ length: 4 }, () => entry());
    const evidenceMap = new Map<string, WeaknessComponentEvidence>();
    const weaknessMap = new Map<string, ComponentWeakness>();
    for (const e of entries) {
      const ev = evidence(e);
      evidenceMap.set(ev.componentKey, ev);
      weaknessMap.set(ev.componentKey, weakness({ score: 0.2 + e.id * 0.01 }));
    }
    const request: WeakDrillRequest = { dimension: "bab", value: "nasara" };
    const a = buildWeakDrillPlan(
      entries,
      evidenceMap,
      weaknessMap,
      request,
      DEFAULTS,
      "seed-a",
    );
    const b = buildWeakDrillPlan(
      entries,
      evidenceMap,
      weaknessMap,
      request,
      DEFAULTS,
      "seed-a",
    );
    const c = buildWeakDrillPlan(
      entries,
      evidenceMap,
      weaknessMap,
      request,
      DEFAULTS,
      "seed-b",
    );
    expect(a).toEqual(b);
    expect(a).toEqual(c); // seed does not affect ordering — fully score/recency/key deterministic
  });
});

describe("buildWeakDrillPlan — source_form agrees with modules/analytics/weakness-groups.ts (ARCH-001 regression)", () => {
  it("selects exactly the qualifying components weakness-groups.ts attributes to each surfaced form, for every real snapshot through the actual T1-T3 pipeline", () => {
    const entries = Array.from({ length: 3 }, () => entry());
    const evidenceMap = new Map<string, WeaknessComponentEvidence>();
    const weaknessMap = new Map<string, ComponentWeakness>();

    // Component 0: prompted with BOTH māḍī (incorrect x2, recent) and
    // muḍāriʿ (correct x1) — multi-form, qualifies as weak overall.
    const ev0 = evidence(entries[0], {
      firstAttempts: [
        attempt(entries[0], "madi", false, NOW),
        attempt(entries[0], "madi", false, NOW - DAY_MS),
        attempt(entries[0], "mudari", true, NOW),
      ],
    });
    // Component 1: prompted with muḍāriʿ only, all correct — never weak.
    const ev1 = evidence(entries[1], {
      componentKey: `entry:${entries[1].id}:skill:bab_identification`,
      entryId: entries[1].id,
      firstAttempts: [
        attempt(entries[1], "mudari", true, NOW),
        attempt(entries[1], "mudari", true, NOW - DAY_MS),
      ],
    });
    // Component 2: prompted with māḍī only, both incorrect — weak, single form.
    const ev2 = evidence(entries[2], {
      componentKey: `entry:${entries[2].id}:skill:bab_identification`,
      entryId: entries[2].id,
      firstAttempts: [
        attempt(entries[2], "madi", false, NOW),
        attempt(entries[2], "madi", false, NOW - DAY_MS),
      ],
    });

    for (const ev of [ev0, ev1, ev2]) {
      evidenceMap.set(ev.componentKey, ev);
      // Real computeComponentWeakness output, not a hand-built fixture —
      // exercises the actual T2 scoring the production pipeline uses.
      weaknessMap.set(ev.componentKey, computeComponentWeakness(ev, NOW));
    }

    const groups = buildAllWeaknessGroups(weaknessMap, evidenceMap, entries);
    expect(groups.source_form.length).toBeGreaterThan(0); // the test is non-vacuous

    for (const group of groups.source_form) {
      const request: WeakDrillRequest = {
        dimension: "source_form",
        value: group.value,
      };
      const plan = buildWeakDrillPlan(
        entries,
        evidenceMap,
        weaknessMap,
        request,
        DEFAULTS,
        "seed",
      );
      const planKeys = new Set(
        plan.map((item) => buildComponentKey(item.identity)),
      );

      // The set weakness-groups.ts itself attributes to this form (the SAME
      // consideredFirstAttempts window the drill reads) among currently-
      // qualifying weak components.
      const expectedKeys = new Set<string>();
      for (const [key, cw] of weaknessMap) {
        if (!cw.qualifiesAsWeak) continue;
        const hasForm = cw.consideredFirstAttempts.some(
          (row) => row.analysisForm === group.value,
        );
        if (hasForm) expectedKeys.add(key);
      }
      expect(planKeys).toEqual(expectedKeys);
    }
  });
});
