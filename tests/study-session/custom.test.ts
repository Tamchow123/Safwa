/**
 * Custom session configuration (Phase 11, §4.4) — the filter matrix.
 *
 * The heart of this file is a PROPERTY test: many seeded-random filter
 * configurations run against the REAL learner release (455 entries), and for
 * every configuration every produced component must match EVERY active filter
 * and be quiz-eligible (the phase's testing checkpoint). Deterministic: the
 * random configurations come from the engine's seeded RNG, never Math.random.
 */
import { describe, expect, it } from "vitest";

import {
  BAB_IDS,
  SOURCE_QUIZ_FORM_FIELDS,
  VERB_TYPE_IDS,
  type SourceQuizFormField,
} from "@/modules/content/constants";
import type { SchedulerCard } from "@/modules/scheduler/fsrs";
import {
  deriveAllComponents,
  isComponentEligible,
} from "@/modules/study-engine/components";
import { isFieldEligible } from "@/modules/study-engine/fields";
import { createRng, type Rng } from "@/modules/study-engine/rng";
import {
  allowedPromptForms,
  buildCustomPlan,
  componentStateClasses,
  COMPONENT_STATE_FILTERS,
  CUSTOM_SESSION_MODES,
  eligibleCustomComponents,
  filterByStates,
  looseningSuggestions,
  matchesEntryFilters,
  OPEN_CUSTOM_FILTERS,
  type ComponentStateFilter,
  type CustomSessionConfig,
  type CustomSessionFilters,
} from "@/modules/study-session/custom";
import type { StoredComponentState } from "@/modules/study-session/mixed";

import { entry, learnerEntries } from "../study-engine/fixtures";

const NOW_MS = Date.UTC(2026, 6, 17, 12, 0, 0);
const UNRESOLVED_IDS = [369, 372];

/* ------------------------------------------------------------------ */
/* Seeded random configuration + stored-state generators               */
/* ------------------------------------------------------------------ */

function randomSubset<T>(rng: Rng, values: readonly T[], p: number): T[] {
  return values.filter(() => rng.next() < p);
}

function randomFilters(rng: Rng): CustomSessionFilters {
  const withPages = rng.next() < 0.4;
  const min = withPages && rng.next() < 0.7 ? 1 + rng.int(40) : null;
  const max = withPages && rng.next() < 0.7 ? 1 + rng.int(40) : null;
  return {
    mode: CUSTOM_SESSION_MODES[rng.int(CUSTOM_SESSION_MODES.length)],
    direction: (["random", "arabic_to_english", "english_to_arabic"] as const)[
      rng.int(3)
    ],
    forms: randomSubset(rng, SOURCE_QUIZ_FORM_FIELDS, 0.25),
    babs: randomSubset(rng, BAB_IDS, 0.2),
    verbTypes: randomSubset(rng, VERB_TYPE_IDS, 0.15),
    bookPages: { min, max },
    states: randomSubset(rng, COMPONENT_STATE_FILTERS, 0.25),
  };
}

function randomCard(rng: Rng): SchedulerCard {
  const due = rng.next() < 0.5;
  return {
    stability: 1 + rng.next() * 10,
    difficulty: 1 + rng.next() * 9,
    dueAtMs: due
      ? NOW_MS - 1 - rng.int(86_400_000)
      : NOW_MS + 1 + rng.int(86_400_000),
    state: "review",
    reps: 1 + rng.int(5),
    lapses: rng.int(3),
    scheduledDays: 1 + rng.int(30),
    learningSteps: 0,
    lastReviewAtMs: NOW_MS - 86_400_000,
  };
}

/** Synthesize stored scheduling state + weak scores for a random subset. */
function randomStoredState(rng: Rng): {
  stored: Map<string, StoredComponentState>;
  weakScores: Map<string, number>;
} {
  const stored = new Map<string, StoredComponentState>();
  const weakScores = new Map<string, number>();
  for (const component of deriveAllComponents(learnerEntries)) {
    const roll = rng.next();
    if (roll < 0.7) continue; // most components never reviewed (new)
    const learnerState = (
      ["learning", "mastered", "needs_review", "not_started"] as const
    )[rng.int(4)];
    stored.set(component.key, {
      componentKey: component.key,
      fsrs: randomCard(rng),
      learnerState,
    });
    if (rng.next() < 0.4) {
      weakScores.set(component.key, 0.2 + rng.next() * 0.8);
    }
  }
  return { stored, weakScores };
}

/* ------------------------------------------------------------------ */
/* Property test — the phase's testing checkpoint                      */
/* ------------------------------------------------------------------ */

describe("custom session filters — property test over seeded random configs", () => {
  it("every filter combination produces only matching, eligible components", () => {
    const CONFIGS = 150;
    for (let index = 0; index < CONFIGS; index++) {
      const rng = createRng(`custom-property-${index}`);
      const filters = randomFilters(rng);
      const { stored, weakScores } = randomStoredState(rng);

      const contentMatched = eligibleCustomComponents(learnerEntries, filters);
      for (const component of contentMatched) {
        const componentEntry = entry(component.entryId);

        // Quiz eligibility (hard rule 2): the derived component must itself
        // be eligible for its entry.
        expect(
          isComponentEligible(componentEntry, {
            entryId: component.entryId,
            skillType: component.skillType,
            sourceField: component.sourceField ?? undefined,
            direction: component.direction ?? undefined,
          }),
        ).toBe(true);

        // Mode / direction / forms.
        if (filters.mode === "mc" || filters.mode === "flashcards") {
          expect(component.componentShape).toBe("form_direction");
          if (filters.direction !== "random") {
            expect(component.direction).toBe(filters.direction);
          }
          if (filters.forms.length > 0) {
            expect(filters.forms).toContain(component.sourceField);
          }
        } else {
          expect(component.skillType).toBe(
            filters.mode === "bab"
              ? "bab_identification"
              : "root_identification",
          );
          // A promptable form must exist under the form filter.
          expect(
            allowedPromptForms(componentEntry, filters.forms).length,
          ).toBeGreaterThan(0);
        }

        // Entry axes: bāb, verb type, book pages.
        expect(matchesEntryFilters(componentEntry, filters)).toBe(true);
        if (filters.babs.length > 0) {
          expect(filters.babs).toContain(componentEntry.bab);
        }
        if (filters.verbTypes.length > 0) {
          expect(componentEntry.quiz_eligibility.verb_type).toBe(true);
          expect(filters.verbTypes).toContain(componentEntry.verb_type);
          expect(UNRESOLVED_IDS).not.toContain(componentEntry.id);
        }
        const { min, max } = filters.bookPages;
        if (min !== null) {
          expect(componentEntry.book_page).toBeGreaterThanOrEqual(min);
        }
        if (max !== null) {
          expect(componentEntry.book_page).toBeLessThanOrEqual(max);
        }
      }

      // State filtering: every survivor belongs to ≥1 selected class.
      const stateMatched = filterByStates(
        contentMatched,
        filters.states,
        stored,
        weakScores,
        NOW_MS,
      );
      if (filters.states.length > 0) {
        for (const component of stateMatched) {
          const classes = componentStateClasses(
            stored.get(component.key),
            weakScores.get(component.key) ?? 0,
            NOW_MS,
          );
          expect(classes.some((cls) => filters.states.includes(cls))).toBe(
            true,
          );
        }
      } else {
        expect(stateMatched).toEqual(contentMatched);
      }

      // Plan building: bounded by count, drawn from the matched set, prompt
      // forms eligible AND within the form filter; deterministic per seed.
      const config: CustomSessionConfig = {
        ...filters,
        count: 1 + rng.int(30),
        timed: false,
        perQuestionLimitMs: 20000,
        testMode: false,
      };
      const plan = buildCustomPlan(
        learnerEntries,
        config,
        stored,
        weakScores,
        `plan-seed-${index}`,
        NOW_MS,
      );
      expect(plan.length).toBeLessThanOrEqual(config.count);
      expect(plan.length).toBe(Math.min(config.count, stateMatched.length));
      const matchedKeys = new Set(stateMatched.map((c) => c.key));
      for (const item of plan) {
        // Re-derive the component key through the matched set membership:
        // every planned identity must correspond to a matched component.
        const found = stateMatched.find(
          (c) =>
            c.entryId === item.identity.entryId &&
            c.skillType === item.identity.skillType &&
            (c.sourceField ?? undefined) ===
              (item.identity.sourceField ?? undefined) &&
            (c.direction ?? undefined) ===
              (item.identity.direction ?? undefined),
        );
        expect(found).toBeDefined();
        expect(matchedKeys.has(found!.key)).toBe(true);
        if (item.promptForm !== undefined) {
          const itemEntry = entry(item.identity.entryId);
          expect(isFieldEligible(itemEntry, item.promptForm)).toBe(true);
          if (filters.forms.length > 0) {
            expect(filters.forms).toContain(item.promptForm);
          }
        }
      }
      const replay = buildCustomPlan(
        learnerEntries,
        config,
        stored,
        weakScores,
        `plan-seed-${index}`,
        NOW_MS,
      );
      expect(replay).toEqual(plan);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Targeted unit tests                                                 */
/* ------------------------------------------------------------------ */

describe("custom session filters — targeted behaviour", () => {
  it("root mode never yields the unresolved-root entries 369/372", () => {
    const matched = eligibleCustomComponents(learnerEntries, {
      ...OPEN_CUSTOM_FILTERS,
      mode: "root",
    });
    expect(matched.length).toBeGreaterThan(0);
    for (const component of matched) {
      expect(UNRESOLVED_IDS).not.toContain(component.entryId);
    }
  });

  it("a verb-type filter never matches an entry whose verb type is unverified", () => {
    for (const id of UNRESOLVED_IDS) {
      const unresolvedEntry = entry(id);
      expect(unresolvedEntry.quiz_eligibility.verb_type).toBe(false);
      expect(
        matchesEntryFilters(unresolvedEntry, {
          ...OPEN_CUSTOM_FILTERS,
          verbTypes: [unresolvedEntry.verb_type],
        }),
      ).toBe(false);
    }
  });

  it("the demonstrate case composes: one bāb + maṣdar recognition only", () => {
    const someBab = entry(1).bab;
    const matched = eligibleCustomComponents(learnerEntries, {
      ...OPEN_CUSTOM_FILTERS,
      mode: "mc",
      direction: "arabic_to_english",
      forms: ["masdar"],
      babs: [someBab],
    });
    expect(matched.length).toBeGreaterThan(0);
    for (const component of matched) {
      expect(component.sourceField).toBe("masdar");
      expect(component.direction).toBe("arabic_to_english");
      expect(entry(component.entryId).bab).toBe(someBab);
    }
  });

  it("book page range composes as an inclusive range", () => {
    const pages = learnerEntries.map((e) => e.book_page);
    const min = Math.min(...pages);
    const matched = eligibleCustomComponents(learnerEntries, {
      ...OPEN_CUSTOM_FILTERS,
      bookPages: { min, max: min },
    });
    expect(matched.length).toBeGreaterThan(0);
    for (const component of matched) {
      expect(entry(component.entryId).book_page).toBe(min);
    }
  });

  it("classifies component state classes (new/learning/mastered/weak/due)", () => {
    const dueCard: SchedulerCard = {
      stability: 1,
      difficulty: 5,
      dueAtMs: NOW_MS - 1000,
      state: "review",
      reps: 2,
      lapses: 0,
      scheduledDays: 1,
      learningSteps: 0,
      lastReviewAtMs: NOW_MS - 86_400_000,
    };
    const futureCard: SchedulerCard = { ...dueCard, dueAtMs: NOW_MS + 1000 };

    // Never reviewed → new only.
    expect(componentStateClasses(undefined, 0, NOW_MS)).toEqual(["new"]);
    // Learning, not due, no weakness evidence → learning only.
    expect(
      componentStateClasses(
        { componentKey: "k", fsrs: futureCard, learnerState: "learning" },
        0,
        NOW_MS,
      ),
    ).toEqual(["learning"]);
    // Learning + weak score + due → learning, weak and due all apply.
    expect(
      componentStateClasses(
        { componentKey: "k", fsrs: dueCard, learnerState: "learning" },
        0.6,
        NOW_MS,
      ),
    ).toEqual(["learning", "weak", "due"]);
    // needs_review is weakness evidence even at score zero.
    expect(
      componentStateClasses(
        { componentKey: "k", fsrs: futureCard, learnerState: "needs_review" },
        0,
        NOW_MS,
      ),
    ).toEqual(["weak"]);
    // Mastered is never weak, even with a positive score.
    expect(
      componentStateClasses(
        { componentKey: "k", fsrs: futureCard, learnerState: "mastered" },
        0.9,
        NOW_MS,
      ),
    ).toEqual(["mastered"]);
    // A STALE stored `mastered` whose due date has since passed is
    // needs_review NOW (§5): due + weak, never mastered — the stored
    // projection is only refreshed on writes, so the clock decides.
    expect(
      componentStateClasses(
        { componentKey: "k", fsrs: dueCard, learnerState: "mastered" },
        0,
        NOW_MS,
      ),
    ).toEqual(["weak", "due"]);
    // Same for a lapse into relearning, even before the next due date.
    expect(
      componentStateClasses(
        {
          componentKey: "k",
          fsrs: { ...futureCard, state: "relearning" },
          learnerState: "mastered",
        },
        0,
        NOW_MS,
      ),
    ).toEqual(["weak"]);
  });

  it("filterByStates unions the selected states", () => {
    const components = eligibleCustomComponents(
      learnerEntries,
      OPEN_CUSTOM_FILTERS,
    );
    const [first, second] = components;
    const stored = new Map<string, StoredComponentState>([
      [
        first.key,
        {
          componentKey: first.key,
          fsrs: {
            stability: 1,
            difficulty: 5,
            dueAtMs: NOW_MS - 1,
            state: "review",
            reps: 1,
            lapses: 0,
            scheduledDays: 1,
            learningSteps: 0,
            lastReviewAtMs: NOW_MS - 86_400_000,
          },
          learnerState: "learning",
        },
      ],
    ]);
    const weakScores = new Map<string, number>();
    const dueOrNew = filterByStates(
      [first, second],
      ["due", "new"] satisfies ComponentStateFilter[],
      stored,
      weakScores,
      NOW_MS,
    );
    // first is due (stored, past due date); second is new (never stored).
    expect(dueOrNew.map((c) => c.key)).toEqual([first.key, second.key]);
    const dueOnly = filterByStates(
      [first, second],
      ["due"],
      stored,
      weakScores,
      NOW_MS,
    );
    expect(dueOnly.map((c) => c.key)).toEqual([first.key]);
  });

  it("bāb/root prompt forms respect the form filter (no ineligible prompt)", () => {
    const config: CustomSessionConfig = {
      ...OPEN_CUSTOM_FILTERS,
      mode: "bab",
      forms: ["mudari", "masdar"] as SourceQuizFormField[],
      count: 50,
      timed: false,
      perQuestionLimitMs: 20000,
      testMode: false,
    };
    const plan = buildCustomPlan(
      learnerEntries,
      config,
      new Map(),
      new Map(),
      "bab-prompt-seed",
      NOW_MS,
    );
    expect(plan.length).toBeGreaterThan(0);
    for (const item of plan) {
      expect(["mudari", "masdar"]).toContain(item.promptForm);
      expect(
        isFieldEligible(entry(item.identity.entryId), item.promptForm!),
      ).toBe(true);
    }
  });

  it("buildCustomPlan rejects a non-positive count", () => {
    const config: CustomSessionConfig = {
      ...OPEN_CUSTOM_FILTERS,
      count: 0,
      timed: false,
      perQuestionLimitMs: 20000,
      testMode: false,
    };
    expect(() =>
      buildCustomPlan(
        learnerEntries,
        config,
        new Map(),
        new Map(),
        "seed",
        NOW_MS,
      ),
    ).toThrow(/positive integer/);
  });
});

describe("custom session filters — empty-result guard", () => {
  const emptyStates = {
    stored: new Map<string, StoredComponentState>(),
    weakScores: new Map<string, number>(),
    nowMs: NOW_MS,
  };

  it("suggests the single axis whose relaxation rescues the result", () => {
    // No stored state exists, so a mastered-only filter matches nothing;
    // relaxing the state filter alone rescues it.
    const filters: CustomSessionFilters = {
      ...OPEN_CUSTOM_FILTERS,
      states: ["mastered"],
    };
    expect(
      filterByStates(
        eligibleCustomComponents(learnerEntries, filters),
        filters.states,
        emptyStates.stored,
        emptyStates.weakScores,
        NOW_MS,
      ),
    ).toHaveLength(0);
    const suggestions = looseningSuggestions(
      learnerEntries,
      filters,
      emptyStates,
    );
    expect(suggestions.map((s) => s.axis)).toEqual(["states"]);
  });

  it("suggests loosening only axes that actually rescue the result", () => {
    // An impossible book-page range PLUS a mastered-only state filter: no
    // single relaxation rescues (both must go), so BOTH active axes are
    // suggested as the only actionable path.
    const filters: CustomSessionFilters = {
      ...OPEN_CUSTOM_FILTERS,
      states: ["mastered"],
      bookPages: { min: 100000, max: null },
    };
    const suggestions = looseningSuggestions(
      learnerEntries,
      filters,
      emptyStates,
    );
    expect(new Set(suggestions.map((s) => s.axis))).toEqual(
      new Set(["states", "bookPages"]),
    );
  });

  it("never suggests inactive axes", () => {
    const filters: CustomSessionFilters = {
      ...OPEN_CUSTOM_FILTERS,
      states: ["mastered"],
    };
    const suggestions = looseningSuggestions(
      learnerEntries,
      filters,
      emptyStates,
    );
    for (const suggestion of suggestions) {
      expect(suggestion.axis).not.toBe("babs");
      expect(suggestion.axis).not.toBe("forms");
    }
  });
});
