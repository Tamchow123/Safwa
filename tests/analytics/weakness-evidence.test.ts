/**
 * Weakness evidence preparation (Phase 13 §7–9): first-attempt-only
 * filtering, reinforcement exclusion, revoked/rejected exclusion,
 * source-form attribution (translation vs entry-level), stale/ineligible
 * component exclusion and safe lapse handling.
 */
import { describe, expect, it } from "vitest";

import type { EffectiveComponent } from "@/modules/analytics/progress";
import { prepareWeaknessEvidence } from "@/modules/analytics/weakness-evidence";

import { attempt, event } from "./fixtures";

// Local counter for the component() family only (attempt()/event() keep
// their own counter inside ./fixtures) — used purely to keep generated
// `component()` keys unique across calls in the same test.
let counter = 0;

function component(
  overrides: Partial<EffectiveComponent> = {},
): EffectiveComponent {
  counter += 1;
  return {
    key: `entry:1:skill:meaning_recognition:field:madi:direction:arabic_to_english-${counter}`,
    entryId: 1,
    skillType: "meaning_recognition",
    componentShape: "form_direction",
    sourceField: "madi",
    direction: "arabic_to_english",
    essential: true,
    state: "learning",
    card: null,
    ...overrides,
  };
}

// A fixed key (not counter-suffixed): tests using babComponent() identify
// it by this stable key rather than a generated one, and never need more
// than one bāb component alive at a time within a single test.
function babComponent(
  overrides: Partial<EffectiveComponent> = {},
): EffectiveComponent {
  return component({
    key: "entry:1:skill:bab_identification",
    skillType: "bab_identification",
    componentShape: "entry_level",
    sourceField: null,
    direction: null,
    ...overrides,
  });
}

describe("prepareWeaknessEvidence — first-attempt filtering", () => {
  it("includes a valid first attempt", () => {
    const c = component();
    const a = attempt({ componentKey: c.key, isCorrect: false });
    const evidence = prepareWeaknessEvidence([c], [a], []);
    expect(evidence.get(c.key)?.firstAttempts).toHaveLength(1);
    expect(evidence.get(c.key)?.firstAttempts[0].isCorrect).toBe(false);
  });

  it("excludes a non-first attempt", () => {
    const c = component();
    const a = attempt({ componentKey: c.key, isFirstAttempt: false });
    const evidence = prepareWeaknessEvidence([c], [a], []);
    expect(evidence.has(c.key)).toBe(false);
  });

  it("excludes a reinforcement attempt from evidence but the earlier failed first attempt remains", () => {
    const c = component();
    const failedFirst = attempt({
      componentKey: c.key,
      isCorrect: false,
    });
    const reinforcement = attempt({
      componentKey: c.key,
      isFirstAttempt: false,
      isReinforcement: true,
      isCorrect: true,
    });
    const evidence = prepareWeaknessEvidence(
      [c],
      [failedFirst, reinforcement],
      [],
    );
    const rows = evidence.get(c.key)?.firstAttempts ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].isCorrect).toBe(false);
  });

  it("skips a payload-less legacy attempt (invalid instant, false first-attempt flag)", () => {
    const c = component();
    const a = attempt({
      componentKey: c.key,
      occurredAtUtc: null,
      isFirstAttempt: false,
      isReinforcement: false,
      isCorrect: false,
    });
    const evidence = prepareWeaknessEvidence([c], [a], []);
    expect(evidence.has(c.key)).toBe(false);
  });

  it("skips an attempt with an unreadable UTC instant", () => {
    const c = component();
    const a = attempt({ componentKey: c.key, occurredAtUtc: "not-a-date" });
    const evidence = prepareWeaknessEvidence([c], [a], []);
    expect(evidence.has(c.key)).toBe(false);
  });
});

describe("prepareWeaknessEvidence — revoked/rejected exclusion", () => {
  it("excludes an attempt whose linked event was revoked", () => {
    const c = component();
    const a = attempt({ componentKey: c.key });
    const e = event({ attemptId: a.id, status: "revoked" });
    const evidence = prepareWeaknessEvidence([c], [a], [e]);
    expect(evidence.has(c.key)).toBe(false);
  });

  it("excludes an attempt whose linked event was sync-rejected", () => {
    const c = component();
    const a = attempt({ componentKey: c.key });
    const e = event({ attemptId: a.id, syncStatus: "rejected" });
    const evidence = prepareWeaknessEvidence([c], [a], [e]);
    expect(evidence.has(c.key)).toBe(false);
  });

  it("a conflict-demoted linked event does not exclude the attempt (only FSRS weakness must ignore it)", () => {
    const c = component();
    const a = attempt({ componentKey: c.key });
    const e = event({ attemptId: a.id, status: "conflict_demoted" });
    const evidence = prepareWeaknessEvidence([c], [a], [e]);
    expect(evidence.get(c.key)?.firstAttempts).toHaveLength(1);
  });
});

describe("prepareWeaknessEvidence — §9 source-form attribution", () => {
  it("a translation component attributes to attempt.sourceField", () => {
    const c = component({ sourceField: "mudari" });
    const a = attempt({
      componentKey: c.key,
      sourceField: "mudari",
      promptField: "meaning",
    });
    const evidence = prepareWeaknessEvidence([c], [a], []);
    expect(evidence.get(c.key)?.firstAttempts[0].analysisForm).toBe("mudari");
  });

  it("an entry-level component attributes to attempt.promptField when it is a source form", () => {
    const c = babComponent();
    const a = attempt({
      componentKey: c.key,
      entryId: 1,
      skillType: "bab_identification",
      direction: null,
      sourceField: null,
      promptField: "madi",
    });
    const evidence = prepareWeaknessEvidence([c], [a], []);
    expect(evidence.get(c.key)?.firstAttempts[0].analysisForm).toBe("madi");
  });

  it("two prompt-varied attempts on the same bāb component produce separate form attributions, not a default", () => {
    const c = babComponent();
    const madi = attempt({
      componentKey: c.key,
      skillType: "bab_identification",
      sourceField: null,
      promptField: "madi",
      isCorrect: false,
    });
    const mudari = attempt({
      componentKey: c.key,
      skillType: "bab_identification",
      sourceField: null,
      promptField: "mudari",
      isCorrect: true,
    });
    const evidence = prepareWeaknessEvidence([c], [madi, mudari], []);
    const forms = evidence
      .get(c.key)
      ?.firstAttempts.map((row) => row.analysisForm);
    expect(forms).toEqual(["madi", "mudari"]);
  });

  it("an entry-level promptField that is not one of the six source forms (e.g. meaning) attributes to null", () => {
    const c = babComponent();
    const a = attempt({
      componentKey: c.key,
      skillType: "bab_identification",
      sourceField: null,
      promptField: "bab",
    });
    const evidence = prepareWeaknessEvidence([c], [a], []);
    expect(evidence.get(c.key)?.firstAttempts[0].analysisForm).toBeNull();
  });
});

describe("prepareWeaknessEvidence — component derivability and lapses", () => {
  it("excludes an attempt whose component is not in the current effective set (stale/ineligible/unsupported release)", () => {
    const a = attempt({ componentKey: "entry:999:skill:bab_identification" });
    const evidence = prepareWeaknessEvidence([], [a], []);
    expect(evidence.size).toBe(0);
  });

  it("derives entryId/skillType/direction from the joined component, not a mismatched raw attempt row (ARCH-001)", () => {
    const c = babComponent(); // entryId 1, bab_identification, direction null
    const a = attempt({
      componentKey: c.key,
      // Deliberately disagrees with what c.key encodes — a corrupt/legacy
      // row must never leak this mismatched identity into evidence.
      entryId: 999,
      skillType: "meaning_recognition",
      direction: "arabic_to_english",
      sourceField: null,
      promptField: "madi",
    });
    const evidence = prepareWeaknessEvidence([c], [a], []);
    const row = evidence.get(c.key)?.firstAttempts[0];
    expect(row?.entryId).toBe(c.entryId);
    expect(row?.skillType).toBe(c.skillType);
    expect(row?.direction).toBe(c.direction);
  });

  it("carries the current FSRS lapse count even with zero first attempts", () => {
    const c = component({
      card: {
        stability: 1,
        difficulty: 1,
        dueAtMs: 1_000,
        state: "review",
        reps: 3,
        lapses: 2,
        scheduledDays: 1,
        learningSteps: 0,
        lastReviewAtMs: 1,
      },
    });
    const evidence = prepareWeaknessEvidence([c], [], []);
    expect(evidence.get(c.key)?.fsrsLapses).toBe(2);
    expect(evidence.get(c.key)?.firstAttempts).toEqual([]);
  });

  it("an invalid negative lapse count fails safe to zero", () => {
    const c = component({
      card: {
        stability: 1,
        difficulty: 1,
        dueAtMs: 1_000,
        state: "review",
        reps: 3,
        lapses: -1,
        scheduledDays: 1,
        learningSteps: 0,
        lastReviewAtMs: 1,
      },
    });
    const evidence = prepareWeaknessEvidence([c], [], []);
    expect(evidence.has(c.key)).toBe(false); // no attempts, no positive lapses -> not a candidate
  });

  it("an unusable card (corrupt state) fails lapses safe to zero and is not a candidate on its own", () => {
    const c = component({
      card: {
        stability: 1,
        difficulty: 1,
        dueAtMs: Number.NaN,
        state: "review",
        reps: 3,
        lapses: 5,
        scheduledDays: 1,
        learningSteps: 0,
        lastReviewAtMs: 1,
      },
    });
    const evidence = prepareWeaknessEvidence([c], [], []);
    expect(evidence.has(c.key)).toBe(false);
  });

  it("an untouched component (no attempts, no lapses) produces no evidence entry", () => {
    const c = component();
    const evidence = prepareWeaknessEvidence([c], [], []);
    expect(evidence.size).toBe(0);
  });
});
