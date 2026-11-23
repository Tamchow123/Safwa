import { describe, expect, it } from "vitest";

import { DEFAULT_DAILY_TARGETS } from "@/modules/scheduler/due";
import {
  newCard,
  reviewCard,
  type SchedulerCard,
} from "@/modules/scheduler/fsrs";
import {
  deriveComponentsForEntry,
  isComponentEligible,
} from "@/modules/study-engine/components";
import { buildComponentKey } from "@/modules/study-engine/natural-key";
import {
  buildMixedPlan,
  defaultEntryPromptForm,
  MIN_NEW_WORDS_PER_DAY,
  newWordsIntroducedOn,
  remainingDailyTargets,
  type SchedulingEventSummary,
  type StoredComponentState,
} from "@/modules/study-session/mixed";
import { chainForEntry } from "@/modules/study-session/skill-chain";

import { entriesById, entry, learnerEntries } from "../study-engine/fixtures";

const NOW = Date.UTC(2026, 6, 17, 12, 0, 0);

function cardDueAt(dueAtMs: number): SchedulerCard {
  return {
    ...reviewCard(newCard(dueAtMs - 1000), dueAtMs - 1000, "good"),
    dueAtMs,
  };
}

describe("remainingDailyTargets (per-day accounting)", () => {
  const TODAY = "2026-07-17";

  function schedulingEvent(
    overrides: Partial<SchedulingEventSummary> = {},
  ): SchedulingEventSummary {
    return {
      componentKey: "c",
      parentEventId: null,
      status: "scheduling",
      localDateAtEvent: TODAY,
      ...overrides,
    };
  }

  it("chain-root events consume the new budget; later events the review budget", () => {
    const events = [
      schedulingEvent({ componentKey: "a" }), // introduced today
      schedulingEvent({ componentKey: "b" }), // introduced today
      schedulingEvent({ componentKey: "a", parentEventId: "e1" }), // review
    ];
    expect(
      remainingDailyTargets(events, TODAY, { newLimit: 10, reviewLimit: 20 }),
    ).toEqual({ newLimit: 8, reviewLimit: 19 });
  });

  it("events from other local dates never consume today's budget", () => {
    const events = [
      schedulingEvent({ localDateAtEvent: "2026-07-16" }),
      schedulingEvent({ parentEventId: "e1", localDateAtEvent: "2026-07-16" }),
      schedulingEvent({ localDateAtEvent: null }),
    ];
    expect(remainingDailyTargets(events, TODAY)).toEqual(DEFAULT_DAILY_TARGETS);
  });

  it("non-scheduling events never consume budget", () => {
    const events = [
      schedulingEvent({ status: "reinforcement" }),
      schedulingEvent({ status: null }),
    ];
    expect(remainingDailyTargets(events, TODAY)).toEqual(DEFAULT_DAILY_TARGETS);
  });

  it("a corrupt scheduling row without a readable parent link consumes nothing", () => {
    // readSchedulingSnapshot passes parentEventId through unmapped, so a
    // malformed Dexie row surfaces here as undefined (not null). The shared
    // classifier must refuse to count it as either a new item or a review.
    const events = [
      schedulingEvent({
        parentEventId: undefined as unknown as string | null,
      }),
    ];
    expect(remainingDailyTargets(events, TODAY)).toEqual(DEFAULT_DAILY_TARGETS);
  });

  it("clamps at zero once a day's budget is exhausted", () => {
    const events = Array.from({ length: 15 }, (_, index) =>
      schedulingEvent({ componentKey: `c-${index}` }),
    );
    expect(
      remainingDailyTargets(events, TODAY, { newLimit: 10, reviewLimit: 20 }),
    ).toEqual({ newLimit: 0, reviewLimit: 20 });
  });

  it("an undone event (removed from the store) refunds its budget", () => {
    const before = [
      schedulingEvent({ componentKey: "a" }),
      schedulingEvent({ componentKey: "b" }),
    ];
    // Undo deletes b's event; recomputation sees one introduction only.
    const after = before.slice(0, 1);
    expect(remainingDailyTargets(after, TODAY).newLimit).toBe(
      remainingDailyTargets(before, TODAY).newLimit + 1,
    );
  });

  it("feeds buildMixedPlan: exhausted budgets yield no new items", () => {
    const events = Array.from({ length: 10 }, (_, index) =>
      schedulingEvent({ componentKey: `c-${index}` }),
    );
    const targets = remainingDailyTargets(events, TODAY);
    expect(targets.newLimit).toBe(0);
    const plan = buildMixedPlan(learnerEntries, [], new Map(), NOW, targets);
    // No stored cards → nothing due/weak, and the new budget is spent.
    expect(plan).toHaveLength(0);
  });
});

describe("defaultEntryPromptForm", () => {
  it("prefers the māḍī when eligible", () => {
    expect(defaultEntryPromptForm(entry(1))).toBe("madi");
  });

  it("is always an eligible form (or null) for every entry", () => {
    for (const candidate of learnerEntries) {
      const form = defaultEntryPromptForm(candidate);
      if (form !== null) {
        expect(candidate.quiz_eligibility[form]).toBe(true);
      }
    }
  });
});

describe("buildMixedPlan (due → weak → new, seeded fixture)", () => {
  // Real component keys from the loaded release, used as the seeded fixture.
  const babKey = (entryId: number) =>
    buildComponentKey({ entryId, skillType: "bab_identification" });
  const recognitionKey = (entryId: number) =>
    buildComponentKey({
      entryId,
      skillType: "meaning_recognition",
      sourceField: "madi",
      direction: "arabic_to_english",
    });

  it("a brand-new guest (no stored state) gets a plan of new items", () => {
    const plan = buildMixedPlan(learnerEntries, [], new Map(), NOW);
    expect(plan).toHaveLength(DEFAULT_DAILY_TARGETS.newLimit);
    for (const item of plan) {
      const source = entriesById.get(item.identity.entryId)!;
      expect(isComponentEligible(source, item.identity)).toBe(true);
    }
  });

  it("orders due before weak before new, within the given targets", () => {
    const due = recognitionKey(1);
    const weakHigh = babKey(2);
    const weakLow = recognitionKey(3);
    const stored: StoredComponentState[] = [
      {
        componentKey: due,
        fsrs: cardDueAt(NOW - 1000),
        learnerState: "learning",
      },
      {
        componentKey: weakHigh,
        fsrs: cardDueAt(NOW + 100_000),
        learnerState: "learning",
      },
      {
        componentKey: weakLow,
        fsrs: cardDueAt(NOW + 100_000),
        learnerState: "learning",
      },
    ];
    const weakScores = new Map([
      [weakHigh, 0.9],
      [weakLow, 0.4],
    ]);
    const plan = buildMixedPlan(learnerEntries, stored, weakScores, NOW, {
      newLimit: 2,
      reviewLimit: 3,
    });
    const keys = plan.map((item) => buildComponentKey(item.identity));
    // due (most overdue first) → weak (weakest first) → new (2 items).
    expect(keys.slice(0, 3)).toEqual([due, weakHigh, weakLow]);
    expect(plan).toHaveLength(5);
    // The new-tier items are never ones that already have a card.
    for (const key of keys.slice(3)) {
      expect(stored.some((record) => record.componentKey === key)).toBe(false);
    }
  });

  it("mastered non-due components are not selected as weak", () => {
    const mastered = recognitionKey(1);
    const stored: StoredComponentState[] = [
      {
        componentKey: mastered,
        fsrs: cardDueAt(NOW + 100_000),
        learnerState: "mastered",
      },
    ];
    const plan = buildMixedPlan(
      learnerEntries,
      stored,
      new Map([[mastered, 1]]),
      NOW,
      { newLimit: 0, reviewLimit: 10 },
    );
    expect(plan.map((item) => buildComponentKey(item.identity))).not.toContain(
      mastered,
    );
  });

  it("drops stored components that are no longer derivable (stale/ineligible)", () => {
    // Entry 369's root component is not derivable (root unverified) — a stored
    // card for it must never be planned.
    const stale: StoredComponentState = {
      componentKey: "entry:369:skill:root_identification",
      fsrs: cardDueAt(NOW - 1000),
      learnerState: "learning",
    };
    const plan = buildMixedPlan(learnerEntries, [stale], new Map(), NOW);
    expect(plan.map((item) => buildComponentKey(item.identity))).not.toContain(
      stale.componentKey,
    );
  });

  it("entry-level items carry an eligible prompt form; translations carry none", () => {
    const dueBab = babKey(1);
    const dueTranslation = recognitionKey(2);
    const stored: StoredComponentState[] = [
      {
        componentKey: dueBab,
        fsrs: cardDueAt(NOW - 2000),
        learnerState: "learning",
      },
      {
        componentKey: dueTranslation,
        fsrs: cardDueAt(NOW - 1000),
        learnerState: "learning",
      },
    ];
    const plan = buildMixedPlan(learnerEntries, stored, new Map(), NOW, {
      newLimit: 0,
      reviewLimit: 2,
    });
    expect(plan).toHaveLength(2);
    const [babItem, translationItem] = plan;
    expect(buildComponentKey(babItem.identity)).toBe(dueBab);
    expect(babItem.promptForm).toBe("madi");
    expect(buildComponentKey(translationItem.identity)).toBe(dueTranslation);
    expect(translationItem.promptForm).toBeUndefined();
  });

  it("a higher injected weak score outranks a lower one within the weak tier", () => {
    // buildMixedPlan has no weakness algorithm of its own (Phase 13): the
    // caller (mixed-session.tsx) injects the v2 score via `qualifyingWeaknessScore`
    // — this test only proves the plan orders the weak tier by whatever score
    // it is given.
    const often = babKey(4);
    const rarely = babKey(5);
    const stored: StoredComponentState[] = [
      {
        componentKey: often,
        fsrs: cardDueAt(NOW + 100_000),
        learnerState: "learning",
      },
      {
        componentKey: rarely,
        fsrs: cardDueAt(NOW + 100_000),
        learnerState: "learning",
      },
    ];
    const weakScores = new Map([
      [often, 1],
      [rarely, 0.5],
    ]);
    const plan = buildMixedPlan(learnerEntries, stored, weakScores, NOW, {
      newLimit: 0,
      reviewLimit: 2,
    });
    expect(plan.map((item) => buildComponentKey(item.identity))).toEqual([
      often,
      rarely,
    ]);
  });

  it("caps one session at the default 20 questions, reviews making the cut first", () => {
    // A full review tier (20 due) PLUS an untouched new-item budget: the
    // session must still be 20 questions (§4.4 default), filled by the due
    // reviews — the 10 new items the daily budget would allow don't fit in
    // this sitting.
    const dueKeys = learnerEntries
      .slice(0, 20)
      .map((source) => recognitionKey(source.id));
    const stored: StoredComponentState[] = dueKeys.map(
      (componentKey, index) => ({
        componentKey,
        fsrs: cardDueAt(NOW - (index + 1) * 1000),
        learnerState: "learning",
      }),
    );
    const plan = buildMixedPlan(learnerEntries, stored, new Map(), NOW);
    expect(plan).toHaveLength(20);
    const keys = plan.map((item) => buildComponentKey(item.identity));
    expect(new Set(keys)).toEqual(new Set(dueKeys));

    // An explicit larger session limit admits the new tier again.
    const larger = buildMixedPlan(
      learnerEntries,
      stored,
      new Map(),
      NOW,
      DEFAULT_DAILY_TARGETS,
      30,
    );
    expect(larger).toHaveLength(30);
  });

  it("rejects a non-positive session limit", () => {
    expect(() =>
      buildMixedPlan(
        learnerEntries,
        [],
        new Map(),
        NOW,
        DEFAULT_DAILY_TARGETS,
        0,
      ),
    ).toThrow();
  });

  it("spreads a brand-new session across distinct entries — recognition first, māḍī preferred", () => {
    // Tests 1/3/4 of the correction: multiple distinct entries, every unseen
    // entry starting with an Arabic→English recognition component, māḍī when
    // eligible (it is, for every entry in the release).
    const plan = buildMixedPlan(learnerEntries, [], new Map(), NOW);
    expect(plan).toHaveLength(DEFAULT_DAILY_TARGETS.newLimit);
    const entryIds = new Set(plan.map((item) => item.identity.entryId));
    expect(entryIds.size).toBe(DEFAULT_DAILY_TARGETS.newLimit); // one per entry
    for (const item of plan) {
      expect(item.identity.skillType).toBe("meaning_recognition");
      expect(item.identity.direction).toBe("arabic_to_english");
      expect(item.identity.sourceField).toBe("madi");
    }
  });

  it("with ten available entries, the ten new questions never concentrate on one entry", () => {
    const tenEntries = learnerEntries.slice(0, 10);
    const plan = buildMixedPlan(tenEntries, [], new Map(), NOW);
    expect(plan).toHaveLength(10);
    expect(new Set(plan.map((item) => item.identity.entryId)).size).toBe(10);
  });

  it("a brand-new word gets only its first skill, however large the budget", () => {
    // Two entries, room for forty: nothing has been answered correctly on two
    // days yet, so neither word's second skill is unlocked.
    const twoEntries = learnerEntries.slice(0, 2);
    const plan = buildMixedPlan(
      twoEntries,
      [],
      new Map(),
      NOW,
      { newLimit: 40, reviewLimit: 0 },
      40,
    );
    expect(plan.map((item) => buildComponentKey(item.identity))).toEqual(
      twoEntries.map((source) => recognitionKey(source.id)),
    );
  });

  it("entry order follows source order, not raw key string order (1/10/100/101)", () => {
    // Unpadded ids sort entry:100 before entry:10 before entry:1 as strings;
    // the policy must follow the release's source order instead.
    const wanted = new Set([1, 10, 100, 101]);
    const subset = learnerEntries.filter((source) => wanted.has(source.id));
    expect(subset.map((source) => source.id)).toEqual([1, 10, 100, 101]);
    const plan = buildMixedPlan(subset, [], new Map(), NOW, {
      newLimit: 4,
      reviewLimit: 0,
    });
    const planEntryOrder = plan.map((item) => item.identity.entryId);
    expect(planEntryOrder).toEqual([1, 10, 100, 101]);
    // …which is NOT what raw (codepoint) key order would produce: ":" sorts
    // above "0", so entry:100/101 keys precede entry:10 and entry:1 keys.
    const keyOrder = plan
      .map((item) => buildComponentKey(item.identity))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((key) => Number(/^entry:(\d+):/.exec(key)![1]));
    expect(keyOrder).toEqual([100, 101, 10, 1]);
    expect(planEntryOrder).not.toEqual(keyOrder);
  });

  it("never introduces an entry with no essential recognition — not even through an extended skill", () => {
    // Synthetic (currently unreachable) release state: every essential
    // recognition field ineligible, ism al-fāʿil the only recognition left.
    // The word has no chain, and extended skills stay in the focused modes,
    // so Start studying opens it neither with ṣarf nor with ism al-fāʿil.
    const base = entry(1);
    const synthetic = {
      ...base,
      quiz_eligibility: {
        ...base.quiz_eligibility,
        madi: false,
        mudari: false,
        masdar: false,
        amr: false,
        nahi: false,
        ism_fail: true,
      },
    };
    const derived = deriveComponentsForEntry(synthetic);
    // Not vacuous: the entry still has a bāb and an ism al-fāʿil recognition.
    expect(derived.map((c) => c.skillType)).toContain("bab_identification");
    expect(
      derived.some(
        (c) =>
          c.skillType === "meaning_recognition" && c.sourceField === "ism_fail",
      ),
    ).toBe(true);
    const plan = buildMixedPlan([synthetic], [], new Map(), NOW, {
      newLimit: 10,
      reviewLimit: 0,
    });
    expect(plan).toEqual([]);
  });

  it("a score-zero, non-due learning component is not selected as weak", () => {
    const fine = recognitionKey(1);
    const stored: StoredComponentState[] = [
      {
        componentKey: fine,
        fsrs: cardDueAt(NOW + 100_000),
        learnerState: "learning",
      },
    ];
    // No weakness evidence, new budget zero: nothing to study.
    const plan = buildMixedPlan(learnerEntries, stored, new Map(), NOW, {
      newLimit: 0,
      reviewLimit: 10,
    });
    expect(plan).toHaveLength(0);
  });

  it("a non-due component with a recent incorrect first attempt IS selected as weak", () => {
    const struggling = recognitionKey(1);
    const stored: StoredComponentState[] = [
      {
        componentKey: struggling,
        fsrs: cardDueAt(NOW + 100_000),
        learnerState: "learning",
      },
    ];
    const weakScores = new Map([[struggling, 1]]);
    const plan = buildMixedPlan(learnerEntries, stored, weakScores, NOW, {
      newLimit: 0,
      reviewLimit: 10,
    });
    expect(plan.map((item) => buildComponentKey(item.identity))).toEqual([
      struggling,
    ]);
  });

  it("a due score-zero component is still selected — due outranks the weak rule", () => {
    const due = recognitionKey(1);
    const stored: StoredComponentState[] = [
      {
        componentKey: due,
        fsrs: cardDueAt(NOW - 1000),
        learnerState: "learning",
      },
    ];
    const plan = buildMixedPlan(learnerEntries, stored, new Map(), NOW, {
      newLimit: 0,
      reviewLimit: 10,
    });
    expect(plan.map((item) => buildComponentKey(item.identity))).toEqual([due]);
  });

  it("a non-due needs_review component at score zero is NOT falsely selected as weak", () => {
    // Phase 13: needs_review alone is no longer a second, independent weak
    // trigger — an ordinary due-again mastered card with a clean history
    // (no real lapse/failure evidence, hence weakScore 0) must not be
    // mislabelled weak (phases-13.md §10 test 21, §12.6).
    const dueAgain = recognitionKey(1);
    const stored: StoredComponentState[] = [
      {
        componentKey: dueAgain,
        fsrs: cardDueAt(NOW + 100_000),
        learnerState: "needs_review",
      },
    ];
    const plan = buildMixedPlan(learnerEntries, stored, new Map(), NOW, {
      newLimit: 0,
      reviewLimit: 10,
    });
    expect(plan.map((item) => buildComponentKey(item.identity))).not.toContain(
      dueAgain,
    );
  });

  it("a non-due needs_review component WITH real weak-score evidence is selected as weak", () => {
    const lapsed = recognitionKey(1);
    const stored: StoredComponentState[] = [
      {
        componentKey: lapsed,
        fsrs: cardDueAt(NOW + 100_000),
        learnerState: "needs_review",
      },
    ];
    const weakScores = new Map([[lapsed, 0.6]]);
    const plan = buildMixedPlan(learnerEntries, stored, weakScores, NOW, {
      newLimit: 0,
      reviewLimit: 10,
    });
    expect(plan.map((item) => buildComponentKey(item.identity))).toEqual([
      lapsed,
    ]);
  });

  it("a non-due, non-mastered component with a positive injected weak score is selected as weak", () => {
    // Whether reinforcement erases weakness evidence is now decided entirely
    // upstream (modules/analytics/weakness-evidence.ts §8,
    // modules/analytics/weakness.ts §24.4) — this pure planner only proves it
    // honours whatever score the caller injects.
    const struggled = recognitionKey(1);
    const stored: StoredComponentState[] = [
      {
        componentKey: struggled,
        fsrs: cardDueAt(NOW + 100_000),
        learnerState: "learning",
      },
    ];
    const weakScores = new Map([[struggled, 1]]);
    const plan = buildMixedPlan(learnerEntries, stored, weakScores, NOW, {
      newLimit: 0,
      reviewLimit: 10,
    });
    expect(plan.map((item) => buildComponentKey(item.identity))).toEqual([
      struggled,
    ]);
  });

  it("is deterministic in its inputs", () => {
    const stored: StoredComponentState[] = [
      {
        componentKey: recognitionKey(1),
        fsrs: cardDueAt(NOW - 1000),
        learnerState: "learning",
      },
    ];
    const a = buildMixedPlan(learnerEntries, stored, new Map(), NOW);
    const b = buildMixedPlan(learnerEntries, stored, new Map(), NOW);
    expect(a).toEqual(b);
  });
});

describe("the skill-chain new tier (Phase 18.5)", () => {
  const NOT_DUE = NOW + 30 * 86_400_000;
  const keysOf = (plan: ReturnType<typeof buildMixedPlan>) =>
    plan.map((item) => buildComponentKey(item.identity));
  const chainKeys = (id: number) =>
    chainForEntry(deriveComponentsForEntry(entry(id))).map((c) => c.key);
  /** A started, not-due skill — qualifying for the next one or not. */
  const started = (
    componentKey: string,
    qualifiesForNextSkill: boolean,
  ): StoredComponentState => ({
    componentKey,
    fsrs: cardDueAt(NOT_DUE),
    learnerState: "learning",
    qualifiesForNextSkill,
  });
  const ids = learnerEntries.map((source) => source.id);
  const NEW_ONLY = { newLimit: 10, reviewLimit: 0 };

  it("walks one word through the owner's chain, one qualified skill at a time", () => {
    const words = [entry(1)];
    const chain = chainKeys(1);
    expect(chain).toHaveLength(6);
    const stored: StoredComponentState[] = [];
    for (const expected of chain) {
      const plan = buildMixedPlan(words, stored, new Map(), NOW, NEW_ONLY);
      expect(keysOf(plan)).toEqual([expected]);
      stored.push(started(expected, true));
    }
    // The chain is done: the word's extended skills are never introduced…
    expect(buildMixedPlan(words, stored, new Map(), NOW, NEW_ONLY)).toEqual([]);
    // …though it has some (the assertion above is not vacuous).
    expect(deriveComponentsForEntry(entry(1)).length).toBeGreaterThan(
      chain.length,
    );
  });

  it("a started skill that has not qualified keeps the word's next skill locked", () => {
    const plan = buildMixedPlan(
      [entry(1)],
      [started(chainKeys(1)[0], false)],
      new Map(),
      NOW,
      NEW_ONLY,
    );
    expect(plan).toEqual([]);
  });

  it("skips a skill the entry cannot be quizzed on (hard rule 2)", () => {
    const base = entry(1);
    const noMasdar = {
      ...base,
      quiz_eligibility: { ...base.quiz_eligibility, masdar: false },
    };
    const chain = chainForEntry(deriveComponentsForEntry(noMasdar)).map(
      (c) => c.key,
    );
    // māḍī recognition, māḍī recall, bāb and muḍāriʿ recognition started and
    // qualified: the root is next, the maṣdar never offered.
    const stored = chain.slice(0, 4).map((key) => started(key, true));
    const plan = buildMixedPlan([noMasdar], stored, new Map(), NOW, NEW_ONLY);
    expect(plan.map((item) => item.identity.skillType)).toEqual([
      "root_identification",
    ]);
  });

  it(`next skills first, but at least ${MIN_NEW_WORDS_PER_DAY} new words a day`, () => {
    // Ten words started, each ready for its English→Arabic recall.
    const startedIds = ids.slice(0, 10);
    const stored = startedIds.map((id) => started(chainKeys(id)[0], true));
    const plan = buildMixedPlan(
      learnerEntries,
      stored,
      new Map(),
      NOW,
      NEW_ONLY,
    );
    expect(keysOf(plan)).toEqual([
      // the owed new words, in source order…
      ...ids
        .slice(10, 10 + MIN_NEW_WORDS_PER_DAY)
        .map((id) => chainKeys(id)[0]),
      // …then the next skills, in source order.
      ...startedIds
        .slice(0, 10 - MIN_NEW_WORDS_PER_DAY)
        .map((id) => chainKeys(id)[1]),
    ]);
  });

  it("new words already introduced today count towards the floor", () => {
    const startedIds = ids.slice(0, 10);
    const stored = startedIds.map((id) => started(chainKeys(id)[0], true));
    const plan = buildMixedPlan(
      learnerEntries,
      stored,
      new Map(),
      NOW,
      NEW_ONLY,
      20,
      MIN_NEW_WORDS_PER_DAY,
    );
    expect(keysOf(plan)).toEqual(startedIds.map((id) => chainKeys(id)[1]));
  });

  it("spare budget goes to more new words when few next skills are waiting", () => {
    const stored = ids.slice(0, 2).map((id) => started(chainKeys(id)[0], true));
    const plan = buildMixedPlan(
      learnerEntries,
      stored,
      new Map(),
      NOW,
      NEW_ONLY,
    );
    const newWords = ids.slice(2, 10).map((id) => chainKeys(id)[0]);
    expect(keysOf(plan)).toEqual([
      ...newWords.slice(0, MIN_NEW_WORDS_PER_DAY),
      chainKeys(ids[0])[1],
      chainKeys(ids[1])[1],
      ...newWords.slice(MIN_NEW_WORDS_PER_DAY),
    ]);
  });

  it("the floor never exceeds what is left of the day's new budget", () => {
    const stored = ids
      .slice(0, 10)
      .map((id) => started(chainKeys(id)[0], true));
    const plan = buildMixedPlan(learnerEntries, stored, new Map(), NOW, {
      newLimit: 2,
      reviewLimit: 0,
    });
    expect(keysOf(plan)).toEqual(
      ids.slice(10, 12).map((id) => chainKeys(id)[0]),
    );
  });

  it("orders next skills by chain step first: every recall before any bāb", () => {
    // Word A is ready for its bāb; word B (later in source order) for its
    // recall. B's earlier step goes first.
    const [a, b] = [ids[0], ids[1]];
    const stored = [
      started(chainKeys(a)[0], true),
      started(chainKeys(a)[1], true),
      started(chainKeys(b)[0], true),
    ];
    const plan = buildMixedPlan(
      [entry(a), entry(b)],
      stored,
      new Map(),
      NOW,
      NEW_ONLY,
      20,
      MIN_NEW_WORDS_PER_DAY,
    );
    expect(keysOf(plan)).toEqual([chainKeys(b)[1], chainKeys(a)[2]]);
  });

  it("a word practised only in a focused mode is still new to Start studying", () => {
    // Its bāb was answered in the Bāb quiz; Start studying still opens the
    // word with its māḍī recognition, as one of today's owed new words —
    // ahead of the ten next skills waiting behind it.
    const focused = ids[1];
    const stored = [
      started(chainKeys(focused)[2], true),
      ...ids.slice(2, 12).map((id) => started(chainKeys(id)[0], true)),
    ];
    const plan = buildMixedPlan(
      [entry(focused), ...ids.slice(2, 12).map(entry)],
      stored,
      new Map(),
      NOW,
      { newLimit: 1, reviewLimit: 0 },
    );
    expect(keysOf(plan)).toEqual([chainKeys(focused)[0]]);
    // Once today's floor is met it is an EXTRA new word, behind every next
    // skill — not a next skill of a started word, which would lead.
    const floorMet = buildMixedPlan(
      [entry(focused), ...ids.slice(2, 12).map(entry)],
      stored,
      new Map(),
      NOW,
      { newLimit: 11, reviewLimit: 0 },
      20,
      MIN_NEW_WORDS_PER_DAY,
    );
    expect(keysOf(floorMet)).toEqual([
      ...ids.slice(2, 12).map((id) => chainKeys(id)[1]),
      chainKeys(focused)[0],
    ]);
  });

  it("due reviews still come first; the new tier only fills what is left", () => {
    const dueKey = chainKeys(ids[0])[0];
    const stored: StoredComponentState[] = [
      {
        componentKey: dueKey,
        fsrs: cardDueAt(NOW - 1000),
        learnerState: "learning",
        qualifiesForNextSkill: true,
      },
    ];
    const plan = buildMixedPlan(
      learnerEntries,
      stored,
      new Map(),
      NOW,
      { newLimit: 10, reviewLimit: 10 },
      2,
    );
    expect(keysOf(plan)).toEqual([dueKey, chainKeys(ids[1])[0]]);
  });
});

describe("newWordsIntroducedOn (Phase 18.5)", () => {
  const TODAY = "2026-07-17";
  const chainKey = (id: number, step: number) =>
    chainForEntry(deriveComponentsForEntry(entry(id)))[step].key;
  function event(
    componentKey: string,
    overrides: Partial<SchedulingEventSummary> = {},
  ): SchedulingEventSummary {
    return {
      componentKey,
      parentEventId: null,
      status: "scheduling",
      localDateAtEvent: TODAY,
      ...overrides,
    };
  }

  it("counts today's introductions of a word's first skill, once each", () => {
    const events = [
      event(chainKey(1, 0)),
      event(chainKey(1, 0), { parentEventId: "e1" }), // a review of it
      event(chainKey(2, 0)),
    ];
    expect(newWordsIntroducedOn(events, TODAY, learnerEntries)).toBe(2);
  });

  it("a word with two roots (a guest→account merge) is still one word", () => {
    const events = [event(chainKey(1, 0)), event(chainKey(1, 0))];
    expect(newWordsIntroducedOn(events, TODAY, learnerEntries)).toBe(1);
  });

  it("ignores later chain skills, other dates and non-scheduling events", () => {
    const events = [
      event(chainKey(1, 1)),
      event(chainKey(2, 0), { localDateAtEvent: "2026-07-16" }),
      event(chainKey(3, 0), { status: "reinforcement" }),
      event(chainKey(4, 0), { localDateAtEvent: null }),
    ];
    expect(newWordsIntroducedOn(events, TODAY, learnerEntries)).toBe(0);
  });

  it("an undone introduction (its event removed) gives the floor back", () => {
    const events = [event(chainKey(1, 0)), event(chainKey(2, 0))];
    expect(newWordsIntroducedOn(events, TODAY, learnerEntries)).toBe(2);
    expect(newWordsIntroducedOn(events.slice(1), TODAY, learnerEntries)).toBe(
      1,
    );
  });
});
