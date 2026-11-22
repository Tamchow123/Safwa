import { describe, expect, it } from "vitest";

import {
  computeProgressSummary,
  effectiveComponents,
} from "@/modules/analytics/progress";
import {
  newCard,
  reviewCard,
  type SchedulerCard,
} from "@/modules/scheduler/fsrs";
import { deriveComponentsForEntry } from "@/modules/study-engine/components";
import { buildComponentKey } from "@/modules/study-engine/natural-key";
import { entryProgress } from "@/modules/study-session/entry-progress";
import {
  buildMixedPlan,
  type StoredComponentState,
} from "@/modules/study-session/mixed";
import { chainForEntry } from "@/modules/study-session/skill-chain";

import { entry } from "../study-engine/fixtures";

const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const DAY = 86_400_000;

function cardDueAt(dueAtMs: number): SchedulerCard {
  return {
    ...reviewCard(newCard(dueAtMs - 1000), dueAtMs - 1000, "good"),
    dueAtMs,
  };
}

const word = entry(1);
const chainKeys = chainForEntry(deriveComponentsForEntry(word)).map(
  (c) => c.key,
);
const verbTypeKey = deriveComponentsForEntry(word).find(
  (c) => c.skillType === "verb_type_identification",
)!.key;

function started(
  componentKey: string,
  overrides: Partial<StoredComponentState> = {},
): StoredComponentState {
  return {
    componentKey,
    fsrs: cardDueAt(NOW + 5 * DAY),
    learnerState: "learning",
    ...overrides,
  };
}

describe("entryProgress (Phase 18.5)", () => {
  it("a brand-new word: not started, its first skill next up, the rest locked", () => {
    const progress = entryProgress(word, [], NOW);
    expect(progress.wordState).toBe("not_started");
    expect(progress.chain.map((skill) => skill.component.key)).toEqual(
      chainKeys,
    );
    expect(progress.chain.map((skill) => skill.status)).toEqual([
      "next",
      "locked",
      "locked",
      "locked",
      "locked",
      "locked",
    ]);
    expect(progress.chain.every((s) => s.state === "not_started")).toBe(true);
    expect(progress.alsoPractised).toEqual([]);
  });

  it("a started skill shows its state; it unlocks the next only once it qualifies", () => {
    const waiting = entryProgress(word, [started(chainKeys[0])], NOW);
    expect(waiting.wordState).toBe("learning");
    expect(waiting.chain[0]).toMatchObject({
      status: "started",
      state: "learning",
    });
    expect(waiting.chain[1].status).toBe("locked");

    const unlocked = entryProgress(
      word,
      [started(chainKeys[0], { qualifiesForNextSkill: true })],
      NOW,
    );
    expect(unlocked.chain[1].status).toBe("next");
  });

  it("reports the EFFECTIVE state: a mastered skill now due needs review", () => {
    const progress = entryProgress(
      word,
      [
        started(chainKeys[0], {
          fsrs: cardDueAt(NOW - DAY),
          learnerState: "mastered",
        }),
      ],
      NOW,
    );
    expect(progress.chain[0].state).toBe("needs_review");
  });

  it("lists skills started outside the chain under also practised — only started ones", () => {
    const progress = entryProgress(word, [started(verbTypeKey)], NOW);
    expect(progress.alsoPractised.map((s) => s.component.key)).toEqual([
      verbTypeKey,
    ]);
    expect(progress.alsoPractised[0].state).toBe("learning");
    // An extended skill alone never starts the word (essential skills only).
    expect(progress.wordState).toBe("not_started");
    // A chain skill is never listed twice.
    const both = entryProgress(
      word,
      [started(chainKeys[0]), started(verbTypeKey)],
      NOW,
    );
    expect(both.alsoPractised.map((s) => s.component.key)).toEqual([
      verbTypeKey,
    ]);
  });

  it("the word state is the dashboard's rule, for every mix of skill states", () => {
    const states: StoredComponentState[][] = [
      [],
      [started(chainKeys[0])],
      chainKeys.map((key) =>
        started(key, { learnerState: "mastered", fsrs: cardDueAt(NOW + DAY) }),
      ),
      chainKeys.map((key, index) =>
        started(key, {
          learnerState: "mastered",
          fsrs: cardDueAt(index === 0 ? NOW - DAY : NOW + DAY),
        }),
      ),
    ];
    const expected = ["not_started", "learning", "mastered", "learning"];
    states.forEach((stored, index) => {
      const summary = computeProgressSummary(
        effectiveComponents(deriveComponentsForEntry(word), stored, NOW),
        1,
      );
      const dashboard =
        summary.wordStates.wordsMastered === 1
          ? "mastered"
          : summary.wordStates.wordsLearning === 1
            ? "learning"
            : "not_started";
      expect(entryProgress(word, stored, NOW).wordState).toBe(dashboard);
      expect(dashboard).toBe(expected[index]);
    });
  });

  it("its next-up skill is exactly what Start studying offers for the word", () => {
    const cases: StoredComponentState[][] = [
      [],
      [started(chainKeys[0], { qualifiesForNextSkill: true })],
      [
        started(chainKeys[0], { qualifiesForNextSkill: true }),
        started(chainKeys[1], { qualifiesForNextSkill: true }),
        started(chainKeys[3], { qualifiesForNextSkill: true }),
      ],
      [started(chainKeys[0])],
    ];
    for (const stored of cases) {
      const next = entryProgress(word, stored, NOW)
        .chain.filter((skill) => skill.status === "next")
        .map((skill) => skill.component.key);
      const offered = buildMixedPlan([word], stored, new Map(), NOW, {
        newLimit: 10,
        reviewLimit: 0,
      }).map((item) => buildComponentKey(item.identity));
      expect(offered).toEqual(next);
    }
  });

  it("an entry Start studying never teaches has no chain", () => {
    const noRecognition = {
      ...word,
      quiz_eligibility: {
        ...word.quiz_eligibility,
        madi: false,
        mudari: false,
        masdar: false,
      },
    };
    expect(entryProgress(noRecognition, [], NOW).chain).toEqual([]);
  });
});
