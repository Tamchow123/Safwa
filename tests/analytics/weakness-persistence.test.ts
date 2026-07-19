/**
 * Weakness persistence adapter (Phase 13 §7, §30): one consistent snapshot
 * read shared with the dashboard/progress load path, end-to-end evidence ->
 * score -> group assembly, and empty/untouched behaviour.
 */
import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SafwaDb } from "@/modules/content/db";
import type { LearnerEntry } from "@/modules/content/schema";
import { loadWeaknessView } from "@/modules/analytics/weakness-persistence";
import { deriveAllComponents } from "@/modules/study-engine/components";

let dbCounter = 0;
let db: SafwaDb;

beforeEach(() => {
  dbCounter += 1;
  db = new SafwaDb(`safwa-weakness-persistence-test-${dbCounter}`);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete();
});

const NOW = 1_784_000_000_000;
const KEY = "entry:1:skill:bab_identification";

function babEntry(overrides: Partial<LearnerEntry> = {}): LearnerEntry {
  return {
    id: 1,
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

async function seedIncorrectBabAttempt(): Promise<void> {
  await db.studyComponents.put({
    componentKey: KEY,
    entryId: 1,
    learnerState: "learning",
  });
  // Two incorrect first attempts: the group-level minimum-evidence rule
  // (Phase 13 §13) requires >=2 valid first attempts, a genuine lapse, or a
  // single component exceeding the stronger single-component threshold —
  // one attempt alone would not surface in the ranked groups below.
  for (const id of ["attempt-1", "attempt-2"]) {
    await db.studyAttempts.put({
      id,
      componentKey: KEY,
      sessionId: "session-1",
      attemptedAt: NOW,
      attempt: {
        localDateAtEvent: "2026-07-17",
        responseTimeMs: 1500,
        occurredAtUtc: "2026-07-17T12:00:00.000Z",
        entryId: 1,
        skillTypeId: "bab_identification",
        direction: null,
        sourceField: null,
        promptField: "madi",
        isFirstAttempt: true,
        isReinforcement: false,
        isCorrect: false,
      } as never,
    });
  }
}

describe("loadWeaknessView", () => {
  it("assembles evidence, scores and ranked groups from one snapshot read", async () => {
    await seedIncorrectBabAttempt();
    const view = await loadWeaknessView(
      db,
      deriveAllComponents([babEntry()]),
      [babEntry()],
      NOW,
    );

    expect(view.weaknessEvidence.has(KEY)).toBe(true);
    const cw = view.componentWeakness.get(KEY);
    expect(cw?.qualifiesAsWeak).toBe(true);
    expect(cw?.incorrectFirstAttemptCount).toBe(2);

    expect(view.groups.bab.some((g) => g.value === "nasara")).toBe(true);
    expect(
      view.groups.skill.some((g) => g.value === "bab_identification"),
    ).toBe(true);
    expect(view.topOverall.length).toBeGreaterThan(0);
  });

  it("returns empty groups for a guest with no study history", async () => {
    const view = await loadWeaknessView(
      db,
      deriveAllComponents([babEntry()]),
      [babEntry()],
      NOW,
    );
    expect(view.componentWeakness.size).toBe(0);
    for (const dimension of Object.keys(view.groups)) {
      expect(view.groups[dimension as keyof typeof view.groups]).toEqual([]);
    }
    expect(view.topOverall).toEqual([]);
  });

  it("shares the SAME single-read snapshot as the dashboard path (no extra transaction)", async () => {
    await seedIncorrectBabAttempt();
    const transactionSpy = vi.spyOn(db, "transaction");
    await loadWeaknessView(
      db,
      deriveAllComponents([babEntry()]),
      [babEntry()],
      NOW,
    );
    // readAnalyticsSnapshot itself opens exactly one "r" (raw stores) and
    // one "rw" (cache rewrite) transaction; loadWeaknessView must add none.
    expect(transactionSpy).toHaveBeenCalledTimes(2);
    expect(transactionSpy.mock.calls[0][0]).toBe("r");
    expect(transactionSpy.mock.calls[1][0]).toBe("rw");
  });

  it("all six dimension keys are always present, even when empty", async () => {
    const view = await loadWeaknessView(
      db,
      deriveAllComponents([babEntry()]),
      [babEntry()],
      NOW,
    );
    expect(Object.keys(view.groups).sort()).toEqual(
      ["bab", "direction", "skill", "source_form", "state", "verb_type"].sort(),
    );
  });
});
