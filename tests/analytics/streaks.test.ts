/**
 * Pure streak calculations (Phase 12 §9): study-day derivation, the
 * today/yesterday grace rule, longest streaks, and calendar-boundary + DST +
 * timezone-change safety. All fixtures use injected date labels — streak
 * arithmetic never touches a clock.
 */
import { describe, expect, it } from "vitest";

import type { DailyActivity } from "@/modules/analytics/activity";
import {
  computeStreaks,
  currentStreak,
  longestStreak,
  studyDayDates,
} from "@/modules/analytics/streaks";

function day(localDate: string, attempts = 1): DailyActivity {
  return { localDate, attempts, reviews: 0, newItems: 0, studyMs: 1000 };
}

describe("studyDayDates (§9.1)", () => {
  it("a study day is any stored date with ≥1 valid attempt — incorrect-only days count", () => {
    // The derivation upstream counts incorrect and hinted attempts; at this
    // layer only attempts > 0 matters.
    expect(studyDayDates([day("2026-07-17", 3), day("2026-07-15", 1)])).toEqual(
      ["2026-07-15", "2026-07-17"],
    );
  });

  it("event-only dates (reviews without surviving attempts) are not study days", () => {
    const eventOnly: DailyActivity = {
      localDate: "2026-07-16",
      attempts: 0,
      reviews: 2,
      newItems: 0,
      studyMs: 0,
    };
    expect(studyDayDates([eventOnly])).toEqual([]);
  });

  it("duplicate and corrupt rows collapse safely", () => {
    expect(
      studyDayDates([day("2026-07-17"), day("2026-07-17"), day("garbage")]),
    ).toEqual(["2026-07-17"]);
  });
});

describe("currentStreak (§9.2 — today/yesterday grace)", () => {
  it("activity today counts back from today", () => {
    expect(
      currentStreak(["2026-07-15", "2026-07-16", "2026-07-17"], "2026-07-17"),
    ).toBe(3);
  });

  it("no activity today but yesterday retains the streak through today", () => {
    expect(currentStreak(["2026-07-15", "2026-07-16"], "2026-07-17")).toBe(2);
  });

  it("no activity today or yesterday → zero", () => {
    expect(currentStreak(["2026-07-15"], "2026-07-17")).toBe(0);
    expect(currentStreak([], "2026-07-17")).toBe(0);
  });

  it("gaps break the streak", () => {
    expect(
      currentStreak(
        ["2026-07-13", "2026-07-15", "2026-07-16", "2026-07-17"],
        "2026-07-17",
      ),
    ).toBe(3);
  });

  it("duplicate dates count as one study day", () => {
    expect(
      currentStreak(["2026-07-17", "2026-07-17", "2026-07-16"], "2026-07-17"),
    ).toBe(2);
  });

  it("survives month, year and leap boundaries", () => {
    expect(currentStreak(["2026-07-31", "2026-08-01"], "2026-08-01")).toBe(2);
    expect(currentStreak(["2026-12-31", "2027-01-01"], "2027-01-01")).toBe(2);
    expect(
      currentStreak(["2024-02-28", "2024-02-29", "2024-03-01"], "2024-03-01"),
    ).toBe(3);
  });

  it("DST transitions cannot break a date-label streak", () => {
    // 2026-03-08 (23h day, US spring forward) and 2026-11-01 (25h day):
    // succession is label-based, so both runs are unbroken.
    expect(
      currentStreak(["2026-03-07", "2026-03-08", "2026-03-09"], "2026-03-09"),
    ).toBe(3);
    expect(
      currentStreak(["2026-10-31", "2026-11-01", "2026-11-02"], "2026-11-02"),
    ).toBe(3);
  });

  it("a timezone change between events keeps stored dates authoritative", () => {
    // Two attempts stored under different zones/offsets produced consecutive
    // stored LABELS; the streak follows the labels, and the changed zone only
    // moves the current-day anchor.
    const storedDates = ["2026-07-16", "2026-07-17"]; // e.g. London then Tokyo
    expect(currentStreak(storedDates, "2026-07-18")).toBe(2); // Tokyo's today
    expect(currentStreak(storedDates, "2026-07-17")).toBe(2);
  });

  it("an invalid anchor fails safe to zero", () => {
    expect(currentStreak(["2026-07-17"], "garbage")).toBe(0);
  });
});

describe("longestStreak (§9.3)", () => {
  it("finds the longest run anywhere in history", () => {
    expect(
      longestStreak([
        "2026-07-01",
        "2026-07-02",
        "2026-07-10",
        "2026-07-11",
        "2026-07-12",
        "2026-07-17",
      ]),
    ).toBe(3);
  });

  it("handles empty, single and duplicate inputs", () => {
    expect(longestStreak([])).toBe(0);
    expect(longestStreak(["2026-07-17"])).toBe(1);
    expect(longestStreak(["2026-07-17", "2026-07-17"])).toBe(1);
  });

  it("input order never changes the result", () => {
    const shuffled = ["2026-07-12", "2026-07-10", "2026-07-11"];
    expect(longestStreak(shuffled)).toBe(3);
  });

  it("spans year boundaries", () => {
    expect(
      longestStreak(["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]),
    ).toBe(4);
  });
});

describe("computeStreaks", () => {
  it("derives both streaks from daily activity with the anchor applied", () => {
    const activity = [
      day("2026-07-10"),
      day("2026-07-11"),
      day("2026-07-12"),
      day("2026-07-16"),
      day("2026-07-17"),
    ];
    expect(computeStreaks(activity, "2026-07-17")).toEqual({
      current: 2,
      longest: 3,
    });
    // The next day without study retains the current streak (grace)…
    expect(computeStreaks(activity, "2026-07-18").current).toBe(2);
    // …and one more gap day drops it to zero, while longest is unaffected.
    expect(computeStreaks(activity, "2026-07-19")).toEqual({
      current: 0,
      longest: 3,
    });
  });
});
