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
import type {
  CollectionFilter,
  CollectionMembership,
} from "@/modules/collections/filters";
import {
  matchesCollectionFilter,
  OPEN_COLLECTION_FILTER,
} from "@/modules/collections/filters";
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

/** A fixed pool of synthetic list ids the property test may select from. */
const SYNTHETIC_LIST_IDS = ["list-a", "list-b", "list-c"] as const;

/** A random bookmark/list membership snapshot over the real 455 entries. */
function randomMembership(rng: Rng): CollectionMembership {
  const bookmarkedEntryIds = new Set(
    learnerEntries.filter(() => rng.next() < 0.1).map((e) => e.id),
  );
  const listEntryIdsById = new Map(
    SYNTHETIC_LIST_IDS.map((id) => [
      id,
      new Set(learnerEntries.filter(() => rng.next() < 0.08).map((e) => e.id)),
    ]),
  );
  return { bookmarkedEntryIds, listEntryIdsById };
}

function randomCollectionFilter(rng: Rng): CollectionFilter {
  if (rng.next() < 0.5) return OPEN_COLLECTION_FILTER;
  return {
    includeBookmarks: rng.next() < 0.4,
    listIds: randomSubset(rng, SYNTHETIC_LIST_IDS, 0.3),
  };
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
    collections: randomCollectionFilter(rng),
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
      const membership = randomMembership(rng);
      const { stored, weakScores } = randomStoredState(rng);

      const contentMatched = eligibleCustomComponents(
        learnerEntries,
        filters,
        membership,
      );
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

        // Entry axes: bāb, verb type, book pages, collections.
        expect(matchesEntryFilters(componentEntry, filters, membership)).toBe(
          true,
        );
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
        // Collections axis (§19): union within the axis, and a match iff
        // matchesCollectionFilter independently agrees.
        expect(
          matchesCollectionFilter(
            componentEntry.id,
            filters.collections,
            membership,
          ),
        ).toBe(true);
        if (
          filters.collections.includeBookmarks ||
          filters.collections.listIds.length > 0
        ) {
          const inBookmarks =
            filters.collections.includeBookmarks &&
            membership.bookmarkedEntryIds.has(componentEntry.id);
          const inSelectedList = filters.collections.listIds.some((listId) =>
            membership.listEntryIdsById.get(listId)?.has(componentEntry.id),
          );
          expect(inBookmarks || inSelectedList).toBe(true);
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
        membership,
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
        membership,
      );
      expect(replay).toEqual(plan);
    }
  }, 60_000);
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
    // Phase 13: a needs_review projection with NO score evidence is no
    // longer auto-weak — an ordinary due-again mastered card with a clean
    // history must not be falsely called weak (phases-13.md §10 test 21).
    expect(
      componentStateClasses(
        { componentKey: "k", fsrs: futureCard, learnerState: "needs_review" },
        0,
        NOW_MS,
      ),
    ).toEqual([]);
    // ...but a needs_review projection WITH genuine score evidence (Phase 13
    // v2 already reflects a real lapse/failure in the score) still qualifies.
    expect(
      componentStateClasses(
        { componentKey: "k", fsrs: futureCard, learnerState: "needs_review" },
        0.5,
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
    // needs_review NOW (§5) — due, but NOT weak at score zero: an ordinary
    // due mastered card with no real lapse must not be falsely called weak.
    // The stored projection is only refreshed on writes, so the clock
    // decides state; weakness still requires genuine evidence.
    expect(
      componentStateClasses(
        { componentKey: "k", fsrs: dueCard, learnerState: "mastered" },
        0,
        NOW_MS,
      ),
    ).toEqual(["due"]);
    // A genuine lapse into relearning, with real score evidence, before the
    // next due date IS weak.
    expect(
      componentStateClasses(
        {
          componentKey: "k",
          fsrs: { ...futureCard, state: "relearning" },
          learnerState: "mastered",
        },
        0.3,
        NOW_MS,
      ),
    ).toEqual(["weak"]);
    // The same relearning card at score zero (e.g. stale/unavailable
    // evidence) is NOT falsely called weak.
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
    ).toEqual([]);
    // A structurally corrupt stored card matches NO state class — not even
    // "due", although its dueAtMs is in the past: corrupt data must never
    // satisfy an explicit state selection.
    expect(
      componentStateClasses(
        {
          componentKey: "k",
          fsrs: { ...dueCard, state: "zombie" as SchedulerCard["state"] },
          learnerState: "mastered",
        },
        0.9,
        NOW_MS,
      ),
    ).toEqual([]);
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

describe("custom session filters — collections axis (§19)", () => {
  const bookmarkedId = learnerEntries[0].id;
  const listOnlyId = learnerEntries[1].id;
  const otherListId = learnerEntries[2].id;
  const unselectedId = learnerEntries[3].id;
  const membership: CollectionMembership = {
    bookmarkedEntryIds: new Set([bookmarkedId]),
    listEntryIdsById: new Map([
      ["list-a", new Set([listOnlyId])],
      ["list-b", new Set([otherListId])],
    ]),
  };

  it("no selection keeps every entry eligible for the axis", () => {
    for (const id of [bookmarkedId, listOnlyId, otherListId, unselectedId]) {
      expect(
        matchesCollectionFilter(id, OPEN_COLLECTION_FILTER, membership),
      ).toBe(true);
    }
  });

  it("bookmarks-only selects exactly the bookmarked entries", () => {
    const filter: CollectionFilter = { includeBookmarks: true, listIds: [] };
    expect(matchesCollectionFilter(bookmarkedId, filter, membership)).toBe(
      true,
    );
    expect(matchesCollectionFilter(listOnlyId, filter, membership)).toBe(false);
    expect(matchesCollectionFilter(unselectedId, filter, membership)).toBe(
      false,
    );
  });

  it("a single list selects exactly that list's entries", () => {
    const filter: CollectionFilter = {
      includeBookmarks: false,
      listIds: ["list-a"],
    };
    expect(matchesCollectionFilter(listOnlyId, filter, membership)).toBe(true);
    expect(matchesCollectionFilter(otherListId, filter, membership)).toBe(
      false,
    );
  });

  it("multiple lists use union semantics", () => {
    const filter: CollectionFilter = {
      includeBookmarks: false,
      listIds: ["list-a", "list-b"],
    };
    expect(matchesCollectionFilter(listOnlyId, filter, membership)).toBe(true);
    expect(matchesCollectionFilter(otherListId, filter, membership)).toBe(true);
    expect(matchesCollectionFilter(unselectedId, filter, membership)).toBe(
      false,
    );
  });

  it("bookmarks plus a list use union semantics", () => {
    const filter: CollectionFilter = {
      includeBookmarks: true,
      listIds: ["list-a"],
    };
    expect(matchesCollectionFilter(bookmarkedId, filter, membership)).toBe(
      true,
    );
    expect(matchesCollectionFilter(listOnlyId, filter, membership)).toBe(true);
    expect(matchesCollectionFilter(otherListId, filter, membership)).toBe(
      false,
    );
  });

  it("an unknown selected list id matches nothing for that list", () => {
    const filter: CollectionFilter = {
      includeBookmarks: false,
      listIds: ["does-not-exist"],
    };
    for (const id of [bookmarkedId, listOnlyId, otherListId, unselectedId]) {
      expect(matchesCollectionFilter(id, filter, membership)).toBe(false);
    }
  });

  it("collections AND bāb use intersection semantics", () => {
    const babEntry = entry(bookmarkedId);
    const matched = eligibleCustomComponents(
      learnerEntries,
      {
        ...OPEN_CUSTOM_FILTERS,
        babs: [babEntry.bab],
        collections: { includeBookmarks: true, listIds: [] },
      },
      membership,
    );
    expect(matched.length).toBeGreaterThan(0);
    for (const component of matched) {
      expect(component.entryId).toBe(bookmarkedId);
      expect(entry(component.entryId).bab).toBe(babEntry.bab);
    }
  });

  it("input order of the membership build never affects the matched set", () => {
    const forwardOrder = eligibleCustomComponents(
      learnerEntries,
      {
        ...OPEN_CUSTOM_FILTERS,
        collections: { includeBookmarks: true, listIds: ["list-a", "list-b"] },
      },
      membership,
    );
    const reorderedMembership: CollectionMembership = {
      bookmarkedEntryIds: membership.bookmarkedEntryIds,
      listEntryIdsById: new Map(
        [...membership.listEntryIdsById.entries()].reverse(),
      ),
    };
    const reorderedSelection = eligibleCustomComponents(
      learnerEntries,
      {
        ...OPEN_CUSTOM_FILTERS,
        collections: { includeBookmarks: true, listIds: ["list-b", "list-a"] },
      },
      reorderedMembership,
    );
    expect(reorderedSelection.map((c) => c.key).sort()).toEqual(
      forwardOrder.map((c) => c.key).sort(),
    );
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
      expect(suggestion.axis).not.toBe("collections");
    }
  });

  it("an explicitly selected empty collection produces no entries, not 'any'", () => {
    // A real list id with zero resolvable members: an explicit selection
    // must never silently fall back to unrestricted.
    const membership: CollectionMembership = {
      bookmarkedEntryIds: new Set(),
      listEntryIdsById: new Map([["empty-list", new Set()]]),
    };
    const filters: CustomSessionFilters = {
      ...OPEN_CUSTOM_FILTERS,
      collections: { includeBookmarks: false, listIds: ["empty-list"] },
    };
    expect(
      eligibleCustomComponents(learnerEntries, filters, membership),
    ).toHaveLength(0);
  });

  it("suggests relaxing the collections axis when it is the sole blocker", () => {
    const membership: CollectionMembership = {
      bookmarkedEntryIds: new Set(),
      listEntryIdsById: new Map([["empty-list", new Set()]]),
    };
    const filters: CustomSessionFilters = {
      ...OPEN_CUSTOM_FILTERS,
      collections: { includeBookmarks: false, listIds: ["empty-list"] },
    };
    const suggestions = looseningSuggestions(
      learnerEntries,
      filters,
      emptyStates,
      membership,
    );
    expect(suggestions.map((s) => s.axis)).toEqual(["collections"]);
  });
});
