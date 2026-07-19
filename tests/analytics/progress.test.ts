/**
 * Pure progress formulas over seeded mixed states (Phase 12 §21.2–21.5,
 * §7.3–7.9, §11). Components and natural keys always come from the real
 * derivation over the real release — never hand-typed keys or Arabic.
 */
import { describe, expect, it } from "vitest";

import {
  babGroup,
  bookPageGroup,
  computeProgressSummary,
  countDueToday,
  effectiveComponents,
  essentialGroupProgress,
  percentage,
  verbTypeGroup,
  type ProgressComponentState,
} from "@/modules/analytics/progress";
import { localDateForInstant } from "@/modules/analytics/dates";
import type { SchedulerCard } from "@/modules/scheduler/fsrs";
import {
  deriveAllComponents,
  deriveComponentsForEntry,
} from "@/modules/study-engine/components";

import { entry, learnerEntries } from "../study-engine/fixtures";

const NOW = Date.UTC(2026, 6, 17, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

const allComponents = deriveAllComponents(learnerEntries);
const TOTAL = learnerEntries.length;

function card(overrides: Partial<SchedulerCard> = {}): SchedulerCard {
  return {
    stability: 40,
    difficulty: 5,
    dueAtMs: NOW + 7 * DAY,
    state: "review",
    reps: 8,
    lapses: 0,
    scheduledDays: 30,
    learningSteps: 0,
    lastReviewAtMs: NOW - DAY,
    ...overrides,
  };
}

function mastered(componentKey: string): ProgressComponentState {
  return { componentKey, fsrs: card(), learnerState: "mastered" };
}

function learning(componentKey: string): ProgressComponentState {
  return {
    componentKey,
    fsrs: card({ state: "learning", reps: 1 }),
    learnerState: "learning",
  };
}

/** Stored records mastering every essential component of an entry. */
function masterEssentials(entryId: number): ProgressComponentState[] {
  return deriveComponentsForEntry(entry(entryId))
    .filter((component) => component.essential)
    .map((component) => mastered(component.key));
}

function summarize(stored: ProgressComponentState[]) {
  return computeProgressSummary(
    effectiveComponents(allComponents, stored, NOW),
    TOTAL,
  );
}

describe("overall word mastery (§7.3, §21.2)", () => {
  it("no materialised components → 0/455", () => {
    expect(summarize([]).overallCompletion).toEqual({
      numerator: 0,
      denominator: 455,
    });
  });

  it("one mastered component does not master an entry", () => {
    const first = deriveComponentsForEntry(entry(1)).filter(
      (c) => c.essential,
    )[0];
    const summary = summarize([mastered(first.key)]);
    expect(summary.overallCompletion.numerator).toBe(0);
    expect(summary.wordStates.wordsLearning).toBe(1);
    expect(summary.wordStates.wordsStarted).toBe(1);
  });

  it("every essential component mastered → entry mastered", () => {
    const summary = summarize(masterEssentials(1));
    expect(summary.overallCompletion.numerator).toBe(1);
    expect(summary.wordStates.wordsMastered).toBe(1);
  });

  it("extended components never block word mastery", () => {
    // Entry 1's extended components stay not_started (or even learning) —
    // the entry is mastered on its essential set alone.
    const extended = deriveComponentsForEntry(entry(1)).filter(
      (c) => !c.essential,
    );
    expect(extended.length).toBeGreaterThan(0);
    const summary = summarize([
      ...masterEssentials(1),
      learning(extended[0].key),
    ]);
    expect(summary.overallCompletion.numerator).toBe(1);
  });

  it("mastering ONLY extended components never creates word mastery or started status", () => {
    // §21.2: word mastery can differ from extended-component mastery — the
    // converse direction: a fully-mastered extended set with an untouched
    // essential set leaves the word Not started.
    const extended = deriveComponentsForEntry(entry(1)).filter(
      (c) => !c.essential,
    );
    expect(extended.length).toBeGreaterThan(0);
    const summary = summarize(extended.map((c) => mastered(c.key)));
    expect(summary.overallCompletion.numerator).toBe(0);
    expect(summary.wordStates.wordsStarted).toBe(0);
    expect(summary.wordStates.wordsNotStarted).toBe(455);
    // The extended mastery is still visible at the component level.
    expect(summary.componentMastery.numerator).toBe(extended.length);
  });

  it("entry 369 masters without a root component (ineligible root)", () => {
    const summary = summarize(masterEssentials(369));
    expect(summary.overallCompletion.numerator).toBe(1);
    expect(summary.perSkill.root_identification.numerator).toBe(0);
  });

  it("one DUE essential component removes word mastery", () => {
    const stored = masterEssentials(1);
    stored[0] = {
      ...stored[0],
      fsrs: card({ dueAtMs: NOW - 1000 }),
    };
    const summary = summarize(stored);
    expect(summary.overallCompletion.numerator).toBe(0);
    expect(summary.wordStates.wordsLearning).toBe(1);
    expect(summary.wordStates.wordsMastered).toBe(0);
  });

  it("one RELEARNING essential component removes word mastery", () => {
    const stored = masterEssentials(1);
    stored[0] = {
      ...stored[0],
      fsrs: card({ state: "relearning", dueAtMs: NOW + 10 * 60 * 1000 }),
    };
    const summary = summarize(stored);
    expect(summary.overallCompletion.numerator).toBe(0);
  });

  it("component mastery can be high while word mastery stays lower", () => {
    // Master every essential except one on each of two entries.
    const stored = [
      ...masterEssentials(1).slice(0, -1),
      ...masterEssentials(2).slice(0, -1),
    ];
    const summary = summarize(stored);
    expect(summary.componentMastery.numerator).toBe(stored.length);
    expect(summary.overallCompletion.numerator).toBe(0);
  });
});

describe("word-state counts (§7.8, §21.3)", () => {
  it("exclusive states and the inclusive started identity", () => {
    const stored = [
      ...masterEssentials(1), // mastered
      learning(
        deriveComponentsForEntry(entry(2)).filter((c) => c.essential)[0].key,
      ), // learning
    ];
    const { wordStates } = summarize(stored);
    expect(wordStates.wordsMastered).toBe(1);
    expect(wordStates.wordsLearning).toBe(1);
    expect(wordStates.wordsStarted).toBe(
      wordStates.wordsLearning + wordStates.wordsMastered,
    );
    expect(wordStates.wordsNotStarted).toBe(455 - wordStates.wordsStarted);
  });

  it("a due essential component keeps the word Learning, never Mastered", () => {
    const stored = masterEssentials(3);
    stored[stored.length - 1] = {
      ...stored[stored.length - 1],
      fsrs: card({ dueAtMs: NOW }),
    };
    const { wordStates } = summarize(stored);
    expect(wordStates.wordsMastered).toBe(0);
    expect(wordStates.wordsLearning).toBe(1);
  });

  it("an extended-only start leaves the word Not started (§7.8 definition)", () => {
    const extended = deriveComponentsForEntry(entry(1)).filter(
      (c) => !c.essential,
    );
    const { wordStates } = summarize([learning(extended[0].key)]);
    expect(wordStates.wordsNotStarted).toBe(455);
    expect(wordStates.wordsStarted).toBe(0);
  });
});

describe("per-skill and per-form completion (§7.5–7.6, §21.4)", () => {
  it("skill numerators count only that skill's mastered components", () => {
    const components = deriveComponentsForEntry(entry(1));
    const bab = components.find((c) => c.skillType === "bab_identification")!;
    const recognition = components.find(
      (c) => c.skillType === "meaning_recognition" && c.sourceField === "madi",
    )!;
    const summary = summarize([mastered(bab.key), mastered(recognition.key)]);
    expect(summary.perSkill.bab_identification.numerator).toBe(1);
    expect(summary.perSkill.meaning_recognition.numerator).toBe(1);
    expect(summary.perSkill.meaning_recall.numerator).toBe(0);
    expect(summary.perSkill.root_identification.numerator).toBe(0);
    expect(summary.perSkill.verb_type_identification.numerator).toBe(0);
  });

  it("form numerators count both directions of that source form", () => {
    const components = deriveComponentsForEntry(entry(1));
    const recognitionMadi = components.find(
      (c) => c.skillType === "meaning_recognition" && c.sourceField === "madi",
    )!;
    const recallMadi = components.find(
      (c) => c.skillType === "meaning_recall" && c.sourceField === "madi",
    )!;
    const summary = summarize([
      mastered(recognitionMadi.key),
      mastered(recallMadi.key),
    ]);
    expect(summary.perForm.madi.numerator).toBe(2);
    expect(summary.perForm.mudari.numerator).toBe(0);
    // Entry-level components never enter a form bucket.
    expect(
      Object.values(summary.perForm).reduce(
        (sum, ratio) => sum + ratio.numerator,
        0,
      ),
    ).toBe(2);
  });
});

describe("essential group completion (§7.7, §21.5)", () => {
  it("bāb groups: mastering one entry's essentials moves only its bāb", () => {
    const target = entry(1);
    const groups = essentialGroupProgress(
      effectiveComponents(allComponents, masterEssentials(1), NOW),
      learnerEntries,
      babGroup,
    );
    const targetRatio = groups.get(target.bab)!;
    const essentialCount = deriveComponentsForEntry(target).filter(
      (c) => c.essential,
    ).length;
    expect(targetRatio.numerator).toBe(essentialCount);
    // Every other bāb group has a zero numerator.
    for (const [bab, ratio] of groups) {
      if (bab !== target.bab) expect(ratio.numerator).toBe(0);
    }
    // Denominator = the group's eligible essential components.
    const expectedDenominator = learnerEntries
      .filter((candidate) => candidate.bab === target.bab)
      .flatMap((candidate) =>
        deriveComponentsForEntry(candidate).filter((c) => c.essential),
      ).length;
    expect(targetRatio.denominator).toBe(expectedDenominator);
  });

  it("verb-type groups: an ELIGIBLE entry's mastery lands in its own bucket", () => {
    const target = entry(1);
    expect(target.quiz_eligibility.verb_type).toBe(true);
    const groups = essentialGroupProgress(
      effectiveComponents(allComponents, masterEssentials(1), NOW),
      learnerEntries,
      verbTypeGroup,
    );
    const targetRatio = groups.get(target.verb_type)!;
    const essentialCount = deriveComponentsForEntry(target).filter(
      (c) => c.essential,
    ).length;
    expect(targetRatio.numerator).toBe(essentialCount);
    for (const [verbType, ratio] of groups) {
      if (verbType !== target.verb_type) expect(ratio.numerator).toBe(0);
    }
    const expectedDenominator = learnerEntries
      .filter(
        (candidate) =>
          candidate.quiz_eligibility.verb_type &&
          candidate.verb_type === target.verb_type,
      )
      .flatMap((candidate) =>
        deriveComponentsForEntry(candidate).filter((c) => c.essential),
      ).length;
    expect(targetRatio.denominator).toBe(expectedDenominator);
  });

  it("verb-type groups exclude the unresolved entries 369/372 entirely", () => {
    const groups = essentialGroupProgress(
      effectiveComponents(allComponents, [], NOW),
      learnerEntries,
      verbTypeGroup,
    );
    const groupedTotal = [...groups.values()].reduce(
      (sum, ratio) => sum + ratio.denominator,
      0,
    );
    const excluded = [369, 372]
      .flatMap((id) => deriveComponentsForEntry(entry(id)))
      .filter((c) => c.essential).length;
    const allEssential = allComponents.filter((c) => c.essential).length;
    expect(groupedTotal).toBe(allEssential - excluded);
  });

  it("book-page groups cover every entry exactly once", () => {
    const groups = essentialGroupProgress(
      effectiveComponents(allComponents, [], NOW),
      learnerEntries,
      bookPageGroup,
    );
    const groupedTotal = [...groups.values()].reduce(
      (sum, ratio) => sum + ratio.denominator,
      0,
    );
    expect(groupedTotal).toBe(allComponents.filter((c) => c.essential).length);
  });
});

describe("percentages (§7.9)", () => {
  it("keeps exact values and renders zero denominators as unavailable", () => {
    expect(percentage({ numerator: 0, denominator: 0 })).toBeNull();
    expect(percentage({ numerator: 1, denominator: 3 })).toBeCloseTo(
      33.333333,
      5,
    );
    expect(percentage({ numerator: 455, denominator: 455 })).toBe(100);
  });
});

describe("reviews due today (§11)", () => {
  const TIMEZONE = "UTC";
  const TODAY = localDateForInstant(NOW, TIMEZONE);
  const babOf = (id: number) =>
    deriveComponentsForEntry(entry(id)).find(
      (c) => c.skillType === "bab_identification",
    )!;

  it("counts overdue and later-today, never tomorrow/missing/corrupt/stale", () => {
    const stored: ProgressComponentState[] = [
      // Overdue (yesterday).
      { componentKey: babOf(1).key, fsrs: card({ dueAtMs: NOW - DAY }) },
      // Later today (23:59 UTC).
      {
        componentKey: babOf(2).key,
        fsrs: card({ dueAtMs: Date.UTC(2026, 6, 17, 23, 59, 0) }),
      },
      // Tomorrow — not counted.
      {
        componentKey: babOf(3).key,
        fsrs: card({ dueAtMs: Date.UTC(2026, 6, 18, 0, 1, 0) }),
      },
      // Corrupt card — never counted.
      {
        componentKey: babOf(4).key,
        fsrs: card({
          dueAtMs: NOW - DAY,
          state: "zombie" as SchedulerCard["state"],
        }),
      },
      // Missing card — never counted.
      { componentKey: babOf(5).key },
      // Stale key not derivable from the release — never counted.
      {
        componentKey: "entry:9999:skill:bab_identification",
        fsrs: card({ dueAtMs: NOW - DAY }),
      },
    ];
    expect(
      countDueToday(
        effectiveComponents(allComponents, stored, NOW),
        TIMEZONE,
        TODAY,
      ),
    ).toBe(2);
  });

  it("a card due at EXACT local midnight counts on the date it labels", () => {
    // 2026-07-18T00:00:00.000Z labels 2026-07-18 in UTC: counted once today
    // is the 18th, never while today is still the 17th — the comparison is
    // calendar-label based, immune to millisecond boundary arithmetic.
    const stored = [
      {
        componentKey: babOf(1).key,
        fsrs: card({ dueAtMs: Date.UTC(2026, 6, 18, 0, 0, 0) }),
      },
    ];
    const effective = effectiveComponents(allComponents, stored, NOW);
    expect(countDueToday(effective, TIMEZONE, "2026-07-17")).toBe(0);
    expect(countDueToday(effective, TIMEZONE, "2026-07-18")).toBe(1);
  });

  it("uses the effective zone's calendar date, not a 24-hour window", () => {
    // 2026-07-17T20:00Z is already 2026-07-18 in Asia/Tokyo: a card due at
    // that instant counts today in Tokyo only once Tokyo's date reaches it.
    const dueInstant = Date.UTC(2026, 6, 17, 20, 0, 0);
    const stored = [
      { componentKey: babOf(1).key, fsrs: card({ dueAtMs: dueInstant }) },
    ];
    const effective = effectiveComponents(allComponents, stored, NOW);
    const tokyoToday = localDateForInstant(NOW, "Asia/Tokyo"); // 2026-07-17
    expect(countDueToday(effective, "Asia/Tokyo", tokyoToday)).toBe(0);
    expect(
      countDueToday(
        effective,
        "Asia/Tokyo",
        localDateForInstant(NOW + DAY, "Asia/Tokyo"),
      ),
    ).toBe(1);
    // The SAME instant in UTC is still 2026-07-17 — counted today.
    expect(countDueToday(effective, "UTC", TODAY)).toBe(1);
  });
});
